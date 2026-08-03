// Autopilot lane naming helpers — shared by stack-autopilot.mjs,
// stack-autopilot-dispatch.mjs and lane.test.mjs.
//
// #363 — the naming convention. Every lane the runner cuts is now
// `<kind>/<id>-<slug>` (feat/271-mission-control, fix/bug-12-terminal-hangs,
// test/audit-2026-08-02) rather than the old flat `auto/item-N-<slug>`. The
// kind is not decoration: the Merge room filters and groups on it, and the
// merge agent reads it when it orders a wave, so "what sort of change is this"
// is answerable from the branch name alone — before anything reads the diff.
//
// The OLD names still exist on origin and in `claimed_by`, and they must keep
// working: a claim is a live string on a roadmap row, so renaming the scheme
// cannot mean orphaning every branch cut before it. `parseBranch` reads both
// and `web/src/lib/branch.ts` is its twin on the client — keep the two in step.

// The kinds a lane may carry. Order is the display order (the Merge room's
// filter chips and the ledger's kind column both take it from here).
export const LANE_KINDS = ['feat', 'fix', 'ui', 'refactor', 'perf', 'test', 'docs', 'chore'];

// Converts an item title to a git-safe slug: lowercase, alphanumeric runs
// joined by hyphens, trailing hyphens trimmed after truncation.
export function branchSlug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
}

// What KIND of change an item is, read off its own words. A heuristic, and
// deliberately a modest one: it picks the branch prefix, which is a label on
// work a human is about to review, not a gate on anything. Everything that
// doesn't announce itself as something else is a feature — that is the honest
// default for a roadmap item, which is a want.
//
// Order is precedence, not preference: "fix the spacing" is a fix that happens
// to touch the UI, so `fix` is tested before `ui`.
const KIND_RULES = [
  ['fix', /\b(fix(es|ed|ing)?|bug|broken|crash(es|ing)?|regression|incorrect|wrong|fail(s|ing|ure)?|error|defect)\b/],
  ['perf', /\b(perf|performance|speed|faster|latency|slow(er)?|throughput|optimis\w*|optimiz\w*|memoi\w*)\b/],
  ['refactor', /\b(refactor\w*|rename|restructure|tidy|simplif\w*|extract|consolidat\w*|dedupe|de-?duplicat\w*|clean ?-?up)\b/],
  ['test', /\b(tests?|testing|coverage|harness|smoke|assertions?)\b/],
  ['docs', /\b(docs?|documentation|readme|changelog|comments?)\b/],
  ['chore', /\b(chore|deps|dependenc\w+|bump|upgrade|tooling|scaffold\w*|ci|lint\w*|migrat\w+)\b/],
  ['ui', /\b(ui|ux|layout|styling|styles?|theme|css|visual|responsive|colou?rs?|icons?|spacing|typography|animation)\b/],
];

export function branchKind(item) {
  const text = `${item?.title || ''} ${item?.area || ''}`.toLowerCase();
  for (const [kind, re] of KIND_RULES) if (re.test(text)) return kind;
  return 'feat';
}

// Returns the branch name for a roadmap item.
// Format: <kind>/<id>-<slug>  (falls back to <kind>/<id> for all-special titles)
export function laneFor(item) {
  const slug = branchSlug(item.title);
  const kind = branchKind(item);
  return slug ? `${kind}/${item.id}-${slug}` : `${kind}/${item.id}`;
}

// Returns the branch name for a bug the DEBUG night is about to work.
// Format: fix/bug-<n>-<slug>. The `bug-` infix is what keeps BUG-12's lane
// distinct from roadmap item 12's — both are `fix/…12…` otherwise.
export function bugLaneFor(bug) {
  const slug = branchSlug(bug?.title);
  const key = String(bug?.id || 'bug').toLowerCase();
  return slug ? `fix/${key}-${slug}` : `fix/${key}`;
}

// Returns the branch name for an AUDIT night. Hardening commits are tests, so
// the audit lane is a test lane.
export const auditLaneFor = (day) => `test/audit-${day}`;

