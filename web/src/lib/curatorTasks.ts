// THE ARRANGE PANEL'S QUICK COMMANDS, as briefs for the Curator's console.
//
// These six were ARITHMETIC until now: pure functions in lib/plan.ts that read
// the rows on screen, returned a list of {id, sched} and let the owner apply or
// discard it. The sums were exact and they were also the whole problem — they
// could only do the six things somebody had written a function for, and each
// one was blind to everything the board did not store. "Close the gaps" could
// not know that two bars it packed together are the same person's week.
//
// So the button no longer computes. It composes an INSTRUCTION and hands it to
// the Curator's own live session on the Roadmap tab (#379/#380), which can read
// the board, read the code, ask you something back and change its mind — the
// things a sum structurally cannot do. What was an answer is now the opening
// move of a conversation.
//
// THIS MODULE IS PURE, and that is deliberate: what gets said to a session that
// can write to the board is exactly the kind of thing that should be readable
// in one place and pinned by a test, not assembled from fragments across a
// render. `scripts/curator-tasks.test.mjs` runs it directly.
//
// TWO RULES EVERY BRIEF FOLLOWS, and both are here rather than in each string
// so that no future command can quietly skip one:
//
//  1. IT NAMES ITS POPULATION. Every command is scoped by the area chip in
//     force, and the brief SAYS which rows it means — an instruction that said
//     "close the gaps" while the owner was looking at one area would be acted
//     on across the whole board, and the diff would arrive in lanes nobody was
//     looking at. `balance` and `trim` are the two that deliberately do not
//     narrow, and each says why in its own line (see ARRANGE_TASKS).
//  2. IT ASKS BEFORE IT WRITES. The owner sanctioned SENDING these (see
//     TabTerminal — the Enter is Stack's on this one path, against the rule in
//     console-prime.js that only a human submits). That licence was for
//     starting the session working; it was not a licence for a session to
//     silently rewrite the plan. So every brief ends by asking for the moves as
//     a list first. The session starts immediately and stops at the write,
//     which is the same shape the ✧ reads have always had: propose, then the
//     human disposes.

/** Which Roadmap view an action belongs to. */
export type ArrangeView = 'timeline' | 'scope' | 'plan';

/** The board state a brief is composed against. */
export interface TaskScope {
  slug: string;
  /** The area chip in force. '' = the whole board; UNALLOCATED = untagged. */
  areaFilter: string;
  /** The bar selected on the timeline — the only thing `trim` can act on. */
  feature: { id: number; title: string } | null;
}

export interface ArrangeTask {
  key: string;
  /** The button's label. */
  name: string;
  /** The sentence under it, when the command is available. */
  note: string;
  views: ArrangeView[];
  /** True for the ones that act on a population the area chip cannot narrow. */
  wide?: boolean;
  /** Needs a bar selected on the timeline. */
  needsFeature?: boolean;
  /**
   * NOT a button of its own — this task is a SECOND WAY to run a job the panel
   * already offers as a ✧ read, drawn inside that read's card. Two top-level
   * buttons called "Sort the unallocated" would be a puzzle, not a choice.
   *
   * It still lives in this catalogue rather than off to one side, because the
   * two properties the tests assert over every task — it names its population,
   * it asks before it writes — are exactly as load-bearing here. A brief kept
   * somewhere else to avoid the list is a brief nothing checks.
   */
  side?: boolean;
  /** The instruction itself. */
  brief: (s: TaskScope) => string;
}

/** The client's sentinel for "carrying no area" — lib/plan.ts owns the why. */
const UNALLOCATED = 'UNALLOCATED';

/** How the brief refers to the rows in scope. */
export function scopeLine(areaFilter: string): string {
  if (areaFilter === '') return 'Work the whole board.';
  if (areaFilter === UNALLOCATED) {
    return 'Work ONLY the items carrying no area at all — I am filtered to Unallocated, and items that have an area are out of scope.';
  }
  return `Work ONLY the items in the "${areaFilter}" area — I am filtered to it, and items in other areas are out of scope.`;
}

/** The closing rule, on every brief. See the header: sent is not applied. */
export const ASK_FIRST =
  'Show me the moves as a short numbered list — item, from, to — and ask before you write anything. '
  + 'Apply them with PATCH /api/projects/{slug}/roadmap/:id once I say go.';

const close = (s: TaskScope) => `${scopeLine(s.areaFilter)}\n\n${ASK_FIRST.replace('{slug}', s.slug)}`;

