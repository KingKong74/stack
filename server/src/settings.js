// Single-row app settings — shared read helper + client shape. The HTTP layer
// lives in routes/settings.js; ingest and overview import readSettings() so the
// no-API model's switches take effect server-side.

import { q } from './db.js';
import { oneOf } from './util.js';

export const CHECKPOINT_DETAILS = ['brief', 'standard', 'detailed'];

// The session-defaults catalogue: standing preferences toggled in Settings and
// injected by the SessionStart hook into every session on every project, so a
// permission is granted once instead of re-stated per chat. Keys must match the
// web catalogue (web/src/lib/brief.ts DIRECTIVES); the lines are what agents read.
export const SESSION_DEFAULTS = [
  { key: 'lean', line: 'Keep token usage lean: concise output, no re-reading unchanged files, no exploratory tangents.' },
  { key: 'ship', line: 'Commits are pre-authorised: commit and push after every completed unit of work — no need to ask.' },
  { key: 'checkpoint', line: 'Run /checkpoint before wrapping up the session.' },
  { key: 'confirm', line: 'Check in before changing API contracts or the schema, or deleting anything.' },
  { key: 'verify', line: 'Run the build/typecheck and verify before declaring work done.' },
];
const SESSION_DEFAULT_KEYS = new Set(SESSION_DEFAULTS.map((d) => d.key));

// Coerce any incoming value to a deduped list of known catalogue keys.
export const cleanSessionDefaults = (v) =>
  Array.isArray(v) ? [...new Set(v.map(String).filter((k) => SESSION_DEFAULT_KEYS.has(k)))] : [];

// The lines the SessionStart hook injects, in catalogue order.
export const sessionDefaultLines = (keys) =>
  SESSION_DEFAULTS.filter((d) => (keys || []).includes(d.key)).map((d) => d.line);

// ✧ Fill from note (#131): the fields the assist may fill. Title is the point
// of the feature and always allowed; the rest can be switched off in Settings.
export const ASSIST_FIELDS = ['title', 'note', 'area', 'lane', 'priority'];
export const cleanAssistFields = (v) => {
  const keys = Array.isArray(v) ? v.map(String).filter((k) => ASSIST_FIELDS.includes(k)) : [];
  return [...new Set(['title', ...keys])];
};

// Dual-model autopilot (#153): claude CLI model aliases the settings accept.
// The executor is the (cheaper) model that runs the session; the advisor is
// the stronger model it consults as a subagent. '' = CLI default / no advisor.
//
// These arrays are also the server-side catalogue (#175) — the SINGLE source of
// truth served via the /api/control payload so the UI pickers never need
// updating separately. Each entry: { model: alias, label: display string }.
export const AUTOPILOT_EXECUTOR_MODELS = ['', 'haiku', 'sonnet', 'opus'];
export const AUTOPILOT_ADVISOR_MODELS = ['', 'sonnet', 'opus', 'fable'];

// The UI catalogue served to Mission Control (#175). Mirrors the alias arrays
// above but carries human-readable labels for the pickers.
export const EXECUTOR_CATALOGUE = [
  { model: '', label: 'Default' },
  { model: 'haiku', label: 'Haiku' },
  { model: 'sonnet', label: 'Sonnet' },
  { model: 'opus', label: 'Opus' },
];
export const ADVISOR_CATALOGUE = [
  { model: '', label: 'Off' },
  { model: 'sonnet', label: 'Sonnet' },
  { model: 'opus', label: 'Opus' },
  { model: 'fable', label: 'Fable' },
];

const DEFAULTS = {
  auto_record: true,
  keep_resume_card: true,
  checkpoint_detail: 'standard',
  include_chores: false,
  session_defaults: ['ship'],
  autopilot_enabled: false, // the arm switch fails SAFE (off), unlike the record switches
  autopilot_minutes: 120,
  autopilot_tokens: 1_500_000, // per-run token budget; 0 = unlimited
  autopilot_time: '23:05',     // nightly start, host-local HH:MM
  autopilot_max_items: 3,
  autopilot_executor_model: '', // '' = the claude CLI's own default model
  autopilot_advisor_model: '',  // '' = no advisor subagent
  assist_guidance: '',
  assist_fields: [...ASSIST_FIELDS],
  access_pin_hash: null,
};

export const cleanAutopilotTime = (v) =>
  /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '23:05';

// Read the singleton row. Accepts an optional pg client (so ingest can read
// inside its transaction). Falls back to the defaults if the row is missing.
export async function readSettings(client) {
  const run = client ? (text, params) => client.query(text, params) : q;
  const { rows } = await run('SELECT * FROM settings WHERE id = true');
  if (!rows.length) return { ...DEFAULTS };
  const r = rows[0];
  return {
    auto_record: r.auto_record,
    keep_resume_card: r.keep_resume_card,
    checkpoint_detail: oneOf(r.checkpoint_detail, CHECKPOINT_DETAILS, 'standard'),
    include_chores: r.include_chores,
    session_defaults: cleanSessionDefaults(r.session_defaults),
    autopilot_enabled: Boolean(r.autopilot_enabled),
    autopilot_minutes: Number.isFinite(r.autopilot_minutes) ? r.autopilot_minutes : 120,
    autopilot_tokens: Number.isFinite(Number(r.autopilot_tokens)) ? Number(r.autopilot_tokens) : 1_500_000,
    autopilot_time: cleanAutopilotTime(r.autopilot_time),
    autopilot_max_items: Number.isFinite(r.autopilot_max_items) ? r.autopilot_max_items : 3,
    autopilot_executor_model: oneOf(r.autopilot_executor_model, AUTOPILOT_EXECUTOR_MODELS, ''),
    autopilot_advisor_model: oneOf(r.autopilot_advisor_model, AUTOPILOT_ADVISOR_MODELS, ''),
    assist_guidance: String(r.assist_guidance || ''),
    assist_fields: cleanAssistFields(r.assist_fields),
    access_pin_hash: r.access_pin_hash || null,
  };
}

export function settingsShape(s) {
  return {
    autoRecord: s.auto_record,
    keepResumeCard: s.keep_resume_card,
    checkpointDetail: s.checkpoint_detail,
    includeChores: s.include_chores,
    sessionDefaults: s.session_defaults,
    autopilotEnabled: s.autopilot_enabled,
    autopilotMinutes: s.autopilot_minutes,
    autopilotTokens: s.autopilot_tokens,     // 0 = unlimited
    autopilotTime: s.autopilot_time,         // host-local HH:MM
    autopilotMaxItems: s.autopilot_max_items,
    autopilotExecutorModel: s.autopilot_executor_model, // '' = CLI default (#153)
    autopilotAdvisorModel: s.autopilot_advisor_model,   // '' = no advisor
    assistGuidance: s.assist_guidance,       // standing steer for ✧ Fill from note
    assistFields: s.assist_fields,           // which fields the assist may fill
    accessPinSet: Boolean(s.access_pin_hash), // the hash itself never leaves the server
  };
}
