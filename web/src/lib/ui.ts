import type { BugStatus, Severity, Priority } from '../types';

export const PRODUCT_NAME = 'Stack';

export const STATUS_LABEL: Record<BugStatus, string> = {
  open: 'Open', investigating: 'Investigating', fixing: 'Fixing', fixed: 'Fixed',
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
export const PRIORITY_ORDER: Priority[] = ['must', 'should', 'could', 'wont'];
// `color` is rendered as TEXT (and a border) on a dark card, so each one names
// the token whose foreground variant reads there — never a literal. These were
// the old terracotta palette's hexes, hardcoded, and so they were the one part
// of the app a stylesheet repalette could not reach.
export const PRIORITY_META: { key: Priority; label: string; color: string; short: string }[] = [
  { key: 'must', label: 'Must have', color: 'var(--accent-text)', short: 'Must' },
  { key: 'should', label: 'Should have', color: 'var(--building)', short: 'Should' },
  { key: 'could', label: 'Could have', color: 'var(--sage)', short: 'Could' },
  { key: 'wont', label: "Won't (now)", color: 'var(--muted)', short: "Won't" },
];

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
