// The roadmap's labels, client side.
//
// These used to BE the registry, kept in step with `server/src/labels.js` by
// discipline. They are now a FALLBACK: labels live in `project_labels` and
// arrive with the board read (`getBoardShape`), so what the server serves always
// wins and this list only stands in for a server that has not been redeployed
// yet. Never add a label here expecting it to appear — add it on the board.
//
// `tone` names an Atlas semantic token rather than a colour. That is what keeps
// a label looking right in both themes without either file holding a hex —
// styles.css maps `.rl-<tone>` onto the same palette everything else uses, and
// it is why the tone set stays closed even though the labels no longer are.

import type { BoardLabel } from '../types';

export type Label = BoardLabel;

/** The tones a label may wear — every one has a `.rl-<tone>` rule in styles.css. */
export const LABEL_TONES = ['accent', 'muted', 'live', 'building', 'critical', 'sage', 'paused'];

/** What a project starts with, and what renders before the board read lands. */
export const DEFAULT_LABELS: Label[] = [
  { key: 'customer', name: 'Customer ask', tone: 'accent' },
  { key: 'debt', name: 'Tech debt', tone: 'muted' },
  { key: 'polish', name: 'Polish', tone: 'live' },
  { key: 'risk', name: 'Risk', tone: 'building' },
  { key: 'blocked', name: 'Blocked', tone: 'critical' },
];

/**
 * The known labels among these ids, in BOARD order — the order every card's
 * stripes render in, so two cards carrying the same labels always look alike.
 * An unknown id vanishes: a label the board cannot name is one nothing can
 * render, filter or explain, and drawing it as a blank stripe would be worse.
 */
export const labelsOf = (ids: string[], labels: Label[]): Label[] =>
  labels.filter((l) => ids.includes(l.key));

export const labelName = (id: string, labels: Label[]): string =>
  labels.find((l) => l.key === id)?.name || id;
