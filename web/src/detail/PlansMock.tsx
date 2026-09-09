// THE PLANS TAB IS A MOCKUP. It reads nothing and it writes nothing.
//
// `ui_kits/console/PlansScreen.jsx` ported to TS, on the kit's own sample rows
// (KING-07 … ATL-12, five areas, three releases). It is the sixth and last of
// the kit ports — after the board and the Roadmap capture tab (#443), For you
// (#444), the board's two newer views (#447) and Quality (#450) — and it is
// the one that changes what the app IS, so the price is written out first.
//
// THIS WAS THE ONLY PROJECT TAB THAT READ ANYTHING. `detail/Plans.tsx` (#439)
// was 202 lines over the real roadmap, and with it gone EVERY project tab is
// now a mockup. What went, all of it the same shape — a column that is still
// written, still served and now read by nothing:
//
//  • THE STORED SCHEDULE HAS NO READER AGAIN. `sched_start_min` /
//    `sched_len_min` and their write-once `plan_start_min` / `plan_len_min`
//    baseline have been stored and baselined on create since #401. #428 took
//    their editor (the Timeline), #439 gave them a reader, and this takes it
//    back. Four packages still have to agree on the unit (CLAUDE.md's Data
//    rules), and nothing in any browser now depends on them agreeing.
//  • SLIP AGAINST THE BASELINE went with it — `slipOf` in `lib/plan.ts` has no
//    caller in the client at all now, and the three-state answer it exists to
//    give (moved / on plan / never baselined) is unaskable from a browser.
//  • `isBuilt` LOSES ITS LAST COMPONENT. #440 named Plans as its only reader;
//    the predicate itself stays exactly where it is (lib/plan.ts, re-exported
//    by lib/spine.ts, which still uses it internally) because it is the #374
//    definition and the runner spends it. Do not simplify it back on the
//    grounds that no screen calls it.
//  • OPENING AN ITEM'S MODAL FROM A PLAN ROW is gone. Plans rows were clickable
//    into `RoadmapModal`, which is where `tier` and `risk` are set BY HAND
//    (CLAUDE.md: from the item modal and nowhere else). The modal itself still
//    exists on the roadmap side; this screen cannot reach it.
//  • WEEK ZERO stops mattering to any screen. `project.weekZero` is still
//    served; nothing renders a date off it.
//
// THE ONE PROP IS A NAVIGATION CALLBACK, NOT DATA. The kit's "See on board"
// carries a filter (area + subject) into its BoardScreen; ours cannot, because
// the board is a mockup with nothing to filter. So the press moves to the
// board tab and stops there — a link that goes to the right screen and cannot
// narrow it is honest, a link that does nothing at all reads as a broken app.
//
// SIX SUB-VIEWS, all the kit's, all local state: Summary, Progress, Timeline
// (the default, and the densest), Calendar, Releases, Dependencies. Nothing
// persists — closing the tab is the undo. Two edits to the kit's own screen:
//
//  1. THE CALENDAR'S OFF-BY-ONE IS FIXED. The kit labels a cell from `i - 1`
//     but shades and fills it from `i`, so its events land a day off their own
//     numbers and Aug 31 draws as in-month. Here one index does both.
//  2. THE KIT'S "SPACES" ARE AREAS. Its Timeline groups by space (King, Atlas)
//     and its Progress groups by area; both are one thing in Stack, and both
//     read as `area` here. That word is load-bearing in the database in a way
//     this screen cannot honour: `(project, area)` IS the overnight lane
//     (#267), and an area with an open claimed item admits no second worker.
//     Nothing here can reach that, and a wiring session owes the mapping.
//
// THE PLAN'S NUMBERS ARE THE KIT'S AND THEY DO NOT ALL RECONCILE — the Summary
// counts seven items against the Timeline's seven rows, while Progress tallies
// sixty-odd across five areas, because the kit wrote the two views against
// different samples. Left alone for the reason QualityMock's header gives:
// inventing rows to square them is authoring sample data, not porting a screen.

import { useState, type CSSProperties, type ReactNode } from 'react';
import { KitIcon, type KitIconName } from './kit/KitIcon';

type SubTab = 'summary' | 'progress' | 'timeline' | 'calendar' | 'releases' | 'dependencies';
type StatusKey = 'todo' | 'progress' | 'review' | 'done';
type Tone = 'neutral' | 'info' | 'success' | 'warning';
type Kind = 'task' | 'idea';
type PriKey = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

const SUBTABS: { value: SubTab; label: string; icon: KitIconName }[] = [
  { value: 'summary', label: 'Summary', icon: 'layout-grid' },
  { value: 'progress', label: 'Progress', icon: 'chart-no-axes-column' },
  { value: 'timeline', label: 'Timeline', icon: 'list' },
  { value: 'calendar', label: 'Calendar', icon: 'calendar' },
  { value: 'releases', label: 'Releases', icon: 'bookmark' },
  { value: 'dependencies', label: 'Dependencies', icon: 'git-branch' },
];

