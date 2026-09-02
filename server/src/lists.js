// The Plan view's LISTS — the columns a card can sit in, and the rule for
// where a card sits when nobody has said.
//
// Two halves, and the split is the point:
//
//  • The list's NAME and ORDER are data (`project_lists`), because what the
//    columns of a personal board are called is not something code can know.
//  • Which list a card is IN is `roadmap_items.list_key`, and NULL means
//    DERIVED — not "the first list". Every row that existed before this feature
//    has a NULL, and defaulting those to the leftmost column would file a
//    year of finished work under "Ideas". `listFor()` reads the state the row
//    already carries instead, so an untouched board opens already sorted.
//
// The derivation deliberately mirrors the states Stack tracks elsewhere, so the
// Plan view agrees with the Overview spine without either importing the other:
//   shipped   — done, OR a verdict is on record (see below)
//   review    — BUILT and not yet verdicted (#374's predicate: a built note and
//               a branch claim). #440 — a change waiting on the owner used to
//               sit in "In progress" for as long as its branch lived, so the
//               busiest lane held two states that want different things from
//               you: work a machine is still doing, and work waiting on a
//               human. The lane is the difference.
//   progress  — claimed, and nothing built yet
//   planned   — everything else, INCLUDING a held auto-extraction. The old
//               `idea` lane (#359/#381) was the board's answer to "nobody has
//               signed this off"; the Roadmap tab's capture inbox (#439) is
//               that answer now, with the hold said on the card, so the board
//               does not need a lane for it.
//
// A VERDICT SHIPS THE CARD, AND STILL DOES NOT TICK IT. `review_tag` outranks
// the branch claim here because approving in the Review room is the moment the
// change stops being in progress — and the claim SURVIVES a verdict (it stays
// until a human merges and ticks, CLAUDE.md), so a claim-first derivation left
// every verdicted change sitting in "In progress" for as long as its branch
// lived. What this is NOT is a tick: `done` is still what `computeProgress`
// weighs and what the merge job writes, and nothing here touches it. The board
// reads a verdict; it never manufactures one, which is the same rule from the
// other side as "a board column is not a verdict".
//
// Moving a card writes `list_key` explicitly, and from then on the row says
// where it lives — with one exception, in `PATCH /roadmap/:id`: recording a
// verdict CLEARS `list_key`, so a card somebody once dragged still lands in
// Shipped. Un-ticking clears the verdict, which hands the row straight back to
// this derivation.

// THE KEYS OUTLIVE THE NAMES. `planned` and `shipped` are called To Do and
// Done (#440) and their keys are untouched, because a key is what a stored
// `list_key` and every derivation spell — renaming is free precisely because
// the two halves are separate, and renaming the KEY would strand every card
// that had been dragged into one.
export const DEFAULT_LISTS = [
  { key: 'planned', name: 'To Do', position: 0 },
  { key: 'progress', name: 'In Progress', position: 1 },
  { key: 'review', name: 'In Review', position: 2 },
  { key: 'shipped', name: 'Done', position: 3 },
];

/**
 * THE LANES ARE THE OWNER'S — none of them is locked (#428).
 *
 * The four above were unrenameable and undeletable, because `listFor` returns
 * their keys and a board missing one had a derived column with nowhere to
 * render — cards still counted everywhere else and invisible on the board, the
 * worst kind of loss. The owner asked for a Trello board, where every column is
 * yours, so the guard moved rather than went: `RoadmapPlan` draws a CATCH-ALL
 * lane for any card whose derived key has no column, so deleting `shipped`
 * relocates its cards in plain sight instead of losing them.
 *
 * What is still true: these four keys are WIRING. `listFor` returns them,
 * `POST /lists` suffixes every added key with its position so a new lane can
 * never collide with one, and renaming touches `name` only — the key a card
 * derives to is untouched by any rename, which is what makes renaming free.
 * Deleting one is a real change and the catch-all is what makes it safe; do not
 * remove the catch-all without putting this lock back.
 */

/** Where a row sits when `list_key` is NULL. Pure. */
export function listFor(row) {
  if (row.done) return 'shipped';
  // The verdict, before the claim — see the header. Any of the three verdicts
  // counts: "needs-work" is still a change that has been read and answered.
  if (String(row.review_tag || '').trim()) return 'shipped';
  // BUILT-or-ticked (#374), before the claim for the same reason the verdict
  // is: the claim SURVIVES being built and stays until a human merges and
  // ticks, so a claim-first derivation leaves finished work in In Progress.
  // Both halves are load-bearing — `built_note` alone re-queues rejected work,
  // `claimed_by` alone lands items in review the moment they are claimed.
  if (String(row.built_note || '').trim() && String(row.claimed_by || '').trim()) return 'review';
  if (String(row.claimed_by || '').trim()) return 'progress';
  return 'planned';
}

/** The stored key if there is one, else the derived one. Pure. */
export const listKeyOf = (row) => String(row.list_key || '').trim() || listFor(row);

/**
 * Seed the four defaults for a project that has none. Called on read rather
 * than at project creation, so projects that pre-date the Plan view get their
 * lists the first time anyone opens it — and a project whose lists the owner
 * has DELETED down to none does not silently get them back, because we only
 * seed when the table has never been written for that project.
 */
export async function ensureLists(q, projectId) {
  const { rows } = await q(
    'SELECT id, key, name, position FROM project_lists WHERE project_id = $1 ORDER BY position, id',
    [projectId]
  );
  if (rows.length) return rows;
  const seeded = [];
  for (const l of DEFAULT_LISTS) {
    const { rows: r } = await q(
      `INSERT INTO project_lists (project_id, key, name, position) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, key) DO NOTHING RETURNING id, key, name, position`,
      [projectId, l.key, l.name, l.position]
    );
    if (r.length) seeded.push(r[0]);
  }
  return seeded;
}
