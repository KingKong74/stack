// Slice zoom is a read of the whole slice, independent of board filters.
// Opening a task delegates to the existing task canvas; no rows are refiled.
import { useEffect, useRef } from 'react';
import type { RoadmapItem, Slice } from '../types';
import { isBuilt } from '../lib/plan';
import { Markdown } from '../components/Markdown';
import { KitIcon } from './kit/KitIcon';

export function SliceFocus({ slice, rows, left, columns, colOf, onClose, onOpen }: {
  slice: Slice; rows: RoadmapItem[]; left: number;
  columns: { key: string; name: string }[];
  colOf: (it: RoadmapItem) => string;
  onClose: () => void;
  onOpen: (it: RoadmapItem, el: HTMLElement) => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    back.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); previous?.focus(); };
  }, [onClose]);
  const items = rows.filter((it) => it.sliceId === slice.id && !it.archived);
  const built = items.filter(isBuilt).length;
  return (
    <section className="bf sf" style={{ left }} aria-label={`Slice zoom — ${slice.title}`}>
      <div className="bf-chrome">
        <button ref={back} className="k-btn sm secondary bf-back" onClick={onClose}>
          <KitIcon name="chevron-left" size={14} />Board
        </button>
        <span className="bf-crumb">Slice</span>
        <span className="bf-esc"><kbd>Esc</kbd>back to the board</span>
      </div>
      <div className="sf-content">
        <h2>{slice.title}</h2>
        <p>{built}/{items.length} built</p>
        {slice.spec && <Markdown text={slice.spec} />}
        <div className="sf-items">
          {items.map((it) => (
            <button key={it.id} className="km-card sf-item" onDoubleClick={(e) => onOpen(it, e.currentTarget)}
              onClick={(e) => { if (e.detail === 0) onOpen(it, e.currentTarget); }}
              title="Double-click to zoom into task; Enter to open">
              <span className="t">{it.title}</span>
              <span className="km-cardmeta">#{it.id} · {columns.find((c) => c.key === colOf(it))?.name || 'No column'}</span>
            </button>
          ))}
        </div>
        {!items.length && <p>No tasks in this slice yet.</p>}
      </div>
    </section>
  );
}
