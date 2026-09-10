// THE PLANS TAB — TWO WIRED SUB-VIEWS AND FOUR MOCKUPS, and which is which is
// said on the sub-tab itself.
//
// `ui_kits/console/PlansScreen.jsx` came across whole in #451, all six views on
// the kit's own sample rows (KING-07 … ATL-12). #482 wires the two that carry
// the tab — TIMELINE, which is the order the night actually works in, and
// CALENDAR, which is when the sprints run. Summary, Progress, Releases and
// Dependencies still draw the kit's rows and each wears a MOCK CHIP ON ITS OWN
// SUB-TAB. The rail's chip came off with this: the tab opens on Timeline, and a
// "Mock" label over a wired default view breaks the "a number and the screen
// behind it must agree" rule from the other side.
//
// THE GROUPING IS THE SPRINT, NOT THE AREA, and it is the one thing the port
// could not carry across. The kit groups its timeline by space and its progress
// by area; in Stack `area` is the OVERNIGHT LANE (#267) — `(project, area)`
// admits one worker at a time — so grouping the plan by it would draw the
// collision domain and call it the plan. What ranks work here is the SPRINT
// (#477): one group per box in board order, the backlog underneath, and inside
// a box the rows sit in `sprintRank` order because that IS the priority, top
// first. The `#` column therefore means something only inside a sprint, and its
// tooltip is what says so — the same distinction `BacklogRow` draws in
// Board.tsx, for the same reason.
//
// WHAT IT DRAWS IS COMMITTED WORK — `!isIdea` (#472), the board's own
// population. A held hook/fly row and a child idea are on Roadmap and are in
// nobody's plan yet; drawing them here would put one row on three screens.
//
// EVERY STATUS IS DERIVED, AND NOTHING ON THIS SCREEN WRITES. The kit's status
// cell is a dropdown that sets a row's state; Stack has no such column —
// `listKeyOf` is the client's one derivation (done / built-and-unverdicted /
// claimed / not started) and it is read off the row. So the cell is a TAG and
// not a button: the menu came out rather than being wired to a write it cannot
// make. Same call the toolbar's four filter buttons and the dead Timeline/List
// segmented control got — a press that moves nothing is indistinguishable from
// a broken app, which is what the smoke reports it as.
//
// THE STORED SCHEDULE HAS A READER AGAIN. `sched` (#401, MINUTES from week
// zero) lost its last one when #451 replaced the real Plans tab with this
// mockup. Both date columns render it through `dateAt(weekZero)`, and the
// calendar puts a scheduled row on every day it covers. An item with no bar
// reads as an em dash — UNSCHEDULED, which is a real state and is not "today".
// Nothing here EDITS one: the timeline drag went with #428 and has not come
// back, so the four packages that must agree on the unit still have no browser
// depending on them agreeing.
//
// THE CALENDAR IS A REAL MONTH, and the kit's off-by-one went with the sample
// data that carried it. Two things about it are decisions:
//
//  • IT BUILDS ITS OWN GRID rather than calling `calendarMonths` in lib/plan.ts,
//    which is the obvious reuse and is the wrong shape here. That helper is
//    keyed on WEEK-ZERO MINUTES, and a sprint window is a bare `YYYY-MM-DD` day
//    with no week zero anywhere in it (`Sprint.startsOn` — a day somebody named,
//    never an instant). The two populations have to share a cell, so the cell
//    has to be a real date. Its rule is kept though: a bar is drawn on EVERY day
//    it covers, because a fortnight-long box drawn once is a month claiming
//    thirteen free days.
//  • THE WINDOW IT DRAWS IS THE PLANNED ONE, falling back to when the sprint
//    ACTUALLY RAN (`startedAt`/`endedAt`). Neither pair substitutes for the
//    other and the row says which it is showing, because "planned for next
//    week" and "ran last week" are different claims. A sprint with neither is
//    UNDATED and is listed under the grid rather than dropped — a box with no
//    window is the common case, and a calendar that silently omits it is a
//    calendar that hides the sprint in progress.

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { KitIcon, type KitIconName } from './kit/KitIcon';
import type { RoadmapItem, Sprint } from '../types';
import { dateAt, fmtDate, isBuilt, isIdea, listKeyOf } from '../lib/plan';

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

