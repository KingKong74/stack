import { Router } from 'express';
import { q } from '../db.js';
import { oneOf } from '../util.js';
import { hashPin } from '../auth.js';
import {
  readSettings, settingsShape, CHECKPOINT_DETAILS,
  cleanSessionDefaults, cleanAutopilotTime, cleanAssistFields,
  cleanModelAlias,
} from '../settings.js';

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
  // Dual-model autopilot (#153/#168): freeform alias (e.g. claude-sonnet-4-6,
  // us.anthropic.claude-opus-4, vendor/model) — cleanModelAlias strips
  // anything that isn't [a-z0-9.:/_-] so shell metacharacters never reach the
  // claude CLI; unknown or empty = '' (CLI default / no advisor).
  if ('autopilotExecutorModel' in body) {
    fields.push(`autopilot_executor_model = $${i++}`);
    values.push(cleanModelAlias(body.autopilotExecutorModel));
  }
  if ('autopilotAdvisorModel' in body) {
    fields.push(`autopilot_advisor_model = $${i++}`);
    values.push(cleanModelAlias(body.autopilotAdvisorModel));
  }
  if ('assistGuidance' in body) {
    fields.push(`assist_guidance = $${i++}`);
    values.push(String(body.assistGuidance || '').trim().slice(0, 500));
  }
  if ('assistFields' in body) {
    fields.push(`assist_fields = $${i++}::jsonb`);
    values.push(JSON.stringify(cleanAssistFields(body.assistFields)));
  }
  if ('accessPin' in body) {
    const pin = String(body.accessPin || '').trim();
    if (pin && (pin.length < 4 || pin.length > 64)) {
      return res.status(400).json({ error: 'The PIN must be 4–64 characters.' });
    }
    fields.push(`access_pin_hash = $${i++}`);
    values.push(pin ? hashPin(pin) : null);
  }
  // Google Calendar sync (#222): write-only credential fields — '' clears.
  for (const [camel, col] of [
    ['gcalClientId', 'gcal_client_id'],
    ['gcalClientSecret', 'gcal_client_secret'],
    ['gcalRefreshToken', 'gcal_refresh_token'],
    ['gcalCalendarId', 'gcal_calendar_id'],
  ]) {
    if (camel in body) {
      fields.push(`${col} = $${i++}`);
      values.push(String(body[camel] || '').trim().slice(0, 500));
    }
  }
  if (fields.length) {
    await q(`UPDATE settings SET ${fields.join(', ')}, updated_at = now() WHERE id = true`, values);
  }
  // A PIN change (set, rotate or clear) signs out every PIN-issued device.
  if ('accessPin' in body) await q('DELETE FROM auth_tokens');
  res.json(settingsShape(await readSettings()));
});

// GET /gcal — raw GCal credentials for the host-side sync script (bearer-
// protected, same trust level as the API_TOKEN). Returns 404 when unconfigured
// so the caller can bail early with a clear message.
settings.get('/gcal', async (_req, res) => {
  const s = await readSettings();
  if (!s.gcal_client_id || !s.gcal_client_secret || !s.gcal_refresh_token) {
    return res.status(404).json({ error: 'Google Calendar credentials not configured. PATCH /api/settings with gcalClientId, gcalClientSecret, gcalRefreshToken (and optionally gcalCalendarId).' });
  }
  res.json({
    clientId: s.gcal_client_id,
    clientSecret: s.gcal_client_secret,
    refreshToken: s.gcal_refresh_token,
    calendarId: s.gcal_calendar_id || 'primary',
    autopilotMinutes: s.autopilot_minutes,
  });
});