const STATUSES: { value: StatusKey; label: string; tone: Tone }[] = [
  { value: 'todo', label: 'To do', tone: 'neutral' },
  { value: 'progress', label: 'In progress', tone: 'info' },
  { value: 'review', label: 'In review', tone: 'info' },
  { value: 'done', label: 'Done', tone: 'success' },
];
const STATUS_META: Record<StatusKey, { label: string; tone: Tone }> = {
  todo: { label: 'To do', tone: 'neutral' },
  progress: { label: 'In progress', tone: 'info' },
  review: { label: 'In review', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
};

// Priority is a ROLE here, never a colour: `.pl-pri` carries the rule's tone in
// styles.css, keyed off the level. Same rule the severity vocabulary follows on
// Quality — a component names the level, styles.css owns the tone.
const PRIORITY: Record<'high' | 'medium' | 'low', string> = {
  high: 'High', medium: 'Medium', low: 'Low',
};
const PRI_GLYPH: Record<PriKey, string> = {
  highest: '⌃⌃', high: '⌃', medium: '=', low: '⌄', lowest: '⌄⌄',
};
const PRI_LEVEL: Record<PriKey, 'hi' | 'med' | 'lo'> = {
  highest: 'hi', high: 'hi', medium: 'med', low: 'lo', lowest: 'lo',
};

/* ---------------------------------------------------------------- Timeline */

type TimelineRow = {
  n: number; id: string; kind: Kind; title: string; status: StatusKey;
  branch: string | null; start: string | null; due: string;
  priority: 'high' | 'medium' | 'low'; progress: number;
  checks: string | null; checkTone: Tone; dirty?: boolean; subtasks?: number;
};

const GROUPS: { area: string; due: string; progress: number; rows: TimelineRow[] }[] = [
  {
    area: 'King', due: 'Sep 14, 2026', progress: 46,
    rows: [
      { n: 1, id: 'KING-18', kind: 'task', title: 'Row recycling on scroll', status: 'progress', branch: 'king/col-virtualisation', start: 'Aug 30', due: 'Sep 04', priority: 'high', progress: 72, checks: '2 failing', checkTone: 'warning', dirty: true },
      { n: 2, id: 'KING-12', kind: 'task', title: 'Replace legacy grey ramp', status: 'review', branch: 'king/token-split', start: 'Aug 24', due: 'Sep 09', priority: 'medium', progress: 90, checks: 'passing', checkTone: 'success', dirty: true },
      { n: 3, id: 'KING-24', kind: 'task', title: 'Audit contrast on dark surfaces', status: 'todo', branch: null, start: null, due: 'Sep 14', priority: 'medium', progress: 0, checks: null, checkTone: 'neutral' },
      { n: 4, id: 'KING-31', kind: 'idea', title: 'Split token files by concern', status: 'done', branch: 'king/token-split', start: 'Aug 20', due: 'Aug 28', priority: 'low', progress: 100, checks: 'passing', checkTone: 'success' },
      { n: 5, id: 'KING-09', kind: 'idea', title: 'The terminal needs a focus ring spec', status: 'done', branch: 'main', start: 'Aug 12', due: 'Aug 18', priority: 'low', progress: 100, checks: 'passing', checkTone: 'success', subtasks: 2 },
    ],
  },
  {
    area: 'Atlas', due: 'Sep 30, 2026', progress: 12,
    rows: [
      { n: 6, id: 'ATL-04', kind: 'task', title: 'Print sheet geometry', status: 'todo', branch: 'king/print-styles', start: null, due: 'Sep 22', priority: 'low', progress: 8, checks: 'stale', checkTone: 'warning' },
      { n: 7, id: 'ATL-07', kind: 'idea', title: 'Budget line on the usage chart', status: 'todo', branch: null, start: null, due: 'Sep 30', priority: 'medium', progress: 0, checks: null, checkTone: 'neutral' },
    ],
  },
];

/* ---------------------------------------------------------------- Progress */

type PlanItem = {
  id: string; title: string; area: string; subject: string;
  status: StatusKey; kind: Kind; priority: PriKey; pts: number;
};

const ITEMS: PlanItem[] = [
  { id: 'KING-31', title: 'Split token files by concern', area: 'Design system', subject: 'Token layer', status: 'done', kind: 'idea', priority: 'low', pts: 2 },
  { id: 'KING-30', title: 'Name the surface stack', area: 'Design system', subject: 'Token layer', status: 'done', kind: 'task', priority: 'medium', pts: 1 },
  { id: 'KING-29', title: 'Motion tokens', area: 'Design system', subject: 'Token layer', status: 'done', kind: 'task', priority: 'low', pts: 1 },
  { id: 'KING-28', title: 'Elevation and focus rings', area: 'Design system', subject: 'Token layer', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-27', title: 'Type scale', area: 'Design system', subject: 'Token layer', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-26', title: 'Semantic status pairs', area: 'Design system', subject: 'Token layer', status: 'done', kind: 'task', priority: 'high', pts: 3 },
  { id: 'KING-07', title: 'Ship Button and IconButton', area: 'Design system', subject: 'Core components', status: 'done', kind: 'task', priority: 'high', pts: 2 },
  { id: 'KING-08', title: 'Input, select, switch', area: 'Design system', subject: 'Core components', status: 'done', kind: 'task', priority: 'high', pts: 3 },
  { id: 'KING-09', title: 'Focus ring spec', area: 'Design system', subject: 'Core components', status: 'done', kind: 'idea', priority: 'lowest', pts: 1 },
  { id: 'KING-10', title: 'Card and tag', area: 'Design system', subject: 'Core components', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-11', title: 'Tabs and stat tile', area: 'Design system', subject: 'Core components', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-35', title: 'Extract the diff bar', area: 'Design system', subject: 'Core components', status: 'review', kind: 'idea', priority: 'medium', pts: 2 },
  { id: 'KING-39', title: 'Second surface step for nested cards', area: 'Design system', subject: 'Core components', status: 'todo', kind: 'idea', priority: 'low', pts: 1 },
  { id: 'KING-12', title: 'Replace legacy grey ramp', area: 'Design system', subject: 'Contrast audit', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'KING-13', title: 'Contrast floor check', area: 'Design system', subject: 'Contrast audit', status: 'done', kind: 'task', priority: 'high', pts: 2 },
  { id: 'KING-14', title: 'Alpha text audit', area: 'Design system', subject: 'Contrast audit', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-24', title: 'Audit contrast on dark surfaces', area: 'Design system', subject: 'Contrast audit', status: 'progress', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'KING-25', title: 'Contrast on the light panel', area: 'Design system', subject: 'Contrast audit', status: 'todo', kind: 'task', priority: 'low', pts: 2 },

  { id: 'KING-15', title: 'Measure row height once per column', area: 'Board and stack', subject: 'Column virtualisation', status: 'done', kind: 'task', priority: 'high', pts: 3 },
  { id: 'KING-16', title: 'Recycle row nodes', area: 'Board and stack', subject: 'Column virtualisation', status: 'done', kind: 'task', priority: 'high', pts: 5 },
  { id: 'KING-17', title: 'Extract useVirtual', area: 'Board and stack', subject: 'Column virtualisation', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-20', title: 'Scroll anchoring', area: 'Board and stack', subject: 'Column virtualisation', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'KING-18', title: 'Row recycling on scroll', area: 'Board and stack', subject: 'Column virtualisation', status: 'progress', kind: 'task', priority: 'highest', pts: 8 },
  { id: 'KING-19', title: 'Fix drop target at 1440px', area: 'Board and stack', subject: 'Column virtualisation', status: 'review', kind: 'task', priority: 'high', pts: 3 },
  { id: 'KING-21', title: 'Virtualise the trail list', area: 'Board and stack', subject: 'Column virtualisation', status: 'todo', kind: 'idea', priority: 'low', pts: 5 },
  { id: 'KING-22', title: 'Priority glyph set', area: 'Board and stack', subject: 'Priority picker', status: 'done', kind: 'task', priority: 'medium', pts: 1 },
  { id: 'KING-23', title: 'Picker menu', area: 'Board and stack', subject: 'Priority picker', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-32', title: 'Write-back on pick', area: 'Board and stack', subject: 'Priority picker', status: 'done', kind: 'task', priority: 'high', pts: 2 },
  { id: 'KING-33', title: 'Sidebar tree keyboard nav', area: 'Board and stack', subject: 'Keyboard navigation', status: 'todo', kind: 'task', priority: 'high', pts: 5 },
  { id: 'KING-34', title: 'Column focus walk', area: 'Board and stack', subject: 'Keyboard navigation', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'KING-36', title: 'Card focus ring', area: 'Board and stack', subject: 'Keyboard navigation', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-37', title: 'Shortcut overlay', area: 'Board and stack', subject: 'Keyboard navigation', status: 'todo', kind: 'idea', priority: 'lowest', pts: 3 },
  { id: 'KING-40', title: 'Escape cancels a drag', area: 'Board and stack', subject: 'Keyboard navigation', status: 'todo', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'KING-42', title: 'Enter opens the composer', area: 'Board and stack', subject: 'Keyboard navigation', status: 'todo', kind: 'task', priority: 'low', pts: 1 },

  { id: 'PLAN-11', title: 'Timeline column set', area: 'Plans and progress', subject: 'Timeline grid', status: 'done', kind: 'task', priority: 'high', pts: 3 },
  { id: 'PLAN-12', title: 'Status workflow menu', area: 'Plans and progress', subject: 'Timeline grid', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'PLAN-13', title: 'Area group rollups', area: 'Plans and progress', subject: 'Timeline grid', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'PLAN-14', title: 'Drag a bar to move a date', area: 'Plans and progress', subject: 'Timeline grid', status: 'progress', kind: 'idea', priority: 'medium', pts: 5 },
  { id: 'PLAN-15', title: 'Inline date editing', area: 'Plans and progress', subject: 'Timeline grid', status: 'todo', kind: 'task', priority: 'low', pts: 3 },
  { id: 'PLAN-16', title: 'Month grid', area: 'Plans and progress', subject: 'Calendar', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'PLAN-17', title: 'Multi-day spans', area: 'Plans and progress', subject: 'Calendar', status: 'todo', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'PLAN-18', title: 'Week view', area: 'Plans and progress', subject: 'Calendar', status: 'todo', kind: 'idea', priority: 'low', pts: 5 },
  { id: 'PLAN-19', title: 'Blocks arrows', area: 'Plans and progress', subject: 'Dependencies', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'PLAN-20', title: 'Cycle detection', area: 'Plans and progress', subject: 'Dependencies', status: 'todo', kind: 'task', priority: 'high', pts: 5 },
  { id: 'PLAN-21', title: 'Cross-area links', area: 'Plans and progress', subject: 'Dependencies', status: 'todo', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'PLAN-22', title: 'Link type filter', area: 'Plans and progress', subject: 'Dependencies', status: 'todo', kind: 'idea', priority: 'low', pts: 2 },

  { id: 'QUAL-08', title: 'Check runner', area: 'Quality', subject: 'Check suite', status: 'done', kind: 'task', priority: 'highest', pts: 5 },
  { id: 'QUAL-09', title: 'Suite grouping by area', area: 'Quality', subject: 'Check suite', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'QUAL-10', title: 'Nightly schedule', area: 'Quality', subject: 'Check suite', status: 'done', kind: 'task', priority: 'medium', pts: 2 },
  { id: 'QUAL-11', title: 'Severity grading', area: 'Quality', subject: 'Check suite', status: 'done', kind: 'task', priority: 'high', pts: 3 },
  { id: 'QUAL-12', title: 'Pass-rate history', area: 'Quality', subject: 'Check suite', status: 'done', kind: 'task', priority: 'low', pts: 2 },
  { id: 'QUAL-13', title: 'Quarantine flaky checks', area: 'Quality', subject: 'Check suite', status: 'progress', kind: 'idea', priority: 'high', pts: 3 },
  { id: 'QUAL-14', title: 'Bug composer', area: 'Quality', subject: 'Bug intake', status: 'done', kind: 'task', priority: 'high', pts: 3 },
  { id: 'QUAL-15', title: 'Area and subject clustering', area: 'Quality', subject: 'Bug intake', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'QUAL-16', title: 'Verdict reminders', area: 'Quality', subject: 'Bug intake', status: 'todo', kind: 'idea', priority: 'low', pts: 2 },

  { id: 'ATL-04', title: 'Print sheet geometry', area: 'Print and export', subject: 'Print sheet geometry', status: 'progress', kind: 'idea', priority: 'lowest', pts: 5 },
  { id: 'ATL-05', title: 'Letter and A4 fit', area: 'Print and export', subject: 'Print sheet geometry', status: 'done', kind: 'task', priority: 'medium', pts: 3 },
  { id: 'ATL-06', title: 'Repeated header', area: 'Print and export', subject: 'Print sheet geometry', status: 'todo', kind: 'task', priority: 'low', pts: 2 },
  { id: 'ATL-08', title: 'Landscape sheets', area: 'Print and export', subject: 'Print sheet geometry', status: 'todo', kind: 'task', priority: 'lowest', pts: 2 },
  { id: 'ATL-09', title: 'Page break control', area: 'Print and export', subject: 'Print sheet geometry', status: 'todo', kind: 'task', priority: 'low', pts: 3 },
  { id: 'ATL-10', title: 'PDF pipeline', area: 'Print and export', subject: 'PDF export', status: 'todo', kind: 'task', priority: 'medium', pts: 5 },
  { id: 'ATL-11', title: 'Embed fonts', area: 'Print and export', subject: 'PDF export', status: 'todo', kind: 'task', priority: 'low', pts: 3 },
  { id: 'ATL-12', title: 'Export dialog', area: 'Print and export', subject: 'PDF export', status: 'todo', kind: 'idea', priority: 'low', pts: 2 },
];

// Roadmap ideas with no work item yet. THE KIT'S OWN RULE AND IT IS A GOOD ONE:
// they are not in the plan, so they must not count toward completion — they sit
// in their own section per area and are tallied nowhere else.
type Unplanned = { id: string; title: string; area: string; state: 'Ready' | 'Thinking' | 'Parked'; effort: string };
const UNPLANNED: Unplanned[] = [
  { id: 'MDP-11', title: 'Second surface step for nested cards', area: 'Design system', state: 'Thinking', effort: 'S' },
  { id: 'MDP-13', title: 'Light mode', area: 'Design system', state: 'Parked', effort: 'L' },
  { id: 'MDP-4', title: 'Virtualise the trail list', area: 'Board and stack', state: 'Thinking', effort: 'M' },
  { id: 'MDP-14', title: 'One command palette for everything', area: 'Board and stack', state: 'Parked', effort: 'L' },
  { id: 'MDP-3', title: 'Budget line on the usage chart', area: 'Plans and progress', state: 'Thinking', effort: 'M' },
  { id: 'MDP-10', title: 'Drag a bar to move a date', area: 'Plans and progress', state: 'Ready', effort: 'M' },
  { id: 'MDP-8', title: 'Verdict reminders after two days', area: 'Quality', state: 'Thinking', effort: 'S' },
  { id: 'MDP-9', title: 'Quarantine flaky checks automatically', area: 'Quality', state: 'Ready', effort: 'M' },
  { id: 'MDP-7', title: 'Print sheet geometry rework', area: 'Print and export', state: 'Parked', effort: 'M' },
];

type Counts = { done: number; flight: number; todo: number };
const BUCKET: Record<StatusKey, keyof Counts> = { done: 'done', progress: 'flight', review: 'flight', todo: 'todo' };
const tally = (items: PlanItem[]): Counts =>
  items.reduce<Counts>((o, i) => ({ ...o, [BUCKET[i.status]]: o[BUCKET[i.status]] + 1 }), { done: 0, flight: 0, todo: 0 });

const SEG: { key: keyof Counts; label: string }[] = [
  { key: 'done', label: 'Closed' },
  { key: 'flight', label: 'In flight' },
  { key: 'todo', label: 'Not started' },
];

const TREND: Record<string, number[]> = {
  'Design system': [4, 6, 8, 11, 13, 14],
  'Board and stack': [2, 3, 5, 6, 8, 9],
  'Plans and progress': [0, 1, 2, 3, 4, 5],
  Quality: [1, 2, 4, 5, 6, 7],
  'Print and export': [0, 0, 0, 1, 1, 1],
};
const RANK: Record<PriKey, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };

type Child = Counts & { name: string; items: PlanItem[] };
type Area = Counts & {
  name: string; items: PlanItem[]; total: number; trend: number[];
  ideas: Unplanned[]; next: string; nextId: string | null; children: Child[];
};

const AREAS: Area[] = [...new Set(ITEMS.map((i) => i.area))].map((name) => {
  const items = ITEMS.filter((i) => i.area === name);
  const next = items.filter((i) => i.status !== 'done').sort((a, b) => RANK[a.priority] - RANK[b.priority])[0];
  return {
    name, items, ...tally(items), total: items.length,
    trend: TREND[name],
    ideas: UNPLANNED.filter((u) => u.area === name),
    next: next ? next.title : 'Nothing left',
    nextId: next ? next.id : null,
    children: [...new Set(items.map((i) => i.subject))].map((subject) => {
      const sub = items.filter((i) => i.subject === subject);
      return { name: subject, items: sub, ...tally(sub) };
    }),
  };
});

/* ----------------------------------------------------------------- Summary */

const SUMMARY_CHIPS: { icon: KitIconName; value: string; label: string }[] = [
  { icon: 'bookmark', value: '5', label: 'unplanned work items' },
  { icon: 'circle-alert', value: '1', label: 'highest priority item' },
  { icon: 'calendar', value: '0', label: 'overdue work items' },
  { icon: 'git-branch', value: '2', label: 'blocked work items' },
];
const STATUS_SPLIT: { label: string; count: number; seg: keyof Counts }[] = [
  { label: 'Done', count: 2, seg: 'done' },
  { label: 'In progress', count: 2, seg: 'flight' },
  { label: 'To do', count: 3, seg: 'todo' },
];
const WEEKS = [
  { label: 'W32', done: 2 }, { label: 'W33', done: 4 }, { label: 'W34', done: 3 },
  { label: 'W35', done: 6 }, { label: 'W36', done: 5 }, { label: 'W37', done: 1 },
];
const KEY_DEPS = [
  { from: 'KING-18', to: 'KING-24', rel: 'blocks', state: 'In progress' },
  { from: 'KING-12', to: 'ATL-04', rel: 'blocks', state: 'In review' },
];

/* ---------------------------------------------------------------- Calendar */

// Keyed by DAY OF SEPTEMBER, and read by the same index that labels and shades
// the cell — the kit's own version labelled off one index and filled off
// another, so its events sat a day away from their own numbers.
type CalEvent = { id: string; title: string; kind: Kind; tone: 'active' | 'done' | 'idle' };
const CAL_EVENTS: Record<number, CalEvent[]> = {
  4: [{ id: 'KING-09', title: 'Focus ring spec', kind: 'task', tone: 'done' }],
  9: [
    { id: 'KING-12', title: 'Grey ramp merge window', kind: 'task', tone: 'active' },
    { id: 'KING-31', title: 'Token split review', kind: 'idea', tone: 'idle' },
  ],
  14: [
    { id: 'KING-18', title: 'Virtualisation ship date', kind: 'task', tone: 'active' },
    { id: 'ATL-04', title: 'Print sheet spike', kind: 'idea', tone: 'idle' },
  ],
  22: [{ id: 'ATL-04', title: 'Print styles decision', kind: 'idea', tone: 'idle' }],
  30: [{ id: 'ATL-07', title: 'Budget line on usage chart', kind: 'idea', tone: 'idle' }],
};
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Sep 2026 opens on a Tuesday, so cell 0 is Aug 31 and cell 30 is Sep 30.
const TODAY = 2;

/* ---------------------------------------------------------------- Releases */

const RELEASES: {
  name: string; date: string; state: string; tone: Tone;
  items: { id: string; title: string; state: StatusKey }[];
  done: number; flight: number; todo: number;
}[] = [
  {
    name: 'tokens-v1.5', date: 'Sep 14, 2026', state: 'In progress', tone: 'info',
    items: [
      { id: 'KING-18', title: 'Row recycling on scroll', state: 'progress' },
      { id: 'KING-12', title: 'Replace legacy grey ramp', state: 'review' },
      { id: 'KING-24', title: 'Audit contrast on dark surfaces', state: 'todo' },
    ], done: 4, flight: 2, todo: 3,
  },
  {
    name: 'tokens-v1.4', date: 'Aug 31, 2026', state: 'Released', tone: 'success',
    items: [
      { id: 'KING-31', title: 'Split token files by concern', state: 'done' },
      { id: 'KING-09', title: 'Focus ring spec', state: 'done' },
    ], done: 6, flight: 0, todo: 0,
  },
  {
    name: 'print-preview', date: 'unscheduled', state: 'Parked', tone: 'warning',
    items: [{ id: 'ATL-04', title: 'Print sheet geometry', state: 'todo' }], done: 0, flight: 0, todo: 2,
  },
];

/* ------------------------------------------------------------ Dependencies */

type DepNode = { id: string; title: string; kind: Kind; start: string; end: string; state: string; tone: Tone };
const LINKS: { rel: string; from: DepNode; to: DepNode }[] = [
  {
    rel: 'blocks',
    from: { id: 'KING-18', title: 'Row recycling on scroll', kind: 'task', start: '30/08/2026', end: '04/09/2026', state: 'In progress', tone: 'info' },
    to: { id: 'KING-24', title: 'Audit contrast on dark surfaces', kind: 'idea', start: '—', end: '14/09/2026', state: 'To do', tone: 'neutral' },
  },
  {
    rel: 'blocks',
    from: { id: 'KING-12', title: 'Replace legacy grey ramp', kind: 'task', start: '24/08/2026', end: '09/09/2026', state: 'In review', tone: 'info' },
    to: { id: 'ATL-04', title: 'Print sheet geometry', kind: 'idea', start: '—', end: '22/09/2026', state: 'To do', tone: 'neutral' },
  },
];

/* ================================================================= the tab */

export function PlansMock({ onBoard }: { onBoard?: () => void }) {
  const [sub, setSub] = useState<SubTab>('timeline');

  return (
    <div className="pl">
      <div className="pl-head">
        <span className="pl-crumb">Plans and progress</span>
        <div className="pl-headrow">
          <span className="mark"><KitIcon name="list" size={16} /></span>
          <h1>Terminal</h1>
          <button className="k-iconbtn sm" aria-label="Plan actions"><KitIcon name="ellipsis" size={15} /></button>
          <span className="acts">
            <button className="k-iconbtn sm solid" aria-label="Share"><KitIcon name="arrow-up-right" size={14} /></button>
            <button className="k-iconbtn sm solid" aria-label="Comments"><KitIcon name="file-text" size={14} /></button>
            <button className="k-btn sm">Unsaved changes<span className="pl-count">5</span></button>
          </span>
        </div>

        <div className="k-tabs pl-tabs">
          {SUBTABS.map((t) => (
            <button key={t.value} className={`k-tab${sub === t.value ? ' on' : ''}`} onClick={() => setSub(t.value)}>
              <KitIcon name={t.icon} size={14} />{t.label}
            </button>
          ))}
          <button className="k-tab pl-tabadd" aria-label="Add a view"><KitIcon name="plus" size={14} /></button>
        </div>
      </div>

      {sub === 'summary' && <SummaryView />}
      {sub === 'progress' && <ProgressView onBoard={onBoard} />}
      {sub === 'timeline' && <TimelineView />}
      {sub === 'calendar' && <CalendarView />}
      {sub === 'releases' && <ReleasesView />}
      {sub === 'dependencies' && <DependenciesView />}
    </div>
  );
}

function Caret() {
  return <span className="pl-caret" aria-hidden="true">▾</span>;
}

function Meter({ value }: { value: number }) {
  return (
    <span className="pl-meter">
      <span className="track"><span className={`fill${value === 100 ? ' full' : ''}`} style={{ width: `${value}%` }} /></span>
      <span className="pct">{value}%</span>
    </span>
  );
}

/* ---------------------------------------------------------------- Timeline */

function TimelineView() {
  const [mode, setMode] = useState<'Timeline' | 'List'>('List');
  const [statusOf, setStatusOf] = useState<Record<string, StatusKey>>(
    () => Object.fromEntries(GROUPS.flatMap((g) => g.rows.map((r) => [r.id, r.status]))),
  );
  const [menu, setMenu] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState('KING-09');

  return (
    <>
      <div className="pl-toolbar">
        <span className="pl-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search timeline" aria-label="Search timeline" />
        </span>
        <button className="k-btn sm secondary">Filter<Caret /></button>
        <button className="k-btn sm secondary"><KitIcon name="list" size={14} />Basic view<Caret /></button>
        <button className="k-iconbtn sm solid" aria-label="Save view"><KitIcon name="check" size={14} /></button>

        <span className="right">
          <button className="k-btn sm secondary"><KitIcon name="layers" size={14} />Group: Area<Caret /></button>
          <span className="pl-seg2">
            {(['Timeline', 'List'] as const).map((m) => (
              <button key={m} className={`pl-seg2b${mode === m ? ' on' : ''}`} aria-pressed={mode === m}
                onClick={() => setMode(m)}>{m}</button>
            ))}
          </span>
          <button className="k-iconbtn sm" aria-label="View settings"><KitIcon name="settings" size={15} /></button>
        </span>
      </div>

      <div className="pl-scroll">
        <div className="pl-grid">
          <div className="pl-workbar">
            <span className="lbl">Work item<Caret /></span>
            <button className="k-btn sm secondary"><KitIcon name="plus" size={13} />Create work</button>
            <span className="add">Add fields<Caret /></span>
          </div>

          <div className="pl-row head">
            <span className="c-check"><Box /></span>
            <span className="c-n">#</span>
            <span className="c-item">Work item</span>
            <span className="c-status">Status</span>
            <span className="c-branch">Branch</span>
            <span className="c-date">Start date<span className="pl-coltag">D</span></span>
            <span className="c-date">Due date<span className="pl-coltag">D</span></span>
            <span className="c-pri">Priority</span>
            <span className="c-prog">Progress</span>
            <span className="c-checks">Checks</span>
            <span className="c-flag"><KitIcon name="plus" size={14} /></span>
          </div>

          {GROUPS.map((g) => (
            <div className="pl-group" key={g.area}>
              <div className="pl-row group">
                <span className="c-check"><span className="pl-caret">▾</span></span>
                <span className="c-groupname">
                  <span className="glyph"><KitIcon name="layers" size={11} /></span>
                  <span className="nm">{g.area}</span>
                  <span className="plus"><KitIcon name="plus" size={13} /></span>
                </span>
                <span className="c-status"><Meter value={g.progress} /></span>
                <span className="c-branch mono">{g.rows.length} items</span>
                <span className="c-date">Earliest</span>
                <span className="c-date mono strong">{g.due}</span>
                <span className="c-pri">Medium</span>
                <span className="c-prog"><Meter value={g.progress} /></span>
                <span className="c-checks" />
                <span className="c-flag" />
              </div>

              {g.rows.map((r) => (
                <TimelineRowView
                  key={r.id} row={r}
                  status={statusOf[r.id]}
                  onStatus={(v) => { setStatusOf({ ...statusOf, [r.id]: v }); setMenu(null); }}
                  menuOpen={menu === r.id}
                  onMenu={() => setMenu(menu === r.id ? null : r.id)}
                  checked={!!picked[r.id]}
                  onCheck={() => setPicked({ ...picked, [r.id]: !picked[r.id] })}
                  cursor={cursor === r.id}
                  onFocus={() => setCursor(r.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Box({ checked }: { checked?: boolean }) {
  return (
    <span className={`pl-box${checked ? ' on' : ''}`} aria-hidden="true">
      {checked && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 5.2 3.8 7.5 8.5 2.6" />
        </svg>
      )}
    </span>
  );
}

function TimelineRowView({ row, status, onStatus, menuOpen, onMenu, checked, onCheck, cursor, onFocus }: {
  row: TimelineRow; status: StatusKey; onStatus: (v: StatusKey) => void;
  menuOpen: boolean; onMenu: () => void;
  checked: boolean; onCheck: () => void;
  cursor: boolean; onFocus: () => void;
}) {
  const st = STATUS_META[status];
  return (
    <>
      <div className={`pl-row${cursor ? ' cursor' : ''}`} onClick={onFocus}>
        <span className="c-check">
          <span className="hit" onClick={(e) => { e.stopPropagation(); onCheck(); }}><Box checked={checked} /></span>
        </span>
        <span className="c-n mono">{row.n}</span>
        <span className="c-item">
          <span className={`pl-kind ${row.kind}`}><KitIcon name={row.kind === 'idea' ? 'bookmark' : 'circle-check'} size={14} /></span>
          <span className="id">{row.id}</span>
          <span className="t">{row.title}</span>
        </span>

        <span className="c-status">
          <button className={`pl-statusbtn k-tag ${st.tone}`} onClick={(e) => { e.stopPropagation(); onMenu(); }}
            aria-expanded={menuOpen}>{st.label}<Caret /></button>
          {menuOpen && (
            <div className="pl-menu" onClick={(e) => e.stopPropagation()}>
              {STATUSES.map((s) => (
                <button key={s.value} className="pl-menuitem" onClick={() => onStatus(s.value)}>
                  <span className={`k-tag ${s.tone}`}>{s.label}</span>
                  {s.value === status && <span className="tick"><KitIcon name="check" size={13} /></span>}
                </button>
              ))}
              <span className="pl-menurule" />
              <button className="pl-menuitem plain">View workflow</button>
            </div>
          )}
        </span>

        <span className="c-branch">
          {row.branch
            ? <span className="br"><KitIcon name="git-branch" size={12} /><span className="mono">{row.branch}</span></span>
            : <span className="pl-dash">—</span>}
        </span>
        <span className="c-date mono">{row.start ?? <span className="pl-dash">—</span>}</span>
        <span className="c-date mono">{row.due}</span>
        <span className="c-pri">
          <span className={`pl-pri ${PRI_LEVEL[row.priority]}`} />
          {PRIORITY[row.priority]}
        </span>
        <span className="c-prog"><Meter value={row.progress} /></span>
        <span className="c-checks">
          {row.checks && <span className={`k-tag ${row.checkTone}`}>{row.checks}</span>}
        </span>
        <span className="c-flag">{row.dirty && <span className="pl-dirty" title="Uncommitted work in this branch" />}</span>
      </div>

      {row.subtasks ? (
        <div className="pl-subrow">
          <span className="c-check" />
          <span className="c-item">
            <span className="pl-caret">▸</span>
            Subtask — {row.subtasks} work items
          </span>
        </div>
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------- Summary */

function SummaryView() {
  const total = STATUS_SPLIT.reduce((n, s) => n + s.count, 0);
  const donePct = Math.round((STATUS_SPLIT[0].count / total) * 100);
  const p1 = (STATUS_SPLIT[0].count / total) * 100;
  const p2 = ((STATUS_SPLIT[0].count + STATUS_SPLIT[1].count) / total) * 100;

  return (
    <div className="pl-view">
      <div className="pl-viewbar">
        <span className="pl-range"><KitIcon name="calendar" size={13} />20/Aug/26 – 30/Sep/26</span>
        <span className="pl-saved">Date last saved Sep 02, 2026</span>
      </div>

      <div className="pl-chips">
        {SUMMARY_CHIPS.map((c) => (
          <div className="pl-chip" key={c.label}>
            <span className="glyph"><KitIcon name={c.icon} size={14} /></span>
            <span className="txt"><b>{c.value}</b> {c.label}</span>
          </div>
        ))}
      </div>

      <div className="pl-cards">
        <Panel title="Status overview" control="Task">
          <span className="pl-lede">
            Where the plan sits right now. Pick a slice to filter the timeline to that status.
          </span>
          <div className="pl-donutrow">
            {/* The ring is ONE conic gradient and the component supplies only
                its two stops: the three tones are the same closed / in flight /
                not started roles the Progress view uses, and they stay in
                styles.css so a repalette moves both together. */}
            <span className="pl-donut">
              <span className="ring" style={{ '--p1': `${p1}%`, '--p2': `${p2}%` } as CSSProperties} />
              <span className="hole"><b>{donePct}%</b><span>done</span></span>
            </span>
            <div className="pl-legend">
              {STATUS_SPLIT.map((s) => (
                <div className="row" key={s.label}>
                  <span className={`dot seg-${s.seg}`} />
                  <span className="l">{s.label}</span>
                  <span className="n">{s.count} items</span>
                </div>
              ))}
              <div className="row total">
                <span className="l">Total</span>
                <span className="n">{total} items</span>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Throughput" control="6 weeks">
          <span className="pl-lede">
            Items closed per week across this plan. Last week dipped while the virtualisation
            branch stayed open.
          </span>
          <div className="pl-bars">
            {WEEKS.map((w, i) => (
              <div className="col" key={w.label}>
                <span className="n">{w.done}</span>
                <span className={`bar${i === WEEKS.length - 1 ? ' last' : ''}`} style={{ height: `${(w.done / 6) * 100}%` }} />
                <span className="l">{w.label}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Key dependencies" control="All statuses">
          {KEY_DEPS.map((d) => (
            <div className="pl-depline" key={d.from}>
              <span className="id">{d.from}</span>
              <span className="rel">{d.rel}</span>
              <span className="rule" />
              <span className="id">{d.to}</span>
              <span className="rel">{d.state}</span>
            </div>
          ))}
        </Panel>

        <Panel title="Next release" control="v1.5">
          <div className="pl-nextrel">
            <span className="top"><b>tokens-v1.5</b><span className="when">Sep 14, 2026</span></span>
            <SplitBar counts={{ done: 4, flight: 2, todo: 3 }} />
            <span className="sub">4 done · 2 in flight · 3 not started</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, control, children }: { title: string; control?: string; children: ReactNode }) {
  return (
    <section className="pl-panel">
      <header className="pl-panelhead">
        <span className="t">{title}</span>
        {control && <span className="ctl">{control}<Caret /></span>}
      </header>
      {children}
    </section>
  );
}

/** The release/summary bar: three roles, drawn in proportion, no track behind. */
function SplitBar({ counts }: { counts: Counts }) {
  const total = counts.done + counts.flight + counts.todo || 1;
  return (
    <span className="pl-splitbar">
      {SEG.map((s) => (
        <span key={s.key} className={`seg-${s.key}`} style={{ flexGrow: counts[s.key] / total }} />
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- Progress */

function ProgressView({ onBoard }: { onBoard?: () => void }) {
  const [sort, setSort] = useState<'Plan order' | 'Most left' | 'Furthest on'>('Plan order');
  const [sel, setSel] = useState(AREAS[1].name);
  const [open, setOpen] = useState<Record<string, boolean>>({ [AREAS[1].name]: true });
  const [openSubject, setOpenSubject] = useState<Record<string, boolean>>({ 'Board and stack/Column virtualisation': true });

  const totals: Counts = AREAS.reduce<Counts>(
    (o, a) => ({ done: o.done + a.done, flight: o.flight + a.flight, todo: o.todo + a.todo }),
    { done: 0, flight: 0, todo: 0 },
  );
  const total = totals.done + totals.flight + totals.todo;
  const areas = sortAreas(AREAS, sort);
  const selected = AREAS.find((a) => a.name === sel);
  const allOpen = Object.values(open).filter(Boolean).length === AREAS.length;

  return (
    <div className="pl-view">
      <section className="pl-panel pl-planwide">
        <div className="top">
          <span className="big">{Math.round((totals.done / total) * 100)}%</span>
          <span className="cap">of the plan is closed · {totals.done} of {total} items</span>
          <span className="keys">
            {SEG.map((s) => (
              <span className="key" key={s.key}>
                <span className={`dot seg-${s.key}`} />
                <span className="l">{s.label}</span>
                <span className="n">{totals[s.key]}</span>
              </span>
            ))}
          </span>
        </div>
        <SegBar counts={totals} />
      </section>

      <div className="pl-progcols">
        <section className="pl-panel">
          <header className="pl-panelhead">
            <span className="t">Completion by area</span>
            <span className="sub">{AREAS.length} areas</span>
            <span className="pl-seg2">
              {(['Plan order', 'Most left', 'Furthest on'] as const).map((m) => (
                <button key={m} className={`pl-seg2b${sort === m ? ' on' : ''}`} aria-pressed={sort === m}
                  onClick={() => setSort(m)}>{m}</button>
              ))}
            </span>
            <button className="pl-linkbtn"
              onClick={() => setOpen(allOpen ? {} : Object.fromEntries(AREAS.map((a) => [a.name, true])))}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          </header>

          <div className="pl-arealist">
            {areas.map((a) => (
              <div key={a.name}>
                <AreaRow area={a} selected={sel === a.name} open={!!open[a.name]}
                  onSelect={() => setSel(a.name)}
                  onToggle={() => setOpen({ ...open, [a.name]: !open[a.name] })} />
                {open[a.name] && a.children.map((c) => (
                  <ChildRow key={c.name} child={c}
                    open={!!openSubject[`${a.name}/${c.name}`]}
                    onToggle={() => setOpenSubject({
                      ...openSubject, [`${a.name}/${c.name}`]: !openSubject[`${a.name}/${c.name}`],
                    })}
                    onBoard={onBoard} />
                ))}
              </div>
            ))}
          </div>
        </section>

        {selected && <AreaDetail area={selected} />}
      </div>
    </div>
  );
}

function sortAreas(list: Area[], mode: 'Plan order' | 'Most left' | 'Furthest on'): Area[] {
  const copy = list.slice();
  if (mode === 'Most left') return copy.sort((a, b) => (b.total - b.done) - (a.total - a.done));
  if (mode === 'Furthest on') return copy.sort((a, b) => b.done / b.total - a.done / a.total);
  return copy;
}

/** Parent bars are tall with a hairline ring; child bars are half-height and
    flatter, so a glance says which level you are reading. */
function SegBar({ counts, child }: { counts: Counts; child?: boolean }) {
  const total = counts.done + counts.flight + counts.todo || 1;
  return (
    <span className={`pl-segbar${child ? ' child' : ''}`}>
      {SEG.map((s) => (counts[s.key]
        ? <span key={s.key} className={`seg-${s.key}`} style={{ flexGrow: counts[s.key] / total }} />
        : null))}
    </span>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <span className="pl-spark" aria-hidden="true">
      {values.map((v, i) => (
        <span key={i} className={i === values.length - 1 ? 'last' : ''}
          style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
      ))}
    </span>
  );
}

function AreaRow({ area, selected, open, onSelect, onToggle }: {
  area: Area; selected: boolean; open: boolean; onSelect: () => void; onToggle: () => void;
}) {
  const pct = Math.round((area.done / area.total) * 100);
  const left = area.total - area.done;
  return (
    <div className={`pl-arearow${selected ? ' on' : ''}`} onClick={() => { onSelect(); if (!open) onToggle(); }}>
      <span className="pl-caret" onClick={(e) => { e.stopPropagation(); onToggle(); }}>{open ? '▾' : '▸'}</span>
      <span className="nm">
        <span className="t">{area.name}</span>
        <span className="sub">
          {area.children.length} subjects · {left ? `${left} left` : 'complete'}
          {area.ideas.length ? ` · ${area.ideas.length} ideas` : ''}
        </span>
      </span>
      <span className="bar"><SegBar counts={area} /></span>
      <Spark values={area.trend} />
      <span className="of">{area.done}/{area.total}</span>
      <span className={`pct${pct === 100 ? ' full' : ''}`}>{pct}%</span>
    </div>
  );
}

function ChildRow({ child, open, onToggle, onBoard }: {
  child: Child; open: boolean; onToggle: () => void; onBoard?: () => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const live = child.items.filter((i) => i.status !== 'done');
  const done = child.items.filter((i) => i.status === 'done');
  const total = child.done + child.flight + child.todo;
  const pct = Math.round((child.done / total) * 100);

  return (
    <>
      <div className={`pl-childrow${open ? ' open' : ''}`} onClick={onToggle}>
        <span className="pl-caret">{open ? '▾' : '▸'}</span>
        <span className="tick" />
        <span className="nm">{child.name}</span>
        <span className="bar"><SegBar counts={child} child /></span>
        <span className="of">{child.done}/{total}</span>
        <span className="pct">{pct}%</span>
      </div>

      {open && (
        <div className="pl-childbody">
          <div className="head">
            <span className="eyebrow">{live.length ? `${live.length} open` : 'nothing open'}</span>
            {/* THE KIT'S FILTER CANNOT COME ACROSS — the board is a mockup with
                nothing to narrow — so this goes to the board and stops there. */}
            <button className="pl-linkbtn" onClick={(e) => { e.stopPropagation(); onBoard?.(); }}>
              See on board <KitIcon name="arrow-up-right" size={12} />
            </button>
          </div>

          {live.map((it) => <ItemRow key={it.id} item={it} />)}

          {done.length > 0 && (
            <>
              <button className={`pl-donefold${live.length ? ' ruled' : ''}`}
                onClick={(e) => { e.stopPropagation(); setShowDone(!showDone); }} aria-expanded={showDone}>
                <span className="pl-caret">{showDone ? '▾' : '▸'}</span>
                <span className="dot" />
                {done.length} closed
              </button>
              {showDone && done.map((it) => <ItemRow key={it.id} item={it} />)}
            </>
          )}
        </div>
      )}
    </>
  );
}

function ItemRow({ item }: { item: PlanItem }) {
  const st = STATUS_META[item.status];
  return (
    <div className={`pl-itemrow${item.status === 'done' ? ' closed' : ''}`}>
      <span className={`pl-kind ${item.kind}`}>
        <KitIcon name={item.kind === 'idea' ? 'bookmark' : 'circle-check'} size={12} />
      </span>
      <span className="id">{item.id}</span>
      <span className="t">{item.title}</span>
      <span className={`glyph ${PRI_LEVEL[item.priority]}`} title={item.priority}>{PRI_GLYPH[item.priority]}</span>
      <span className="pts">{item.pts}</span>
      <span className="tag"><span className={`k-tag ${st.tone}`}>{st.label}</span></span>
    </div>
  );
}

function AreaDetail({ area }: { area: Area }) {
  const pct = Math.round((area.done / area.total) * 100);
  const gained = area.trend[area.trend.length - 1] - area.trend[area.trend.length - 2];
  return (
    <section className="pl-panel pl-areadetail">
      <div className="ttl">
        <span className="eyebrow">Selected area</span>
        <span className="nm">{area.name}</span>
      </div>

      <div className="fig">
        <span className={`pct${pct === 100 ? ' full' : ''}`}>{pct}%</span>
        <span className="cap">{area.done} of {area.total} closed</span>
        <span className={`gain${gained > 0 ? ' up' : ''}`}>{gained > 0 ? `+${gained}` : '0'} this week</span>
      </div>

      <SegBar counts={area} />

      <div className="legend">
        {SEG.map((s) => (
          <div className="row" key={s.key}>
            <span className={`dot seg-${s.key}`} />
            <span className="l">{s.label}</span>
            <span className="n">{area[s.key]}</span>
          </div>
        ))}
      </div>

      <div className="block">
        <span className="eyebrow">Next up</span>
        <span className="next">
          {area.nextId && <span className="id">{area.nextId}</span>}
          <span className="t">{area.next}</span>
        </span>
      </div>

      {area.ideas.length > 0 && (
        <div className="block">
          <div className="blockhead">
            <span className="eyebrow">Ideas not in the plan</span>
            <span className="n">{area.ideas.length}</span>
          </div>
          {area.ideas.map((idea) => (
            <div className="idea" key={idea.id}>
              <span className={`dot state-${idea.state.toLowerCase()}`} />
              <span className="t">{idea.title}</span>
              <span className="eff">{idea.effort}</span>
            </div>
          ))}
          <span className="foot">These do not count toward completion until they become work items.</span>
        </div>
      )}

      <div className="acts">
        <button className="k-btn sm secondary">Open in timeline<KitIcon name="arrow-up-right" size={13} /></button>
        <button className="k-btn sm ghost">Roadmap</button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Calendar */

function CalendarView() {
  return (
    <div className="pl-view">
      <div className="pl-toolbar">
        <span className="pl-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search calendar" aria-label="Search calendar" />
        </span>
        {['Area', 'Type', 'Status', 'More filters'].map((f) => (
          <button className="k-btn sm secondary" key={f}>{f}<Caret /></button>
        ))}
        <span className="right">
          <button className="k-btn sm secondary">Today</button>
          <span className="pl-monthnav">
            <span className="arw" aria-hidden="true">‹</span>Sep 2026<span className="arw" aria-hidden="true">›</span>
          </span>
          <button className="k-btn sm secondary">Month<Caret /></button>
        </span>
      </div>

      <div className="pl-cal">
        <div className="pl-caldays">
          {DAY_NAMES.map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="pl-calgrid">
          {Array.from({ length: 35 }, (_, i) => {
            const inMonth = i >= 1 && i <= 30;
            const label = i === 0 ? 'Aug 31' : i === 1 ? 'Sep 1' : i <= 30 ? String(i) : `Oct ${i - 30}`;
            const events = inMonth ? CAL_EVENTS[i] ?? [] : [];
            return (
              <div className={`pl-calcell${inMonth ? '' : ' out'}`} key={i}>
                <span className={`d${i === TODAY ? ' today' : ''}`}>{label}</span>
                {events.map((e) => (
                  <div className={`pl-calev tone-${e.tone}`} key={e.id + e.title}>
                    <span className={`pl-kind ${e.kind}`}>
                      <KitIcon name={e.kind === 'idea' ? 'bookmark' : 'circle-check'} size={11} />
                    </span>
                    <span className="id">{e.id}</span>
                    <span className="t">{e.title}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Releases */

function ReleasesView() {
  const [open, setOpen] = useState<string | null>('tokens-v1.5');
  return (
    <div className="pl-view">
      <div className="pl-viewbar">
        <span className="pl-saved">Three releases · one in flight</span>
        <button className="k-btn sm secondary"><KitIcon name="plus" size={13} />New release</button>
      </div>

      {RELEASES.map((r) => {
        const on = open === r.name;
        const total = r.done + r.flight + r.todo || 1;
        return (
          <section className="pl-panel pl-release" key={r.name}>
            <header className="pl-relhead" onClick={() => setOpen(on ? null : r.name)}>
              <span className="pl-caret">{on ? '▾' : '▸'}</span>
              <span className="mark"><KitIcon name="bookmark" size={14} /></span>
              <span className="nm">{r.name}</span>
              <span className="when">{r.date}</span>
              <span className="right">
                <SplitBar counts={{ done: r.done, flight: r.flight, todo: r.todo }} />
                <span className="pct">{Math.round((r.done / total) * 100)}%</span>
                <span className={`k-tag ${r.tone}`}>{r.state}</span>
              </span>
            </header>
            {on && (
              <div className="pl-relbody">
                {r.items.map((it) => (
                  <div className="row" key={it.id}>
                    <span className="id">{it.id}</span>
                    <span className="t">{it.title}</span>
                    <span className={`k-tag ${STATUS_META[it.state].tone}`}>{STATUS_META[it.state].label}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ Dependencies */

function DependenciesView() {
  return (
    <div className="pl-view">
      <div className="pl-toolbar wrap">
        {['Roll-up to', 'Group by', 'Area', 'Release', 'Work item', 'Link type'].map((f) => (
          <button className="k-btn sm secondary" key={f}>{f}<Caret /></button>
        ))}
      </div>
      <div className="pl-deps">
        {LINKS.map((l) => (
          <div className="pl-deprow" key={l.from.id}>
            <DepCard node={l.from} highlight />
            <div className="pl-deplink">
              <span className="rule" />
              <span className="rel">{l.rel}</span>
              <span className="rule" />
              <span className="arrow" aria-hidden="true">▶</span>
            </div>
            <DepCard node={l.to} />
          </div>
        ))}
      </div>
    </div>
  );
}

function DepCard({ node, highlight }: { node: DepNode; highlight?: boolean }) {
  return (
    <section className={`pl-depcard${highlight ? ' on' : ''}`}>
      <div className="top">
        <span className={`pl-kind ${node.kind}`}>
          <KitIcon name={node.kind === 'idea' ? 'bookmark' : 'circle-check'} size={14} />
        </span>
        <span className="id">{node.id}</span>
        <button className="k-iconbtn sm" aria-label={`Actions for ${node.id}`}><KitIcon name="ellipsis" size={14} /></button>
      </div>
      <span className="t">{node.title}</span>
      <div className="dates">
        <span className="f"><span className="l">Start date</span><span className="v">{node.start}</span></span>
        <span className="f"><span className="l">End date</span><span className="v">{node.end}</span></span>
        <span className={`k-tag ${node.tone}`}>{node.state}</span>
      </div>
    </section>
  );
}
