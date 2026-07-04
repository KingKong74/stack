import { useState } from 'react';
import type { Future } from '../types';

// The Futures tab: the project's north star (one paragraph on what this is
// becoming) and the loose ideas curated against it. Ideas firm up by being
// promoted into the roadmap (ProjectDetail owns that flow, prefilling the
// existing RoadmapModal), or get dismissed.
export function Futures({
  northStar, futures, highlightId, onSaveNorthStar, onAdd, onDelete, onPromote,
}: {
  northStar: string;
  futures: Future[];
  highlightId?: string | null;
  onSaveNorthStar: (text: string) => void;
  onAdd: (title: string) => void;
  onDelete: (id: number) => void;
  onPromote: (future: Future) => void;
}) {
  const [editingStar, setEditingStar] = useState(false);
  const [starDraft, setStarDraft] = useState(northStar);
  const [draft, setDraft] = useState('');

  const saveStar = () => {
    const t = starDraft.trim();
    if (t !== northStar) onSaveNorthStar(t);
    setEditingStar(false);
  };

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  };

  return (
    <div>
      {/* north star — the yardstick every idea is curated against */}
      <div className="northstar">
        <div className="northstar-head">
          <div className="left">
            <span className="northstar-ico">✦</span>
            <span className="northstar-title">North star</span>
          </div>
          {!editingStar && (
            <button className="northstar-edit" onClick={() => { setStarDraft(northStar); setEditingStar(true); }}>
              {northStar ? 'Edit' : 'Set it'}
            </button>
          )}
        </div>
        {editingStar ? (
          <div className="northstar-editor">
            <textarea value={starDraft} autoFocus rows={3}
              placeholder="One paragraph: what is this project becoming?"
              onChange={(e) => setStarDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveStar(); }
                else if (e.key === 'Escape') { e.preventDefault(); setEditingStar(false); }
              }} />
            <div className="row">
              <span className="hint">⏎ to save · esc to cancel</span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn-cancel sm" onClick={() => setEditingStar(false)}>Cancel</button>
                <button className="btn-submit sm" onClick={saveStar}>Save</button>
              </span>
            </div>
          </div>
        ) : northStar ? (
          <div className="northstar-text">{northStar}</div>
        ) : (
          <div className="northstar-empty">
            Not set. One paragraph on what this project is becoming — it's injected into every
            session, so every agent pulls in the same direction.
          </div>
        )}
      </div>

      {/* ideas */}
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Ideas</div>
          <div className="subtitle">Loose and directional — promote what fits the north star, dismiss what doesn't</div>
        </div>
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder="Could this become… ? Capture the direction, not the task."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }}
        />
        <div className="row">
          <span className="hint">⏎ to add · ⇧⏎ for newline</span>
          <button className="add" onClick={add}>Add idea</button>
        </div>
      </div>

      {futures.length ? (
        <div className="futures-list">
          {futures.map((f) => (
            <div className={`future-row ${highlightId === String(f.id) ? 'hl' : ''}`} data-hl={f.id} key={f.id}>
              <div className="future-body">
                <div className="future-title">{f.title}</div>
                {f.note && <div className="future-note">{f.note}</div>}
                <div className="future-meta">
                  {f.source === 'hook' && <span className="auto-badge">✦ auto</span>}
                  <span className="when">{f.when}</span>
                </div>
              </div>
              <div className="future-actions">
                <button className="promote" onClick={() => onPromote(f)}>→ Roadmap</button>
                <button className="dismiss" onClick={() => onDelete(f.id)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="big">No ideas yet</div>
          <div>Futures land here from you or from checkpoints — the loose "what ifs" worth keeping.</div>
        </div>
      )}
    </div>
  );
}