const STATUS_META: Record<StatusKey, { label: string; tone: Tone }> = {
  todo: { label: 'To do', tone: 'neutral' },
  progress: { label: 'In progress', tone: 'info' },
  review: { label: 'In review', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
};

// Priority is a ROLE here, never a colour: `.pl-pri` carries the rule's tone in
// styles.css, keyed off the level. Same rule the severity vocabulary follows on
// Quality — a component names the level, styles.css owns the tone.
const PRIORITY: Record<PriKey, string> = {
  highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Lowest',
};
const PRI_GLYPH: Record<PriKey, string> = {
  highest: '⌃⌃', high: '⌃', medium: '=', low: '⌄', lowest: '⌄⌄',
};
const PRI_LEVEL: Record<PriKey, 'hi' | 'med' | 'lo'> = {
  highest: 'hi', high: 'hi', medium: 'med', low: 'lo', lowest: 'lo',
};

/* ------------------------------------------------- what a plan row reads off */

/**
 * A ROW'S STATUS, DERIVED — the client has exactly one derivation and this is a
 * translation of it, not a second one. `listKeyOf` (lib/plan.ts) is the twin of
 * `listFor` on the server and already answers the question the kit's four
 * statuses ask; the map below is only the kit's spelling of its four answers.
 *
 * A row whose `listKey` was set by hand falls through to 'todo' rather than to
 * nothing: the board may carry lanes this screen has no column for (#428 lets
 * every lane be renamed and new ones added), and a status cell rendering blank
 * is worse than one rendering the honest floor.
 */
const STATUS_OF: Record<string, StatusKey> = {
  shipped: 'done', review: 'review', progress: 'progress', planned: 'todo',
};
const statusOf = (it: RoadmapItem): StatusKey => STATUS_OF[listKeyOf(it)] ?? 'todo';

/**
 * HOW FAR ALONG A ROW IS, AND NEVER A GUESS. An implementation plan (#75) is a
 * real denominator — steps ticked over steps — and it is the only one a roadmap
 * row carries. Without one the honest answers are 0 and 100 and nothing in
 * between, so a half-finished row with no plan reads as 0 here, which is
 * exactly what the board says about it. The alternative — 50% for "claimed" —
 * is a number the app would be inventing, and the meter draws it as if it had
 * been measured.
 */
function progressOf(it: RoadmapItem): number {
  if (isBuilt(it) || it.done) return 100;
  if (it.plan.length) {
    return Math.round((it.plan.filter((s) => s.done).length / it.plan.length) * 100);
  }
  return 0;
}

/** The scheduled bar as two days, or nulls. UNSCHEDULED is a real state (#401). */
function schedDays(it: RoadmapItem, weekZero: string | null): { start: string | null; due: string | null } {
  if (!it.sched || !weekZero) return { start: null, due: null };
  const from = dateAt(it.sched.start, weekZero);
  const to = dateAt(it.sched.start + it.sched.len, weekZero);
  return { start: from ? fmtDate(from) : null, due: to ? fmtDate(to) : null };
}

/**
 * THE VERDICT CELL, which is what the kit's "Checks" column became. Stack has
 * no per-item check result to put there — `check_results` answers to a SUITE
 * and a suite is the project's, not a row's — so a column headed Checks would
 * have had to be filled with something, and the something available is the one
 * thing a plan actually waits on: whether a built row has been judged yet.
 *
 * A MACHINE VERDICT SAYS IT IS ONE (#263). `verdictSource` is a third of that
 * decision's third leg and the board is the only other screen that reads it.
 */
function verdictOf(it: RoadmapItem): { label: string; tone: Tone } | null {
  const tag = it.reviewTag.trim();
  if (tag) {
    const tone: Tone = tag === 'solid' ? 'success' : tag === 'rethink' ? 'warning' : 'info';
    return { label: it.verdictSource === 'auto' ? `${tag} · auto` : tag, tone };
  }
  if (isBuilt(it)) return { label: 'awaiting verdict', tone: 'warning' };
  return null;
}

/**
 * ONE PLAN GROUP: a sprint and the rows committed to it, or the backlog.
 *
 * The boxes arrive in the payload's own board order (planned and active first,
 * finished newest-first — `routes/sprints.js`), and a sprint with NO rows is
 * still drawn. An empty box is a decision somebody made and has not filled yet;
 * dropping it would make a new sprint invisible on the screen whose whole job
 * is showing what is committed to.
 */
type PlanGroup = {
  key: string; sprint: Sprint | null;
  /** EVERY row committed to this box, filter or no filter. */
  rows: RoadmapItem[];
  /** The subset the toolbar leaves visible — what the group actually draws. */
  shown: RoadmapItem[];
};

/**
 * A FILTER NARROWS WHAT IS DRAWN, NEVER WHAT THE BOX CONTAINS. The group row's
 * count and meter are facts about the SPRINT and are measured over `rows`; only
 * the list under it is `shown`. The board does the same thing one tab across and
 * for the same reason — its lane holder is read off every row, so a hidden
 * parked row is still the holder it really is — and the inverse is a sprint that
 * reads as 0% built because somebody pressed "hide built", which is the "a
 * number and the screen behind it must agree" rule broken by a view control.
 */
function groupBySprint(items: RoadmapItem[], sprints: Sprint[], keep: (it: RoadmapItem) => boolean): PlanGroup[] {
  const byBox = new Map<number, RoadmapItem[]>();
  const loose: RoadmapItem[] = [];
  for (const it of items) {
    if (it.sprintId == null) { loose.push(it); continue; }
    const bag = byBox.get(it.sprintId);
    if (bag) bag.push(it); else byBox.set(it.sprintId, [it]);
  }
  // Inside a box, `sprintRank` IS the order — dense, 0 at the top, and the order
  // the night works in. The backlog keeps the payload's own order instead
  // (bucket, then position), because a backlog rank is a default nobody set.
  for (const bag of byBox.values()) bag.sort((a, b) => a.sprintRank - b.sprintRank || a.id - b.id);
  const out: PlanGroup[] = sprints.map((s) => {
    const rows = byBox.get(s.id) ?? [];
    return { key: `s${s.id}`, sprint: s, rows, shown: rows.filter(keep) };
  });
  out.push({ key: 'backlog', sprint: null, rows: loose, shown: loose.filter(keep) });
  return out;
}

/** What a group's meter measures: rows BUILT over rows in the box (#374). */
const builtShare = (rows: RoadmapItem[]): number =>
  (rows.length ? Math.round((rows.filter(isBuilt).length / rows.length) * 100) : 0);

const SPRINT_TONE: Record<Sprint['status'], Tone> = {
  active: 'info', planned: 'neutral', done: 'success',
};
const SPRINT_LABEL: Record<Sprint['status'], string> = {
  active: 'In progress', planned: 'Planned', done: 'Finished',
};

/**
 * THE WINDOW A SPRINT IS DRAWN ON, and which of the two it is.
 *
 * `startsOn`/`endsOn` is the PLANNED window the owner set — bare days, never
 * instants. `startedAt`/`endedAt` is when it actually ran. The planned window
 * wins where there is one and the fallback is labelled, because "planned for
 * next week" and "ran last week" are different claims about the same box and a
 * calendar that renders them identically is lying about one of them.
 *
 * A running sprint with no planned window is open-ended: it started and has not
 * finished, so its band runs to TODAY and stops, rather than to a date nobody
 * has set.
 */
type Window = { from: string; to: string; planned: boolean } | null;

function windowOf(s: Sprint, today: string): Window {
  if (s.startsOn) return { from: s.startsOn, to: s.endsOn || s.startsOn, planned: true };
  if (s.startedAt) {
    const from = s.startedAt.slice(0, 10);
    const to = s.endedAt ? s.endedAt.slice(0, 10) : (today > from ? today : from);
    return { from, to, planned: false };
  }
  return null;
}

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

// The grid is Monday-first and built from real days, so every helper below
// works in BARE `YYYY-MM-DD` STRINGS rather than instants — a sprint boundary
// is a day somebody named, and giving it a time zone slides it by one for half
// the world (`dayOf` in server/src/shape.js caught exactly that on this side of
// the wire; this is the same rule on the other).
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_LONG = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A UTC date as the day it is. Never `toISOString` on a local-midnight Date. */
const dayKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * THE CELLS OF ONE MONTH, Monday-first and always whole weeks. `lead` is how
 * many days of the previous month open the grid; the trailing days of the next
 * one close it, and both are drawn (dimmed) rather than left blank so a bar
 * crossing a month boundary does not appear to stop at the edge of the screen.
 */
function monthCells(anchor: Date): { key: string; date: Date; inMonth: boolean }[] {
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const weeks = Math.ceil((lead + dim) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 - lead + i));
    return { key: dayKey(date), date, inMonth: date.getUTCMonth() === first.getUTCMonth() };
  });
}


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