const KIND_ALT = LANE_KINDS.join('|');
const RE_CONVENTIONAL_BUG = new RegExp(`^(${KIND_ALT})/(bug-\\d+)(?:-(.*))?$`, 'i');
const RE_CONVENTIONAL = new RegExp(`^(${KIND_ALT})/(\\d+)(?:-(.*))?$`, 'i');
const RE_LEGACY_ITEM = /^(?:auto|lane)\/item-(\d+)(?:-(.*))?$/i;
const RE_LEGACY_BUG = /^(?:auto|lane)\/(bug-\d+)(?:-(.*))?$/i;
const RE_LEGACY_AUDIT = /^(?:auto|lane)\/audit-(.*)$/i;

// Reads a branch name into { kind, itemId, bugKey, summary, legacy }.
//
//   kind    one of LANE_KINDS, or '' when the name says nothing about it. ''
//           is NOT 'feat': a legacy `auto/item-N` lane genuinely does not
//           record what sort of change it carries, and the Merge room shows it
//           as unlabelled rather than inventing a label for it.
//   itemId  the roadmap item number as a number, or null.
//   bugKey  'BUG-12' for a debug lane, or ''.
//   legacy  true for the pre-#363 `auto/`+`lane/` spellings.
export function parseBranch(name) {
  const s = String(name || '').trim();
  const none = { kind: '', itemId: null, bugKey: '', summary: '', legacy: false };
  if (!s) return none;

  let m = RE_CONVENTIONAL_BUG.exec(s);
  if (m) return { kind: m[1].toLowerCase(), itemId: null, bugKey: m[2].toUpperCase(), summary: m[3] || '', legacy: false };
  m = RE_CONVENTIONAL.exec(s);
  if (m) return { kind: m[1].toLowerCase(), itemId: Number(m[2]), bugKey: '', summary: m[3] || '', legacy: false };
  m = RE_LEGACY_BUG.exec(s);
  if (m) return { kind: 'fix', itemId: null, bugKey: m[1].toUpperCase(), summary: m[2] || '', legacy: true };
  m = RE_LEGACY_AUDIT.exec(s);
  if (m) return { kind: 'test', itemId: null, bugKey: '', summary: `audit-${m[1]}`, legacy: true };
  m = RE_LEGACY_ITEM.exec(s);
  if (m) return { kind: '', itemId: Number(m[1]), bugKey: '', summary: m[2] || '', legacy: true };
  // A conventional prefix with no id at all (`ui/merge-room`) still tells us
  // the kind, which is the half the ledger can use.
  m = new RegExp(`^(${KIND_ALT})/(.+)$`, 'i').exec(s);
  if (m) return { kind: m[1].toLowerCase(), itemId: null, bugKey: '', summary: m[2], legacy: false };
  return none;
}

// True for any name the runner or a conventional workflow would have cut —
// what `stack tree` groups as a lane and what the Merge room lists.
export const isLaneBranch = (name) => {
  const p = parseBranch(name);
  return !!(p.kind || p.itemId || p.bugKey);
};

// Resolves a collision on a proposed branch name WITHOUT ever deleting an
// existing branch to make room (#235). `isTaken` is a pure predicate the
// caller supplies (the runner backs it with a check against git refs); this
// function makes no git calls and does no I/O.
//
// Every run kind used to open by force-deleting whatever branch already held
// its name. That is exactly wrong when the branch holds an EARLIER run's
// pushed, unmerged work: the second run starts again from HEAD, and its
// closing `git push -u origin <branch>` then either fails as a non-fast-forward
// or, worse, takes the name from work nobody has reviewed yet. A run must
// never destroy another run's branch just because they picked the same name.
//
// Instead: try `name`, then `name-2`, `name-3`, … up to `name-<max>`, and
// throw rather than silently colliding or looping forever. The suffix is
// deliberately appended AFTER the summary, where every id parser in
// `parseBranch` already stops reading — `feat/271-mission-control-2` still
// parses as item 271, so a collision stays invisible to the Merge room, the
// branch report and `claimed_by`.
export function freeBranchName(name, isTaken, max = 20) {
  if (!isTaken(name)) return name;
  for (let n = 2; n <= max; n++) {
    const candidate = `${name}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`freeBranchName: no free name for "${name}" after ${max} suffixes`);
}
