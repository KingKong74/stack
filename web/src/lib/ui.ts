import type { BugStatus, Severity, Priority } from '../types';

export const PRODUCT_NAME = 'Stack';

// A PROJECT'S NAME AS THE CHROME SAYS IT. A slug-derived name arrives lowercase
// ("stack"), and in the topbar's crumb that sits beside "Stack" and "Projects"
// as if it were a path segment rather than the name of the thing. Only the
// FIRST character is touched, so a name somebody actually typed keeps its own
// shape — `bkOS` and `KingKong` are not title-cased into something they aren't.
// Display only: never write this back, the stored name is the stored name.
export const crumbName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export const STATUS_LABEL: Record<BugStatus, string> = {
  open: 'Open', investigating: 'Investigating', fixing: 'Fixing', fixed: 'Fixed',
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
export const PRIORITY_ORDER: Priority[] = ['highest', 'high', 'medium', 'low', 'lowest'];

// THE ONE CLIENT DEFINITION OF A PRIORITY (#469). It was MoSCoW until the board
// was wired and the console kit's five levels replaced it, and the board had
// grown a second copy of this list to carry the kit's `glyph` — so the glyph
// moved here instead and the board imports it. Two lists of the same five
// things is how a card and a dock come to disagree about what Medium looks
// like.
//
// `color` is rendered as TEXT (and a border) on a dark card, so each one names
// the token whose FOREGROUND variant reads there — never a literal, and never a
// fill tone. The reds are the kit's own `--red-500` swapped for
// `--status-danger-fg`: the palette audit measured the fill red at 4.17:1 as a
// glyph on `--surface-raised`, under AA, and "a fill tone is not a text tone"
// (#432) is the rule that predicted it. Everything else is the kit's, unchanged.
//
// The order is HIGHEST FIRST and it is load-bearing — `queueOrder` in
// lib/plan.ts, `BUCKET_ORDER` in lib/spine.ts, `BUCKETS` in server/src/util.js
// and three SQL CASE expressions all spell it, and none can import another.
export const PRIORITY_META: {
  key: Priority; label: string; color: string; short: string; glyph: string;
}[] = [
  { key: 'highest', label: 'Highest', color: 'var(--status-danger-fg)', short: 'Highest', glyph: '⌃⌃' },
  { key: 'high', label: 'High', color: 'var(--status-danger-fg)', short: 'High', glyph: '⌃' },
  { key: 'medium', label: 'Medium', color: 'var(--amber-500)', short: 'Medium', glyph: '=' },
  { key: 'low', label: 'Low', color: 'var(--blue-400)', short: 'Low', glyph: '⌄' },
  { key: 'lowest', label: 'Lowest', color: 'var(--blue-400)', short: 'Lowest', glyph: '⌄⌄' },
];
/** The default a new item is born with — twin of BUCKET_DEFAULT in server/src/util.js. */
export const PRIORITY_DEFAULT: Priority = 'high';
export const priorityMeta = (p: Priority) =>
  PRIORITY_META.find((x) => x.key === p) || PRIORITY_META[1];

// Dual-model sessions (#153): the executor runs every turn, the advisor is the
// stronger model it consults as a subagent. '' = CLI default / no advisor.
// These are the FALLBACK lists used before the control payload loads (#175 —
// the live catalogue is `data.models`, served by the backend as the single
// source of truth). Shared by the Now room's console and the Plan room's
// header so both pickers offer the same models.
export type ModelChoice = { model: string; label: string };
export const FALLBACK_EXECUTORS: ModelChoice[] = [
  { model: '', label: 'Default' }, { model: 'haiku', label: 'Haiku' },
  { model: 'sonnet', label: 'Sonnet' }, { model: 'opus', label: 'Opus' },
  { model: 'claude-opus-5', label: 'Opus 5' },
];
export const FALLBACK_ADVISORS: ModelChoice[] = [
  { model: '', label: 'Off' }, { model: 'sonnet', label: 'Sonnet' },
  { model: 'opus', label: 'Opus' }, { model: 'claude-opus-5', label: 'Opus 5' },
  { model: 'fable', label: 'Fable' },
];
// The label for a stored value, so a hand-set alias outside the catalogue
// still reads as itself rather than vanishing.
export const modelLabel = (list: ModelChoice[], model: string, fallback = 'Default') =>
  list.find((m) => m.model === model)?.label ?? (model || fallback);

// Activity tags read as "accent" when they signal unfinished work.
export const isAccentTag = (label: string) => /progress|needs|todo/i.test(label);

// Client-side relative time for ISO stamps the server ships raw (e.g. a
// roadmap item's updatedAt). Server-computed "when" strings stay as they are.
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Day headers for date-clustered lists (the Reviews view): Today / Yesterday /
// "Tue 14 Jul" (+ year once it isn't this year's).
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return 'Earlier';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
