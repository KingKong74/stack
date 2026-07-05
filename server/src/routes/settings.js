import { Router } from 'express';
import { q } from '../db.js';
import { oneOf } from '../util.js';
import { readSettings, settingsShape, CHECKPOINT_DETAILS, cleanSessionDefaults } from '../settings.js';

// GET/PATCH /api/settings — the single-row app settings behind bearer auth.
//
// Shape (client camelCase):
//   { autoRecord, keepResumeCard, checkpointDetail, includeChores, sessionDefaults }
export const settings = Router();

settings.get('/', async (_req, res) => {
  res.json(settingsShape(await readSettings()));
});

const BOOL_FIELDS = {
  autoRecord: 'auto_record',
  keepResumeCard: 'keep_resume_card',
  includeChores: 'include_chores',
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
  if (fields.length) {
    await q(`UPDATE settings SET ${fields.join(', ')}, updated_at = now() WHERE id = true`, values);
  }
  res.json(settingsShape(await readSettings()));
});
