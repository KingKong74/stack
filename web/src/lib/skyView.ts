// The sky's view state, and the one definition of "fit all".
//
// It lives here rather than inside the Futures tab because "fit all" had grown
// two half-definitions that disagreed — the chip could not clear the hand-drag
// (it lives in Galaxy) and Galaxy's Recentre could not clear the focused system
// (it lives in Futures) — so neither button did what it said. One value, one
// predicate, no DOM: the tab holds the state, this decides what the state is.

export type Pan = { x: number; y: number };

export type SkyView = {
  northOnly: boolean;      // the scope: the north star's own shells alone
  zoom: number;            // 1 = Fit
  focus: string | null;    // 'core' | 'belt' | a star id — the system in the light
  selId: number | null;    // the idea in the panel
  pan: Pan;                // the hand-drag on top of the automatic pan
};

export const FIT_ZOOM = 1;

/**
 * Fit all, in the given scope: the whole sky at Fit, nothing focused, nothing
 * selected, no hand-drag left over. It takes the scope and NOT the current view
 * on purpose — a reset that carried anything through would not be a reset.
 */
export function fitAll(northOnly: boolean): SkyView {
  return { northOnly, zoom: FIT_ZOOM, focus: null, selId: null, pan: { x: 0, y: 0 } };
}

/** Is the sky already fitted? The scope is not part of the answer — both scopes fit. */
export function isFitAll(v: SkyView): boolean {
  return v.zoom === FIT_ZOOM && v.focus === null && v.selId === null && v.pan.x === 0 && v.pan.y === 0;
}
