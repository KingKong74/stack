import { Router } from 'express';
import { q } from '../db.js';
import { oneOf } from '../util.js';
import { hashPin } from '../auth.js';
import { readSettings, settingsShape, CHECKPOINT_DETAILS, cleanSessionDefaults, cleanAutopilotTime } from '../settings.js';

// GET/PATCH /api/settings — the single-row app settings behind bearer auth.
//
// Shape (client camelCase):
//   { autoRecord, keepResumeCard, checkpointDetail, includeChores, sessionDefaults,
//     autopilotEnabled, autopilotMinutes, accessPinSet }
// PATCH additionally accepts write-only `accessPin` ('' disables PIN sign-in);
// any accessPin change also signs out every PIN-issued device.
export const settings = Router();

settings.get('/', async (_req, res) => {
  res.json(settingsShape(await readSettings()));
});

const BOOL_FIELDS = {
  autoRecord: 'auto_record',
  keepResumeCard: 'keep_resume_card',
  includeChores: 'include_chores',
  autopilotEnabled: 'autopilot_enabled',
};

settings.patch('/', async (req, res) => {
  const body = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(BOOL_FIELDS)) {
    if (key in body) { fields.push(`${col} = $${i++}`); values.push(Boolean(body[key])); }
  }
  if ('checkpointDetail' in body) {
    fields.push(`checkpoint_detail = $${i++}`);
    values.push(oneOf(body.checkpointDetail, CHECKPOINT_DETAILS, 'standard'));
  }
  if ('sessionDefaults' in body) {
    fields.push(`session_defaults = $${i++}::jsonb`);
    values.push(JSON.stringify(cleanSessionDefaults(body.sessionDefaults)));
  }
  if ('autopilotMinutes' in body) {
    const m = Math.trunc(Number(body.autopilotMinutes));
    fields.push(`autopilot_minutes = $${i++}`);
    values.push(Number.isFinite(m) ? Math.min(360, Math.max(15, m)) : 120);
  }
  if ('autopilotTokens' in body) {
    // 0 = unlimited; any positive budget gets a sane floor so a typo can't
    // starve the night before the first session finishes.
    const t = Math.trunc(Number(body.autopilotTokens));
    fields.push(`autopilot_tokens = $${i++}`);
    values.push(!Number.isFinite(t) || t < 0 ? 1_500_000 : (t === 0 ? 0 : Math.max(100_000, t)));
  }
  if ('autopilotTime' in body) {
    fields.push(`autopilot_time = $${i++}`);
    values.push(cleanAutopilotTime(body.autopilotTime));
  }
  if ('autopilotMaxItems' in body) {
    const n = Math.trunc(Number(body.autopilotMaxItems));
    fields.push(`autopilot_max_items = $${i++}`);
    values.push(Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3);
  }
  if ('accessPin' in body) {
    const pin = String(body.accessPin || '').trim();
    if (pin && (pin.length < 4 || pin.length > 64)) {
      return res.status(400).json({ error: 'The PIN must be 4–64 characters.' });
    }
    fields.push(`access_pin_hash = $${i++}`);
    values.push(pin ? hashPin(pin) : null);
  }
  if (fields.length) {
    await q(`UPDATE settings SET ${fields.join(', ')}, updated_at = now() WHERE id = true`, values);
  }
  // A PIN change (set, rotate or clear) signs out every PIN-issued device.
  if ('accessPin' in body) await q('DELETE FROM auth_tokens');
  res.json(settingsShape(await readSettings()));
});
