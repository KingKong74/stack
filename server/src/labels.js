// The roadmap's LABEL REGISTRY — the classification a card carries beyond its
// MoSCoW bucket and its area.
//
// This is CODE, NOT DATA, for the same reason `agents.js` is: the five labels
// below are the classification itself. An owner-editable list would be a second
// truth — the filter chips, the card stripes and any prompt that reasons about
// "what kind of work is this" would each drift from it at their own pace, and a
// label nobody can name is worse than no label. Areas are the exact opposite
// and DO live in a table (`project_areas`), because an area names a part of one
// particular project and only its owner can know what those parts are.
//
// The colours are Atlas tokens by name rather than hexes — `web/src/lib/labels.ts`
// is the client twin and resolves them against the same palette, so a label
// looks identical in both themes without either file holding a colour value.

export const LABELS = [
  { id: 'customer', name: 'Customer ask', tone: 'accent' },
  { id: 'debt', name: 'Tech debt', tone: 'muted' },
  { id: 'polish', name: 'Polish', tone: 'live' },
  { id: 'risk', name: 'Risk', tone: 'building' },
  { id: 'blocked', name: 'Blocked', tone: 'critical' },
];

const IDS = new Set(LABELS.map((l) => l.id));

/**
 * Clean an incoming labels array: unknown ids are DROPPED rather than kept.
 * A label the registry does not know cannot be rendered, filtered or explained,
 * so storing it would create a card carrying an invisible property.
 * Order is the registry's, not the caller's, so two cards with the same labels
 * always render the same stripes in the same order.
 */
export function cleanLabels(input) {
  if (!Array.isArray(input)) return [];
  const want = new Set(input.map((v) => String(v || '').trim()).filter((v) => IDS.has(v)));
  return LABELS.filter((l) => want.has(l.id)).map((l) => l.id);
}
