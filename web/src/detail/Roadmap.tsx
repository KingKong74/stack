import { useState } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Priority } from '../types';
import { PRIORITY_META } from '../lib/ui';

// MoSCoW roadmap. Open items live in their bucket columns (with edit/delete on
// hover); completed items move to the collapsed Archive below — still counted
// by the progress model, just out of the working view. Un-ticking restores.
export function Roadmap({
  roadmap, onAdd, onToggle, onEdit, onDelete, highlightId,
}: {
  roadmap: RoadmapData;
  onAdd: (p: Priority) => void;
  onToggle: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  highlightId?: string | null;
}) {
  const archived = PRIORITY_META.flatMap((col) => roadmap[col.key].filter((it) => it.done));
  // Open the archive straight away when a deep-link targets an archived item.
  const [archiveOpen, setArchiveOpen] = useState(
    () => archived.some((it) => String(it.id) === highlightId));

  return (
    <div>
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Roadmap</div>
          <div className="subtitle">MoSCoW prioritisation</div>
        </div>
      </div>
      <div className="subtitle" style={{ marginBottom: 20 }}>
        What must ship, what should, what could, and what won't — this round. Tick items off as you go;
        the dashboard progress is computed from Must/Should completion.
      </div>

      <div className="road-grid">
        {PRIORITY_META.map((col) => {
          const items = roadmap[col.key].filter((it) => !it.done);
          return (
            <div className="road-col" key={col.key}>
              <div className="road-col-head">
                <span className="dot" style={{ background: col.color }} />
                <span className="name">{col.label}</span>
                <span className="count">{items.length}</span>
              </div>
              <div className="road-items">
                {items.map((it) => (
                  <div className={`road-item ${highlightId === String(it.id) ? 'hl' : ''}`} key={it.id} data-hl={it.id}>
                    <button
                      className="road-check"
                      onClick={() => onToggle(it)}
                      aria-label="Mark done" title="Mark done — moves to the archive"
                    />
                    <div className="road-body">
                      <div className="t">
                        {it.title}
                        {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                      </div>
                      {it.note && <div className="note">{it.note}</div>}
                    </div>
                    <div className="road-actions">
                      <button onClick={() => onEdit(it)} aria-label="Edit item" title="Edit">✎</button>
                      <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
                    </div>
                  </div>
                ))}
                <button className="road-add" onClick={() => onAdd(col.key)}>+ Add</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* archive — completed items, out of the way but recoverable */}
      {archived.length > 0 && (
        <div className="road-archive">
          <button className="road-archive-head" onClick={() => setArchiveOpen((o) => !o)}
            aria-expanded={archiveOpen}>
            <span className="chev">{archiveOpen ? '▾' : '▸'}</span>
            Archive <span className="count">{archived.length}</span>
            <span className="hint">completed items — still count toward progress</span>
          </button>
          {archiveOpen && (
            <div className="road-archive-list">
              {archived.map((it) => (
                <div className="road-item done" key={it.id} data-hl={it.id}>
                  <button className="road-check on" onClick={() => onToggle(it)}
                    aria-label="Mark not done" title="Restore to the roadmap">✓</button>
                  <div className="road-body">
                    <div className="t">
                      {it.title}
                      <span className="arch-bucket">{PRIORITY_META.find((p) => p.key === it.bucket)?.short}</span>
                    </div>
                  </div>
                  <div className="road-actions">
                    <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
