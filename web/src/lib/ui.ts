import type { BugStatus, Severity, Priority } from '../types';

export const PRODUCT_NAME = 'Stack';

export const STATUS_LABEL: Record<BugStatus, string> = {
  open: 'Open', investigating: 'Investigating', fixing: 'Fixing', fixed: 'Fixed',
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
export const PRIORITY_ORDER: Priority[] = ['must', 'should', 'could', 'wont'];
export const PRIORITY_META: { key: Priority; label: string; color: string; short: string }[] = [
  { key: 'must', label: 'Must have', color: '#c4623d', short: 'Must' },
  { key: 'should', label: 'Should have', color: '#b08a2e', short: 'Should' },
  { key: 'could', label: 'Could have', color: '#6f9a72', short: 'Could' },
  { key: 'wont', label: "Won't (now)", color: '#a39c90', short: "Won't" },
];

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
