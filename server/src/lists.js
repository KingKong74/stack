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
//   shipped   — done
//   progress  — claimed by a branch or a session
//   idea      — nobody typed it and nobody has signed it off yet (#359: an
//               unapproved auto-extraction is not planned work, it is a
//               suggestion; #381 puts a released fly card here on the same
//               footing — a session's note about what it was doing is not a
//               commitment by the board until someone says so). A fly card
//               still claimed by its session is caught by `progress` above,
//               which is where it spends its whole working life.
//   planned   — everything else
//
// Moving a card writes `list_key` explicitly, and from then on the row says
// where it lives. Dragging a card to "Shipped" does NOT tick it: ticking is a
// verdict the Review room owns, and a board column is not a verdict.

export const DEFAULT_LISTS = [
  { key: 'idea', name: 'Ideas · Polaris', position: 0 },
  { key: 'planned', name: 'Planned', position: 1 },
  { key: 'progress', name: 'In progress', position: 2 },
  { key: 'shipped', name: 'Shipped', position: 3 },
];

/** Where a row sits when `list_key` is NULL. Pure. */
export function listFor(row) {
  if (row.done) return 'shipped';
  if (String(row.claimed_by || '').trim()) return 'progress';
  if ((row.source === 'hook' || row.source === 'fly') && !row.reviewed_at) return 'idea';
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
