// Where the Polaris sidebar's "Open in Workbench" action lands (#321), kept pure
// so the decision can be tested without a canvas. The sidebar has no viewport to
// centre on the way Workbench.tsx's centreOfView() does, so a fresh card goes to
// free space to the right of everything already on the canvas instead.

// clampInt mirrors server/src/routes/workbench.js's own clampInt (~line 69): the
// client predicts the same clamp the server will apply, so it can navigate
// straight to a card whose position it already knows.
function clampInt(v: number): number {
  return Math.min(20000, Math.max(-20000, Math.round(v)));
}

// 244 is the server's fixed polaris card width (POST /cards in workbench.js).
const CARD_WIDTH = 244;

export type WorkbenchOpenCard = { id: number; futureId?: number | null; x: number; y: number; w?: number | null };

export type WorkbenchOpenPlan =
  | { action: 'reveal'; cardId: number }
  | { action: 'create'; x: number; y: number };

export function planWorkbenchOpen(cards: WorkbenchOpenCard[], futureId: number): WorkbenchOpenPlan {
  const already = cards.find((c) => c.futureId != null && c.futureId === futureId);
  if (already) return { action: 'reveal', cardId: already.id };

  if (cards.length === 0) return { action: 'create', x: 40, y: 40 };

  const x = Math.max(...cards.map((c) => c.x + (c.w ?? CARD_WIDTH))) + 40;
  const y = Math.min(...cards.map((c) => c.y));
  return { action: 'create', x: clampInt(x), y: clampInt(y) };
}
