import { useCallback, useRef, useState } from 'react';
import type { Future } from '../types';

// Alignment columns in curation order — matches Futures.tsx GROUPS
const COLUMNS = [
  { key: 'on-course', label: 'On course' },
  { key: '', label: 'Unsorted' },
  { key: 'tangent', label: 'Tangents' },
  { key: 'off-course', label: 'Off course' },
];

const NODE_W = 220;
const COL_GAP = 50;
const PAD = 40;
const ROW_H = 110;   // vertical step per node within a column
const COL_TOP = 64;  // top offset to leave room for column labels

function colIndex(alignment: string): number {
  const i = COLUMNS.findIndex((c) => c.key === alignment);
  return i >= 0 ? i : 1;
}

// Default canvas position for a future with no stored coords.
// Deterministic: column by alignment, stacked by index within that group.
function defaultPos(future: Future, futures: Future[]): { x: number; y: number } {
  const col = colIndex(future.alignment || '');
  const groupItems = futures.filter((f) => (f.alignment || '') === (future.alignment || ''));
  const row = Math.max(0, groupItems.findIndex((f) => f.id === future.id));
  return {
    x: PAD + col * (NODE_W + COL_GAP),
    y: PAD + COL_TOP + row * ROW_H,
  };
}

const CANVAS_W = PAD * 2 + 4 * (NODE_W + COL_GAP);
// Tall enough for any sane board; a stored coordinate beyond this is corrupt.
const MAX_Y = 20_000;

// Coordinate guard (#218: #203): stored coords come off the wire — NaN,
// Infinity or absurd values (a corrupted row, a bad client) must never place
// a node off-canvas or wreck layout. Invalid input reads as "no stored
// position" so the deterministic default takes over.
function validCoords(x: unknown, y: unknown): { x: number; y: number } | null {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return {
    x: Math.min(Math.max(0, Math.round(nx)), CANVAS_W - NODE_W),
    y: Math.min(Math.max(0, Math.round(ny)), MAX_Y),
  };
}

function resolvePos(
  f: Future,
  positions: Map<number, { x: number; y: number }>,
  futures: Future[],
): { x: number; y: number } {
  if (positions.has(f.id)) return positions.get(f.id)!;
  if (f.canvasX != null && f.canvasY != null) {
    const v = validCoords(f.canvasX, f.canvasY);
    if (v) return v;
  }
  return defaultPos(f, futures);
}

// The visual canvas: futures rendered as draggable node cards over alignment
// column zones. Positions are persisted via onMove after each drag.
export function FuturesCanvas({
  futures, onMove, highlightId,
}: {
  futures: Future[];
  onMove: (id: number, x: number, y: number) => void;
  highlightId?: string | null;
}) {
  // Local drag positions — authoritative during drag, synced from futures on mount.
  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(() => {
    const m = new Map<number, { x: number; y: number }>();
    for (const f of futures) {
      if (f.canvasX == null || f.canvasY == null) continue;
      const v = validCoords(f.canvasX, f.canvasY); // corrupt coords fall back to defaults (#203)
      if (v) m.set(f.id, v);
    }
    return m;
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ id: number; ox: number; oy: number } | null>(null);
  const lastDragPos = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const nodeEl = (e.target as HTMLElement).closest('[data-nodeid]') as HTMLElement | null;
    if (!nodeEl || e.button !== 0) return;
    const id = Number(nodeEl.dataset.nodeid);
    const container = containerRef.current;
    if (!container) return;
    const f = futures.find((x) => x.id === id);
    if (!f) return;
    const pos = resolvePos(f, positions, futures);
    const rect = container.getBoundingClientRect();
    dragging.current = {
      id,
      ox: e.clientX - rect.left + container.scrollLeft - pos.x,
      oy: e.clientY - rect.top + container.scrollTop - pos.y,
    };
    lastDragPos.current = null;
    container.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [futures, positions]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // Same guard as stored coords (#203): a drag can't produce NaN in practice,
    // but the clamp keeps saved positions inside the canvas either way.
    const v = validCoords(
      e.clientX - rect.left + container.scrollLeft - dragging.current.ox,
      e.clientY - rect.top + container.scrollTop - dragging.current.oy,
    );
    if (!v) return;
    const { x, y } = v;
    lastDragPos.current = { x, y };
    const id = dragging.current.id;
    setPositions((prev) => {
      const m = new Map(prev);
      m.set(id, { x, y });
      return m;
    });
  }, []);

  const handlePointerUp = useCallback((_e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const id = dragging.current.id;
    dragging.current = null;
    if (lastDragPos.current) {
      onMove(id, lastDragPos.current.x, lastDragPos.current.y);
      lastDragPos.current = null;
    }
  }, [onMove]);

  const canvasH = Math.max(
    600,
    PAD + COL_TOP + futures.length * ROW_H + 120,
  );

  if (!futures.length) {
    return (
      <div className="fcanvas-empty">
        <div className="big">No ideas yet</div>
        <div>Add an idea above and it will appear here as a draggable node.</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fcanvas-viewport"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="fcanvas-inner" style={{ width: CANVAS_W, height: canvasH }}>
        {/* Column zone backgrounds */}
        {COLUMNS.map((col, i) => (
          <div
            key={col.key || 'unsorted'}
            className={`fcanvas-zone ${col.key || 'unsorted'}`}
            style={{
              left: PAD + i * (NODE_W + COL_GAP) - 12,
              width: NODE_W + 24,
              top: PAD,
              height: canvasH - PAD * 2,
            }}
          >
            <div className="fcanvas-zone-label">{col.label}</div>
          </div>
        ))}

        {/* Future nodes */}
        {futures.map((f) => {
          const pos = resolvePos(f, positions, futures);
          const isDragging = dragging.current?.id === f.id;
          return (
            <div
              key={f.id}
              data-nodeid={f.id}
              className={`fcanvas-node ${f.alignment || 'unsorted'}${isDragging ? ' dragging' : ''}${highlightId === String(f.id) ? ' hl' : ''}`}
              style={{ left: pos.x, top: pos.y, width: NODE_W }}
            >
              <div className="fcanvas-node-title">{f.title}</div>
              {f.note && <div className="fcanvas-node-note">{f.note}</div>}
              {(f.alignment || f.area) && (
                <div className="fcanvas-node-meta">
                  {f.alignment && (
                    <span className={`fcanvas-align ${f.alignment}`}>
                      {COLUMNS.find((c) => c.key === f.alignment)?.label ?? f.alignment}
                    </span>
                  )}
                  {f.area && <span className="fcanvas-area-chip">{f.area}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
