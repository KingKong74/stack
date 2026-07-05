import { useState } from 'react';
import type { Roadmap as RoadmapData, RoadmapItem, Priority } from '../types';
import { PRIORITY_META } from '../lib/ui';

export type ReviewTag = 'solid' | 'needs-work' | 'rethink';
export const REVIEW_TAGS: { key: ReviewTag; label: string }[] = [
  { key: 'solid', label: 'Solid' },
  { key: 'needs-work', label: 'Needs more work' },
  { key: 'rethink', label: 'Rethink' },
];
const tagLabel = (tag: string) => REVIEW_TAGS.find((t) => t.key === tag)?.label || tag;

// MoSCoW roadmap. Open items live in their bucket columns (with lane-claim
// chips and edit/delete on hover); completed items move to the collapsed
// Archive below — still counted by the progress model, reviewable with a
// verdict tag (needs-work/rethink offer a follow-up item), restorable by
// un-ticking.
export function Roadmap({
  roadmap, onAdd, onToggle, onEdit, onDelete, onReviewTag, onToggleSkip, highlightId,
  draft, onResumeDraft, onDiscardDraft,
}: {
  roadmap: RoadmapData;
  onAdd: (p: Priority) => void;
  onToggle: (item: RoadmapItem) => void;
  onEdit: (item: RoadmapItem) => void;
  onDelete: (item: RoadmapItem) => void;
  onReviewTag: (item: RoadmapItem, tag: ReviewTag) => void;
  onToggleSkip: (item: RoadmapItem) => void;
  highlightId?: string | null;
  draft?: { title: string } | null;
  onResumeDraft?: () => void;
  onDiscardDraft?: () => void;
}) {
  const [pickerFor, setPickerFor] = useState<number | null>(null);
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
        {draft && (
          <div className="bar-actions">
            <button className="draft-chip" onClick={onResumeDraft} title="Resume the unfinished item">
              ✎ Draft · {draft.title.trim() || 'untitled'}
            </button>
            <button className="draft-x" onClick={onDiscardDraft} aria-label="Discard draft" title="Discard draft">×</button>
          </div>
        )}
      </div>
      <div className="subtitle" style={{ marginBottom: 20 }}>
        What must ship, what should, what could, and what won't — this round. Tick items off as you go;
        the dashboard progress is computed from Must/Should completion.
      </div>

      <div className="road-grid">
        {PRIORITY_META.map((col) => {
          const open = roadmap[col.key].filter((it) => !it.done);
          // Parked items sink to the bottom of their bucket.
          const items = [...open.filter((it) => !it.skipped), ...open.filter((it) => it.skipped)];
          return (
            <div className="road-col" key={col.key}>
              <div className="road-col-head">
                <span className="dot" style={{ background: col.color }} />
                <span className="name">{col.label}</span>
                <span className="count">{items.length}</span>
              </div>
              <div className="road-items">
                {items.map((it) => (
                  <div className={`road-item ${it.skipped ? 'skipped' : ''} ${highlightId === String(it.id) ? 'hl' : ''}`} key={it.id} data-hl={it.id}>
                    <button
                      className="road-check"
                      onClick={() => onToggle(it)}
                      aria-label="Mark done" title="Mark done — moves to the archive"
                    />
                    <div className="road-body">
                      <div className="t">
                        {it.title}
                        {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                        {it.skipped && <span className="skip-chip" title="Parked — not to be picked up yet">⏸ parked</span>}
                      </div>
                      {it.note && <div className="note">{it.note}</div>}
                      {it.claimedBy && <div className="claim-chip" title="Claimed by this lane">⚑ {it.claimedBy}</div>}
                    </div>
                    <div className="road-actions">
                      <button onClick={() => onToggleSkip(it)} aria-label={it.skipped ? 'Unpark item' : 'Park item'}
                        title={it.skipped ? 'Unpark — back in play' : 'Park — skip for now'}>{it.skipped ? '▶' : '⏸'}</button>
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
            <div className="road-grid arch">
              {PRIORITY_META.map((col) => {
                const items = roadmap[col.key].filter((it) => it.done);
                return (
                  <div className="road-col" key={col.key}>
                    <div className="road-col-head">
                      <span className="dot" style={{ background: col.color }} />
                      <span className="name">{col.label}</span>
                      <span className="count">{items.length}</span>
                    </div>
                    <div className="road-items">
                      {items.map((it) => (
                        <div className="road-item done" key={it.id} data-hl={it.id}>
                          <button className="road-check on" onClick={() => onToggle(it)}
                            aria-label="Mark not done" title="Restore to the roadmap">✓</button>
                          <div className="road-body">
                            <div className="t">
                              {it.title}
                              {it.source === 'hook' && <span className="auto-cue" title="Auto-extracted from a push">auto</span>}
                              {it.claimedBy && <span className="claim-chip inline" title="Done by this lane">⚑ {it.claimedBy}</span>}
                            </div>
                            {pickerFor === it.id ? (
                              <div className="review-pick">
                                {REVIEW_TAGS.map((t) => (
                                  <button key={t.key} className={`review-pick-opt ${t.key}`}
                                    onClick={() => { setPickerFor(null); onReviewTag(it, t.key); }}>
                                    {t.label}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="road-actions arch">
                                {it.reviewTag ? (
                                  <button className={`review-verdict ${it.reviewTag}`} onClick={() => setPickerFor(it.id)}
                                    title="Change the verdict">{tagLabel(it.reviewTag)}</button>
                                ) : (
                                  <button className="review-verdict none" onClick={() => setPickerFor(it.id)}
                                    title="Review this completed item">Review</button>
                                )}
                                <button onClick={() => onDelete(it)} aria-label="Delete item" title="Delete">×</button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