export const ARRANGE_TASKS: ArrangeTask[] = [
  {
    key: 'schedule',
    name: 'Schedule what is committed',
    note: 'Puts every unscheduled Must and Should onto its own area lane, after the last bar there.',
    views: ['timeline'],
    brief: (s) => 'Schedule what is committed on the timeline.\n\n'
      + 'Every Must and Should that has no schedule should get one: put it on its own area\'s lane, '
      + 'starting after the last bar already in that lane, and give it a length from its estimate '
      + '(two weeks when it has none). Leave done, parked and Won\'t items alone, and never schedule '
      + 'anything earlier than the current week.\n\n'
      + close(s),
  },
  {
    key: 'compact',
    name: 'Close the gaps',
    note: 'Pulls planned bars earlier so no lane sits idle. Finished work never moves.',
    views: ['timeline'],
    brief: (s) => 'Close the gaps on the timeline.\n\n'
      + 'Pull planned bars earlier so no lane sits idle between them, keeping each lane\'s order. '
      + 'Finished work never moves, nothing moves earlier than the current week, and no bar changes '
      + 'length — this is about when things start, not how long they take.\n\n'
      + close(s),
  },
  {
    key: 'catchup',
    name: 'Catch up the past',
    note: 'Moves bars that should have finished before now up to now — they slipped and the chart still says they did not.',
    views: ['timeline'],
    brief: (s) => 'Catch up the past on the timeline.\n\n'
      + 'Find the bars scheduled to finish before the current week that are not done: they slipped, '
      + 'and the chart is still drawing them as if they had not. Move each to start now, keeping its '
      + 'length. Anything already done stays where it is — that is the record of when it happened.\n\n'
      + close(s),
  },
  {
    key: 'balance',
    name: 'Level the lanes',
    // The area chip cannot scope this one: levelling MOVES work between areas,
    // so a single area is not a population it can work on at all.
    note: 'Hands unclaimed bars from the busiest area to the emptiest. Claimed work never moves.',
    views: ['timeline'],
    wide: true,
    brief: (s) => 'Level the lanes on the timeline.\n\n'
      + 'Compare how much scheduled work each area is carrying and hand unclaimed bars from the '
      + 'busiest to the emptiest until the load is even. A bar with a branch claim never moves — '
      + 'somebody is on it. Changing an item\'s AREA is the point here, so say clearly which items '
      + 'would change area and to what.\n\n'
      + 'This one reads every area, not just the one I am filtered to: levelling between areas needs '
      + 'more than one area to look at.\n\n'
      + ASK_FIRST.replace('{slug}', s.slug),
  },
  {
    key: 'tier',
    name: 'Lead with the tier',
    note: 'Reorders each lane so it runs S, A, B, C — the same sort the run queue uses.',
    views: ['timeline'],
    brief: (s) => 'Lead with the tier on the timeline.\n\n'
      + 'Within each area\'s lane, reorder the bars so the lane runs S, A, B, C, with unranked last — '
      + 'the same sort the run queue uses. Keep the same set of start weeks the lane already occupies '
      + 'and swap which item sits in each, so the lane\'s total span does not change. This is an '
      + 'order, not a reschedule, and it never changes an item\'s tier: that field is mine.\n\n'
      + close(s),
  },
  {
    key: 'trim',
    name: 'Fit the cycle',
    note: 'Defers Coulds, then Shoulds, until the selected feature fits its cycle. Musts are never cut.',
    views: ['timeline', 'scope'],
    // Reads every line of the feature whatever the chip says: a scope total
    // missing the lines in other areas would "fit" by not counting them.
    wide: true,
    needsFeature: true,
    brief: (s) => `Fit the cycle for "${s.feature?.title ?? 'the selected feature'}" (roadmap item ${s.feature?.id ?? '?'}).\n\n`
      + 'Add up its lines\' estimates and compare that against the cycle. If it is over, park the '
      + 'Coulds first and then the Shoulds — set skipped — until it fits. Musts are never cut: if it '
      + 'still does not fit with only Musts left, say so rather than cutting one.\n\n'
      + 'Read EVERY line of that feature, including any in other areas — a total that leaves some out '
      + 'reports a cycle that fits by not counting it.\n\n'
      + ASK_FIRST.replace('{slug}', s.slug),
  },
  {
    key: 'allocate',
    name: 'Sort the unallocated',
    note: 'Reads every item carrying no area and files it, in the session rather than in one shot.',
    views: ['timeline', 'scope', 'plan'],
    // The area chip cannot scope this one either, and for the sharpest reason
    // of the three: untagged IS the population. A chip naming an area selects
    // rows that all have one, which is the exact complement of what this works
    // on.
    wide: true,
    // Drawn inside the ✧ read's card — same job, other way round. See `side`.
    side: true,
    brief: (s) => 'Sort the unallocated items into areas.\n\n'
      + 'Every open item carrying no area at all needs one. An area is the part of the product a '
      + 'piece of work belongs to — it is what the timeline draws as a lane and what every board '
      + 'filters by, so an item with none is in no lane and behind no chip.\n\n'
      + 'PREFER THE AREAS THIS PROJECT ALREADY USES; read them off the board first. Coin a new one '
      + 'only when a real group of items has no home among them — lowercase, one or two words, never '
      + 'a near-synonym of an existing area — and say plainly which ones would be new, because a new '
      + 'area is a new lane on the timeline. LEAVE OUT anything you genuinely cannot place: an item '
      + 'left alone is better than a guessed one, and I will file those by hand.\n\n'
      + 'This works on the UNTAGGED items whatever the board is filtered to — they are the whole '
      + 'population, so a filter naming an area would select the exact rows this cannot act on. The '
      + 'area is the only thing you change: no retitling, no re-bucketing, no merging.\n\n'
      + ASK_FIRST.replace('{slug}', s.slug),
  },
];

export const taskByKey = (key: string): ArrangeTask | undefined =>
  ARRANGE_TASKS.find((t) => t.key === key);

/** The six drawn as buttons of their own — everything that is not a side action. */
export const TOP_LEVEL_TASKS = ARRANGE_TASKS.filter((t) => !t.side);
