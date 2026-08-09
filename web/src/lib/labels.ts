// The roadmap's label registry — the client twin of `server/src/labels.js`.
//
// Kept in step by discipline, not by a shared module: the two packages cannot
// import each other. If you add a label, add it in BOTH files; the server is
// the one that decides what may be stored (`cleanLabels` drops anything it does
// not know), so a label added only here renders on cards that can never save it.
//
// `tone` names an Atlas semantic token rather than a colour. That is what keeps
// a label looking right in both themes without either file holding a hex —
// styles.css maps `.rl-<tone>` onto the same palette everything else uses.

export interface Label { id: string; name: string; tone: string }

export const LABELS: Label[] = [
  { id: 'customer', name: 'Customer ask', tone: 'accent' },
  { id: 'debt', name: 'Tech debt', tone: 'muted' },
  { id: 'polish', name: 'Polish', tone: 'live' },
  { id: 'risk', name: 'Risk', tone: 'building' },
  { id: 'blocked', name: 'Blocked', tone: 'critical' },
];

const BY_ID = new Map(LABELS.map((l) => [l.id, l]));

/** The known labels among these ids, in registry order. Unknown ids vanish. */
export const labelsOf = (ids: string[]): Label[] =>
  LABELS.filter((l) => ids.includes(l.id));

export const labelName = (id: string): string => BY_ID.get(id)?.name || id;