/**
 * The four sub-views still drawing the kit's own sample rows. The chip is on
 * the SUB-TAB rather than the rail, because two of the six are real now and a
 * warning that covers all six is a warning about the wrong thing.
 */
const MOCK_SUBS = new Set<SubTab>(['summary', 'progress', 'releases', 'dependencies']);

export function Plans({ items, sprints, weekZero, onBoard }: {
  /** EVERY roadmap row, in the payload's own order — the same flattened list the
   *  board and Roadmap take. This screen keeps the committed half (`!isIdea`). */
  items: RoadmapItem[];
  /** The project's sprints, in board order, off the same payload (#477). */
  sprints: Sprint[];
  /** The project's week zero — what `sched` counts minutes from. null = the
   *  schedule cannot be rendered as dates at all, which is why `schedDays`
   *  answers nulls rather than throwing. */
  weekZero: string | null;
  onBoard?: () => void;
}) {
  const [sub, setSub] = useState<SubTab>('timeline');

  // COMMITTED WORK ONLY (#472), and archived rows are neither surface's. Done
  // once here so the two wired views cannot disagree about their population.
  const plan = useMemo(() => items.filter((it) => !isIdea(it) && !it.archived), [items]);

  return (
    <div className="pl">
      <div className="pl-head">
        <span className="pl-crumb">Plans and progress</span>
        <div className="pl-headrow">
          <span className="mark"><KitIcon name="list" size={16} /></span>
          <h1>Plans</h1>
          <span className="acts">
            {/* The one number in the header, and it is the real one: how much
                of the plan is committed to a box at all. */}
            <span className="k-tag">{plan.filter((it) => it.sprintId != null).length} of {plan.length} in a sprint</span>
          </span>
        </div>

        <div className="k-tabs pl-tabs">
          {SUBTABS.map((t) => (
            <button key={t.value} className={`k-tab${sub === t.value ? ' on' : ''}`} onClick={() => setSub(t.value)}>
              <KitIcon name={t.icon} size={14} />{t.label}
              {MOCK_SUBS.has(t.value) && (
                <span className="con-navsoon mock" title="A mockup — the console kit's own sample rows. It reads and writes nothing.">Mock</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {sub === 'summary' && <SummaryView />}
      {sub === 'progress' && <ProgressView onBoard={onBoard} />}
      {sub === 'timeline' && <TimelineView rows={plan} sprints={sprints} weekZero={weekZero} />}
      {sub === 'calendar' && <CalendarView rows={plan} sprints={sprints} weekZero={weekZero} />}
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

function TimelineView({ rows, sprints, weekZero }: {
  rows: RoadmapItem[]; sprints: Sprint[]; weekZero: string | null;
}) {
  const [find, setFind] = useState('');
  const [hideBuilt, setHideBuilt] = useState(false);
  const [shut, setShut] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);

  // The two toolbar controls are FILTERS OVER THE ROWS, never over the boxes: a
  // sprint whose every row is filtered out still draws, with its own count
  // saying what it really holds. Hiding the box would make a search read as
  // "this sprint is empty", which is the one thing this screen must not say.
  const groups = useMemo(() => {
    const needle = find.trim().toLowerCase();
    return groupBySprint(rows, sprints, (it) => {
      if (hideBuilt && isBuilt(it)) return false;
      if (!needle) return true;
      return it.title.toLowerCase().includes(needle) || String(it.id).includes(needle);
    });
  }, [rows, sprints, find, hideBuilt]);

  const shown = groups.reduce((n, g) => n + g.shown.length, 0);
  const filtered = shown !== rows.length;

  return (
    <>
      <div className="pl-toolbar">
        <span className="pl-search">
          <KitIcon name="search" size={14} />
          <input placeholder="Search the plan" aria-label="Search the plan"
            value={find} onChange={(e) => setFind(e.target.value)} />
        </span>
        {/* A LABEL, NOT A MENU. The kit offers "Group: Area" and three more
            filter buttons; the grouping here is the sprint and there is nothing
            else it could honestly be, so this says what the screen is doing
            rather than offering a choice that resolves to one option. */}
        <span className="k-tag"><KitIcon name="layers" size={13} />Grouped by sprint</span>
        <button className="k-btn sm secondary"
          aria-pressed={hideBuilt} onClick={() => setHideBuilt(!hideBuilt)}
          title="Built rows are finished work still waiting on a verdict — they stay in their sprint (#477)">
          <KitIcon name="check" size={14} />{hideBuilt ? 'Built hidden' : 'Built shown'}
        </button>
        <span className="right">
          <span className="pl-saved">{shown} of {rows.length} work items</span>
        </span>
      </div>

      <div className="pl-scroll">
        <div className="pl-grid">
          <div className="pl-row head">
            <span className="c-check" />
            <span className="c-n" title="Inside a sprint this is the order the night works in">#</span>
            <span className="c-item">Work item</span>
            <span className="c-status">Status</span>
            <span className="c-branch">Branch</span>
            <span className="c-date">Start<span className="pl-coltag">D</span></span>
            <span className="c-date">Due<span className="pl-coltag">D</span></span>
            <span className="c-pri">Priority</span>
            <span className="c-prog">Progress</span>
            <span className="c-checks">Verdict</span>
            <span className="c-flag" title="Risk (#212) — a low-risk row whose run lands green merges itself">⚑</span>
          </div>

          {groups.map((g) => {
            const open = !shut.includes(g.key);
            const win = g.sprint ? windowOf(g.sprint, dayKey(new Date())) : null;
            return (
              <div className="pl-group" key={g.key}>
                <div className="pl-row group">
                  <span className="c-check">
                    <button className="pl-fold" aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${g.sprint ? g.sprint.name : 'the backlog'}`}
                      onClick={() => setShut(open ? [...shut, g.key] : shut.filter((k) => k !== g.key))}>
                      <span className="pl-caret">{open ? '▾' : '▸'}</span>
                    </button>
                  </span>
                  <span className="c-groupname">
                    <span className="glyph"><KitIcon name="layers" size={11} /></span>
                    <span className="nm">{g.sprint ? g.sprint.name : 'Backlog'}</span>
                  </span>
                  <span className="c-status">
                    {g.sprint
                      ? <span className={`k-tag ${SPRINT_TONE[g.sprint.status]}`}>{SPRINT_LABEL[g.sprint.status]}</span>
                      : <span className="k-tag" title="Not in any sprint — the automation never touches these (#477)">Not committed</span>}
                  </span>
                  {/* What the BOX holds, with the filtered count only where the
                      two differ — "4 items" when nothing is hidden, "1 of 4"
                      when something is. */}
                  <span className="c-branch mono" title={filtered ? 'Showing / in this sprint' : ''}>
                    {filtered ? `${g.shown.length} of ${g.rows.length}` : `${g.rows.length} item${g.rows.length === 1 ? '' : 's'}`}
                  </span>
                  {/* The sprint's own window, on the two date columns the rows
                      use for theirs. Undated is an em dash on both. */}
                  <span className="c-date mono">{win ? win.from.slice(5) : <span className="pl-dash">—</span>}</span>
                  <span className="c-date mono strong">{win ? win.to.slice(5) : <span className="pl-dash">—</span>}</span>
                  <span className="c-pri">{win && !win.planned ? 'ran' : win ? 'planned' : ''}</span>
                  <span className="c-prog"><Meter value={builtShare(g.rows)} /></span>
                  <span className="c-checks" />
                  <span className="c-flag" />
                </div>

                {/* THE RANK IS THE ROW'S OWN, NEVER ITS INDEX IN THE FILTERED
                    LIST. Inside a sprint it is `sprintRank` + 1 — dense, 0 at
                    the top, the order the night works in — so hiding a row can
                    never renumber the ones left. The backlog has no such number,
                    so it counts its own full list and the tooltip says the
                    number means nothing. */}
                {open && g.shown.map((r) => (
                  <TimelineRowView key={r.id} row={r} inSprint={g.sprint !== null}
                    rank={g.sprint ? r.sprintRank + 1 : g.rows.indexOf(r) + 1}
                    weekZero={weekZero}
                    cursor={cursor === r.id} onFocus={() => setCursor(r.id)} />
                ))}
                {open && g.shown.length === 0 && (
                  <div className="pl-subrow">
                    <span className="c-check" />
                    <span className="c-item">
                      {g.rows.length > 0
                        ? `All ${g.rows.length} filtered out.`
                        : g.sprint
                          ? 'Nothing committed to this sprint yet — the board’s Backlog view is where a row is dragged in.'
                          : 'Every work item is in a sprint.'}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function TimelineRowView({ row, rank, inSprint, weekZero, cursor, onFocus }: {
  row: RoadmapItem;
  /** 1-based place in the group. Inside a sprint that IS the priority; in the
   *  backlog it is a row count and claims nothing — same distinction the
   *  board's own backlog row draws, and the tooltip is what carries it. */
  rank: number;
  inSprint: boolean;
  weekZero: string | null;
  cursor: boolean;
  onFocus: () => void;
}) {
  const st = STATUS_META[statusOf(row)];
  const when = schedDays(row, weekZero);
  const verdict = verdictOf(row);
  const built = isBuilt(row);

  return (
    <div className={`pl-row${cursor ? ' cursor' : ''}`} onClick={onFocus} data-hl={row.id}>
      <span className="c-check" />
      <span className="c-n mono" title={inSprint
        ? `${rank} in this sprint — the runner works top down`
        : 'A place in the backlog listing, not a priority'}>{rank}</span>
      <span className="c-item">
        <span className={`pl-kind ${built ? 'task' : 'idea'}`}>
          <KitIcon name={built ? 'circle-check' : 'list'} size={14} />
        </span>
        <span className="id">#{row.id}</span>
        <span className="t" title={row.title}>{row.title}</span>
      </span>

      <span className="c-status">
        <span className={`k-tag ${st.tone}`}>{st.label}</span>
      </span>

      <span className="c-branch">
        {row.claimedBy.trim()
          ? <span className="br" title={`Claimed by ${row.claimedBy} (#277)`}>
              <KitIcon name="git-branch" size={12} /><span className="mono">{row.claimedBy}</span>
            </span>
          : <span className="pl-dash">—</span>}
      </span>
      <span className="c-date mono">{when.start ?? <span className="pl-dash">—</span>}</span>
      <span className="c-date mono">{when.due ?? <span className="pl-dash">—</span>}</span>
      <span className="c-pri">
        <span className={`pl-pri ${PRI_LEVEL[row.bucket]}`} />
        {PRIORITY[row.bucket]}
      </span>
      <span className="c-prog"><Meter value={progressOf(row)} /></span>
      <span className="c-checks">
        {verdict && <span className={`k-tag ${verdict.tone}`}>{verdict.label}</span>}
      </span>
      <span className="c-flag">
        {row.risk !== 'normal' && (
          <span className={`pl-risk ${row.risk}`}
            title={row.risk === 'low'
              ? `Low risk${row.riskReason ? ` — ${row.riskReason}` : ''} — a green run on this merges itself (#212)`
              : `High risk${row.riskReason ? ` — ${row.riskReason}` : ''} — a wrong build here is expensive`} />
        )}
      </span>
    </div>
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

function CalendarView({ rows, sprints, weekZero }: {
  rows: RoadmapItem[]; sprints: Sprint[]; weekZero: string | null;
}) {
  const today = dayKey(new Date());
  // The month on screen, as an offset from this one. An offset rather than a
  // Date so "Today" is a reset to zero and cannot drift.
  const [off, setOff] = useState(0);
  const anchor = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + off, 1));
  }, [off]);
  const cells = useMemo(() => monthCells(anchor), [anchor]);

  // THE BANDS. Each sprint with a window becomes one entry per day it covers,
  // and only the first day of the band OR the first day of a week row carries
  // the name — that is what makes fourteen cells read as one bar rather than as
  // fourteen separate commitments. `head` is that flag.
  const bands = useMemo(() => {
    const map = new Map<string, { sprint: Sprint; planned: boolean; start: boolean; end: boolean }[]>();
    for (const s of sprints) {
      const win = windowOf(s, today);
      if (!win) continue;
      for (const c of cells) {
        if (c.key < win.from || c.key > win.to) continue;
        const bag = map.get(c.key) ?? [];
        bag.push({ sprint: s, planned: win.planned, start: c.key === win.from, end: c.key === win.to });
        map.set(c.key, bag);
      }
    }
    return map;
  }, [sprints, cells, today]);

  // A SCHEDULED ROW IS ON EVERY DAY IT COVERS, not only the day it starts — the
  // rule `calendarMonths` states in lib/plan.ts, and for its reason: a bar shown
  // once over a fortnight is a month claiming thirteen free days.
  const scheduled = useMemo(() => {
    const map = new Map<string, RoadmapItem[]>();
    if (!weekZero) return map;
    for (const it of rows) {
      if (!it.sched) continue;
      const from = dateAt(it.sched.start, weekZero);
      const to = dateAt(it.sched.start + it.sched.len, weekZero);
      if (!from || !to) continue;
      const a = dayKey(from);
      const b = dayKey(to);
      for (const c of cells) {
        if (c.key < a || c.key > b) continue;
        const bag = map.get(c.key) ?? [];
        bag.push(it);
        map.set(c.key, bag);
      }
    }
    return map;
  }, [rows, cells, weekZero]);

  const undated = sprints.filter((s) => !windowOf(s, today));

  return (
    <div className="pl-view">
      <div className="pl-toolbar">
        <span className="pl-saved">
          Each sprint on the days it runs, and every scheduled work item on the days its bar covers.
        </span>
        <span className="right">
          <button className="k-btn sm secondary" onClick={() => setOff(0)} disabled={off === 0}>Today</button>
          <span className="pl-monthnav">
            <button className="arw" aria-label="Previous month" onClick={() => setOff(off - 1)}>‹</button>
            {MONTHS_LONG[anchor.getUTCMonth()]} {anchor.getUTCFullYear()}
            <button className="arw" aria-label="Next month" onClick={() => setOff(off + 1)}>›</button>
          </span>
        </span>
      </div>

      <div className="pl-cal">
        <div className="pl-caldays">
          {DAY_NAMES.map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="pl-calgrid">
          {cells.map((c, i) => {
            const day = c.date.getUTCDate();
            // The 1st of a month says which month it is, so a grid whose edges
            // are another month's days cannot be misread.
            const label = day === 1 ? `${MONTHS_LONG[c.date.getUTCMonth()]} 1` : String(day);
            const onDay = bands.get(c.key) ?? [];
            const work = scheduled.get(c.key) ?? [];
            return (
              <div className={`pl-calcell${c.inMonth ? '' : ' out'}`} key={c.key}>
                <span className={`d${c.key === today ? ' today' : ''}`}>{label}</span>
                {onDay.map((b) => (
                  <div key={b.sprint.id}
                    className={`pl-calband${b.start ? ' start' : ''}${b.end ? ' end' : ''}`
                      + ` st-${b.sprint.status}${b.planned ? '' : ' ran'}`}
                    title={`${b.sprint.name} — ${SPRINT_LABEL[b.sprint.status].toLowerCase()}, ${b.planned ? 'planned window' : 'when it actually ran'}`}>
                    {(b.start || i % 7 === 0) && <span className="nm">{b.sprint.name}</span>}
                  </div>
                ))}
                {work.map((it) => (
                  <div className={`pl-calev tone-${isBuilt(it) ? 'done' : it.claimedBy.trim() ? 'active' : 'idle'}`}
                    key={it.id} title={it.title}>
                    <span className="id">#{it.id}</span>
                    <span className="t">{it.title}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* UNDATED SPRINTS ARE LISTED, NEVER DROPPED. A box with no window is the
          common case — a sprint is a box of work first — and a calendar that
          silently omits the sprint in progress is the worst version of this
          screen. Same rule as a NULL verdict: absence is reported, not hidden. */}
      {undated.length > 0 && (
        <div className="pl-calundated">
          <span className="lbl">Not on the calendar — no dates set:</span>
          {undated.map((s) => (
            <span className={`k-tag ${SPRINT_TONE[s.status]}`} key={s.id}
              title={`${s.name} — ${SPRINT_LABEL[s.status].toLowerCase()}, and no window set. The board's Backlog view is where a sprint's dates are.`}>
              {s.name}
            </span>
          ))}
        </div>
      )}
      {sprints.length === 0 && (
        <div className="pl-calundated">
          <span className="lbl">
            No sprints yet — the board’s Backlog view is where one is opened, and the
            overnight runner does nothing at all until one is in progress (#477).
          </span>
        </div>
      )}
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
      <div className="pl-toolbar">
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
