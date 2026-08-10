// The roadmap's LABELS — the classification a card carries beyond its MoSCoW
// bucket and its area.
//
// This WAS a code registry, on the argument that the set is the classification
// itself. The owner's call reversed that: labels are theirs to add to and delete
// from, like areas and lists, and this file kept only the parts that a table
// genuinely cannot hold.
//
//  • DEFAULT_LABELS is a SEED, not a registry. `ensureLabels` plants it the
//    first time a project's labels are read — the same shape as `ensureLists`,
//    and for the same reason: a board that pre-dates the feature opens with the
//    five it always had, and a project whose labels the owner has deleted down
//    to none does not silently get them back, because we only seed when the
//    table has never been written for that project.
//  • TONES stays CLOSED. A tone names an Atlas token, and `styles.css` has to
//    carry a `.rl-<tone>` rule for it — a free colour would be a label that
//    renders wrong in one of the two themes, or not at all. Same argument as
//    the area palette: a closed set the picker can show whole.
//  • `cleanLabels` now takes the project's ALLOWED ids, since there is no
//    global set to check against. It still DROPS what it does not recognise:
//    storing an unknown id creates a card carrying an invisible property.
//
// The client twin is `web/src/lib/labels.ts`, which holds the same defaults as a
// FALLBACK for a server that has not been redeployed yet — not as a second
// truth. What the board read serves always wins.

export const TONES = ['accent', 'muted', 'live', 'building', 'critical', 'sage', 'paused'];

export const DEFAULT_LABELS = [
  { key: 'customer', name: 'Customer ask', tone: 'accent' },
  { key: 'debt', name: 'Tech debt', tone: 'muted' },
  { key: 'polish', name: 'Polish', tone: 'live' },
  { key: 'risk', name: 'Risk', tone: 'building' },
  { key: 'blocked', name: 'Blocked', tone: 'critical' },
];

/** A label's id, derived from its name the way a list's key is. */
export const labelKey = (name) =>
  (String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'label').slice(0, 40);

/** One of the closed tone set, or the neutral default. Never a stored unknown. */
export const cleanTone = (tone) => (TONES.includes(String(tone || '').trim()) ? String(tone).trim() : 'muted');

/**
 * The project's labels, seeding the defaults for a project that has none.
 * Returns rows in board order — the order every card's stripes render in.
 */
export async function ensureLabels(q, projectId) {
  const read = () => q(
    'SELECT id, key, name, tone, position FROM project_labels WHERE project_id = $1 ORDER BY position, id',
    [projectId]
  );
  const { rows } = await read();
  if (rows.length) return rows;
  // Cards already carry ids from the old code registry, and the seed uses those
  // same keys — which is what makes an existing board's stripes keep rendering
  // through the move from code to table.
  for (const [i, l] of DEFAULT_LABELS.entries()) {
    await q(
      `INSERT INTO project_labels (project_id, key, name, tone, position) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, key) DO NOTHING`,
      [projectId, l.key, l.name, l.tone, i]
    );
  }
  return (await read()).rows;
}

/**
 * Clean an incoming labels array against the ids this project actually has.
 * Unknown ids are DROPPED rather than kept — a label nothing can name cannot be
 * rendered, filtered or explained. Order is the project's own, not the
 * caller's, so two cards with the same labels always render the same stripes in
 * the same order.
 */
export function cleanLabels(input, allowed) {
  if (!Array.isArray(input)) return [];
  const order = Array.isArray(allowed) ? allowed.map((l) => (typeof l === 'string' ? l : l.key)) : [];
  const want = new Set(input.map((v) => String(v || '').trim()));
  return order.filter((k) => want.has(k));
}
