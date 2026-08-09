// Shared server helpers: identity, fingerprints, relative time, palettes and
// the one documented progress model. Kept dependency-free so it is trivial to
// reason about and unit-test by eye.

// Cover tints, in dashboard order. Ingest cycles this palette so each new
// project gets a distinct cover without anyone choosing one.
export const TINTS = [
  '#e3d4c8', '#d3ddcf', '#cdd9e0', '#e6dcc4',
  '#e6d6d6', '#dcdac9', '#ddd2cd', '#d2d6dc',
];

// Sticky-note colours, mirrored on the client for parity.
export const NOTE_PALETTE = ['#fef4a8', '#e6f0d8', '#dce8f0', '#f3dfe1', '#f0e7d2'];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const BUG_STATUSES = ['open', 'investigating', 'fixing', 'fixed'];
export const BUCKETS = ['must', 'should', 'could', 'wont'];
export const PROJECT_STATUSES = ['live', 'building', 'paused', 'archived'];
// (#363) How much of a project's merging the Merge room's agent may do on one
// press: auto = its clean branches are queued by ▶ Run; plan = they are in the
// proposed plan but merge one press each; off = out of the plan. See the
// projects.merge_autonomy comment in schema.sql for what each does NOT change.
export const MERGE_AUTONOMY = ['auto', 'plan', 'off'];

// Short MoSCoW labels, used by the search route's meta field.
export const PRIORITY_SHORT = { must: 'Must', should: 'Should', could: 'Could', wont: "Won't" };

// #262 — who is allowed to write the risk tier. ABSENT source = the modal, i.e.
// a person, and a person's tier always wins. PRESENT but unrecognised takes the
// guarded 'auto' path: a machine typo must never be able to claim a row as
// human-decided, because nothing can unclaim it afterwards.
export const RISK_SOURCES = ['human', 'auto'];
export function riskWriteSource(incoming) {
  if (incoming === undefined || incoming === null) return 'human';
  return RISK_SOURCES.includes(incoming) ? incoming : 'auto';
}

// Days since last push after which a live/building project counts as "stale"
// on the command deck. Single knob — change it here and GET /api/overview
// follows. Paused/archived projects are dormant on purpose and never stale.
export const STALE_DAYS = 14;

// Minutes since a presence row's last_seen_at after which a session no longer
// counts as "live now" on the deck. Single knob. A SessionStart pings, an
// authored /checkpoint bumps, SessionEnd clears — this TTL only catches
// sessions that died without a clean end.
export const PRESENCE_TTL_MINUTES = 240;

// #279 — how many results each check keeps. The pruner runs right after every
// insert, so this is a hard per-check ceiling, not a target: 30 checks can only
// ever hold 30 × this many rows however long the nights run. Single knob —
// deep enough to read a fortnight of nightly runs plus a day of hand runs.
export const CHECK_HISTORY_KEEP = 60;

export function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'untitled'
  );
}

// Fingerprint = the title normalised: lowercased, punctuation and extra
// whitespace stripped. Two titles that only differ in case/punctuation share a
// fingerprint, which is how auto-extracted items dedupe and tombstone.
export function fingerprint(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const oneOf = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

// Coerce an array-of-strings field coming off the wire.
export function asList(v, max = 50, len = 400) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).slice(0, len)).filter(Boolean).slice(0, max);
}

// Coerce a roadmap item's implementation plan (#75): ordered steps, each
// { text, done }. Anything malformed is dropped rather than erroring.
export function cleanPlan(v, max = 30, len = 300) {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => ({ text: String(s?.text ?? '').trim().slice(0, len), done: Boolean(s?.done) }))
    .filter((s) => s.text)
    .slice(0, max);
}

// A capped free-text field, capped OUT LOUD (BUG-12). #239's rule — "a capped
// list inside a prompt must say it is capped" — is not really about lists: a
// reader that cannot see a cap treats what it got as the whole thing, and the
// tail is where an account of what landed keeps its caveats. built_note is
// written once, by the session that finishes the item, and read by the human on
// the Review room and by both second-model passes; a silent slice at 2000 took
// the last paragraph off 7 of the 212 notes on this host without one of those
// readers ever being told. The marker is stored with the text so every reader
// gets it without re-deriving anything, and it names the true length, which is
// what says how much is missing.
export const NOTE_MAX = 2000;
export function capNote(value, max = NOTE_MAX) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated — the note was ${text.length} characters and the first ${max} are kept]`;
}

// Coerce review-annotation tags (#146): short lowercase labels, deduped.
// Anything malformed is dropped rather than erroring.
export function cleanReviewTags(v, max = 8, len = 40) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    const tag = String(t ?? '').trim().toLowerCase().slice(0, len);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

// Human "2h ago" style time, computed server-side so the client never does
// date maths. Returns 'just now' for very recent and a date for anything old.
export function relativeTime(input) {
  if (!input) return null;
  const then = input instanceof Date ? input : new Date(input);
  const ms = Date.now() - then.getTime();
  if (!Number.isFinite(ms)) return null;
  const s = Math.floor(ms / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return then.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Progress model — the single, tweakable definition of "how done is a project".
//
//   • Only Must-have and Should-have roadmap items count toward progress.
//   • A done Must counts double a done Should (Must weight 2, Should weight 1).
//   • progress = doneWeight / totalWeight, as a 0–100 integer.
//   • While any critical or high bug is still open, progress is capped at 90%.
//   • With no Must/Should items at all, progress is 0.
//
// Tune the weights or the cap here and everywhere reflects it.
// ---------------------------------------------------------------------------
const WEIGHT = { must: 2, should: 1 };
const PROGRESS_CAP_WITH_OPEN_SERIOUS_BUG = 90;

export function computeProgress(roadmapItems, bugs) {
  let total = 0;
  let done = 0;
  for (const it of roadmapItems) {
    const w = WEIGHT[it.bucket];
    if (!w) continue; // could/wont don't move the bar
    total += w;
    if (it.done) done += w;
  }
  if (total === 0) return 0;

  let pct = Math.round((done / total) * 100);

  const seriousOpenBug = bugs.some(
    (b) => (b.severity === 'critical' || b.severity === 'high') && b.status !== 'fixed'
  );
  if (seriousOpenBug) pct = Math.min(pct, PROGRESS_CAP_WITH_OPEN_SERIOUS_BUG);

  return pct;
}

// The Overview spine's cadence strip: one bucket per day for the last `days`,
// oldest first, zero-filled. Pure — takes the rows of a GROUP BY of pushes.
//
// Zero-filled HERE rather than in the browser because the buckets are UTC days
// and the client's own idea of "today" is its local one: a device in Sydney
// building its own 28 slots would land every push in the wrong bucket for the
// first ten hours of each day. `today` is injected so this stays testable.
//
// A zero day and a day before the project existed look identical in the output
// and must NOT read the same in the UI — the strip's job is to make a quiet
// stretch visible, so the caller draws "no pushes yet" from the project's own
// age, never from a run of zeroes here.
export function pushCadence(rows, days = 28, today = new Date()) {
  const byDay = new Map(rows.map((r) => [String(r.d), Number(r.n) || 0]));
  const out = [];
  const cursor = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(cursor - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, n: byDay.get(day) || 0 });
  }
  return out;
}
