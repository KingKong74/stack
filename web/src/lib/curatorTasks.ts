// THE ARRANGE PANEL'S QUICK COMMANDS, as briefs for the Curator's console.
//
// A command does not COMPUTE. It composes an INSTRUCTION and hands it to the
// Curator's own live session on the Roadmap tab (#379/#380), which can read the
// board, read the code, ask you something back and change its mind — the things
// a sum structurally cannot do. Every one of these was arithmetic once (pure
// functions returning a list of {id, sched} to apply or discard), and the sums
// were exact and also the ceiling: they could do the things somebody had
// written a function for and nothing else, each blind to everything the board
// does not store.
//
// SIX OF THE SEVEN WENT WITH THE TIMELINE (#428) — see TOP_LEVEL_TASKS. What is
// left is `allocate`, which is about WHERE a row belongs rather than when it
// runs, and is drawn inside the ✧ read's card as a second way to run that job.
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
//     "sort these" while the owner was looking at one area would be acted on
//     across the whole board, and the diff would arrive in lanes nobody was
//     looking at. `allocate` deliberately does not narrow, and says why in its
//     own line (see ARRANGE_TASKS).
//  2. IT ASKS BEFORE IT WRITES. The owner sanctioned SENDING these (see
//     TabTerminal — the Enter is Stack's on this one path, against the rule in
//     console-prime.js that only a human submits). That licence was for
//     starting the session working; it was not a licence for a session to
//     silently rewrite the plan. So every brief ends by asking for the moves as
//     a list first. The session starts immediately and stops at the write,
//     which is the same shape the ✧ reads have always had: propose, then the
//     human disposes.

/** Which Roadmap board an action belongs to. */
export type ArrangeView = 'scope' | 'board';

/** The board state a brief is composed against. */
export interface TaskScope {
  slug: string;
  /** The area chip in force. '' = the whole board; UNALLOCATED = untagged. */
  areaFilter: string;
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

export const ARRANGE_TASKS: ArrangeTask[] = [
  {
    key: 'allocate',
    name: 'Sort the unallocated',
    note: 'Reads every item carrying no area and files it, in the session rather than in one shot.',
    views: ['scope', 'board'],
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

/**
 * The ones drawn as buttons of their own — everything that is not a side action.
 *
 * EMPTY since the Timeline went (#428). Six of the seven briefs were timeline
 * arithmetic — schedule the committed, close the gaps, catch up the past, level
 * the lanes, lead with the tier — and the seventh, `trim`, was reached by
 * selecting a BAR, a gesture no board here has. An op moves with its surface
 * (CLAUDE.md); a brief kept alive with nothing to press it is a command that
 * cannot be run and a scope line nothing checks. The panel already draws no
 * command row when this is empty, and the catalogue stays plural so the next
 * board-shaped command lands in it rather than off to one side.
 */
export const TOP_LEVEL_TASKS = ARRANGE_TASKS.filter((t) => !t.side);
