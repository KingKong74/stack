// Branch naming — the client's half of the convention (#363).
//
// The canonical version of this parser is `scripts/lib/lane.mjs` on the host,
// which is what NAMES the branches; this is its reader. Keep the two in step —
// lane.mjs carries the reasoning, and `scripts/lane.test.mjs` pins it.
//
// Two spellings exist and both must keep working forever. The current one is
// `<kind>/<id>-<slug>` (feat/271-mission-control, fix/bug-12-terminal-hangs,
// test/audit-2026-08-02). The old one was flat — `auto/item-271-…` — and those
// branches are still on origin and still named in `claimed_by`, so a reader
// that only understood the new form would report a working fleet as empty.

export const LANE_KINDS = ['feat', 'fix', 'ui', 'refactor', 'perf', 'test', 'docs', 'chore'] as const;
export type LaneKind = (typeof LANE_KINDS)[number];

// What each prefix claims about the change, for the filter chip's tooltip.
export const KIND_HINT: Record<LaneKind, string> = {
  feat: 'new capability',
  fix: 'defect repair',
  ui: 'look, layout and interaction',
  refactor: 'no behaviour change',
  perf: 'throughput / latency',
  test: 'tests and the regression net',
  docs: 'documentation only',
  chore: 'tooling, deps, cleanup',
};

// The tone each kind draws in. Semantic tokens only — never a literal hex
// (styles.css owns the palette), and every one of these is a named Atlas tone.
export const KIND_TONE: Record<LaneKind, string> = {
  feat: 'var(--live)',
  fix: 'var(--critical)',
  ui: 'var(--accent)',
  refactor: 'var(--building)',
  perf: 'var(--sage)',
  test: 'var(--building)',
  docs: 'var(--muted)',
  chore: 'var(--muted)',
};

const isKind = (v: string): v is LaneKind => (LANE_KINDS as readonly string[]).includes(v);

export interface ParsedBranch {
  /** One of LANE_KINDS, or '' when the NAME says nothing — which is not the
   *  same as 'feat'. A legacy `auto/item-N` lane genuinely does not record what
   *  sort of change it carries, and the ledger shows it unlabelled rather than
   *  guessing a label the branch never claimed. */
  kind: LaneKind | '';
  itemId: number | null;
  bugKey: string;
  summary: string;
  legacy: boolean;
}

const KIND_ALT = LANE_KINDS.join('|');
const RE_BUG = new RegExp(`^(${KIND_ALT})/(bug-\\d+)(?:-(.*))?$`, 'i');
const RE_ITEM = new RegExp(`^(${KIND_ALT})/(\\d+)(?:-(.*))?$`, 'i');
const RE_ANY = new RegExp(`^(${KIND_ALT})/(.+)$`, 'i');
const RE_LEGACY_ITEM = /^(?:auto|lane)\/item-(\d+)(?:-(.*))?$/i;
const RE_LEGACY_BUG = /^(?:auto|lane)\/(bug-\d+)(?:-(.*))?$/i;
const RE_LEGACY_AUDIT = /^(?:auto|lane)\/audit-(.*)$/i;

export function parseBranch(name: string): ParsedBranch {
  const s = (name || '').trim();
  const none: ParsedBranch = { kind: '', itemId: null, bugKey: '', summary: '', legacy: false };
  if (!s) return none;

  let m = RE_BUG.exec(s);
  if (m && isKind(m[1].toLowerCase())) {
    return { kind: m[1].toLowerCase() as LaneKind, itemId: null, bugKey: m[2].toUpperCase(), summary: m[3] || '', legacy: false };
  }
  m = RE_ITEM.exec(s);
  if (m && isKind(m[1].toLowerCase())) {
    return { kind: m[1].toLowerCase() as LaneKind, itemId: Number(m[2]), bugKey: '', summary: m[3] || '', legacy: false };
  }
  m = RE_LEGACY_BUG.exec(s);
  if (m) return { kind: 'fix', itemId: null, bugKey: m[1].toUpperCase(), summary: m[2] || '', legacy: true };
  m = RE_LEGACY_AUDIT.exec(s);
  if (m) return { kind: 'test', itemId: null, bugKey: '', summary: `audit-${m[1]}`, legacy: true };
  m = RE_LEGACY_ITEM.exec(s);
  if (m) return { kind: '', itemId: Number(m[1]), bugKey: '', summary: m[2] || '', legacy: true };
  m = RE_ANY.exec(s);
  if (m && isKind(m[1].toLowerCase())) {
    return { kind: m[1].toLowerCase() as LaneKind, itemId: null, bugKey: '', summary: m[2], legacy: false };
  }
  return { ...none, summary: s };
}

// ---------------------------------------------------------------------------
// Merge state — the one derivation the Merge room sorts, filters and plans on.
//
// It reads the HOST's probe, and nothing else. That matters at both ends:
//   • `conflict` is a fact (git merge-tree said so), not a guess from the
//     file lists overlapping.
//   • `unprobed` is NOT clean. mergeClean null means no probe ran — the report
//     pre-dates the branch, git is older than 2.38, or there is no report at
//     all and this chip came from a claim. Same rule as a NULL review verdict:
//     nothing ran is not the same as nothing found, so it gets its own state
//     rather than being folded in with the branches we know about.
//
// `behind` is a sub-state of mergeable, not a blocker: the probe already says
// the merge succeeds. What being behind means is that nothing has ever built
// this branch against the main it would land on, which is worth showing and is
// not worth refusing.
export type MergeState = 'clean' | 'behind' | 'conflict' | 'unprobed';

export const MERGE_STATE_META: Record<MergeState, { label: string; tone: string; hint: string }> = {
  clean: { label: 'clean', tone: 'var(--live)', hint: 'Merges into main, and level with it — the probe tested exactly what would land.' },
  behind: { label: 'behind', tone: 'var(--building)', hint: 'Merges into main, but main has moved since: nothing has built this branch against the trunk it would land on.' },
  conflict: { label: 'conflict', tone: 'var(--accent)', hint: 'The host’s merge-tree probe says this conflicts with main. Rebase it, or let the merge job attempt an AI-assisted resolution.' },
  unprobed: { label: 'unprobed', tone: 'var(--paused)', hint: 'No conflict probe has run on this branch — the report pre-dates it, git is older than 2.38, or this chip is a claim with no git report behind it. Unprobed is not clean.' },
};

export const MERGE_STATES = ['clean', 'behind', 'conflict', 'unprobed'] as const;

export function mergeStateOf(b: { mergeClean?: boolean | null; behind?: number }): MergeState {
  if (b.mergeClean === false) return 'conflict';
  if (b.mergeClean !== true) return 'unprobed';
  return (b.behind ?? 0) > 0 ? 'behind' : 'clean';
}

// Mergeable = the probe says the merge succeeds. Only these enter the agent's
// plan; a conflict needs resolving and an unprobed branch has never been asked.
export const isMergeable = (s: MergeState) => s === 'clean' || s === 'behind';
