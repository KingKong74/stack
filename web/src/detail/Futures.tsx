import { useState } from 'react';
import type { Future } from '../types';
import type { JudgeSuggestion } from '../store';
import { Polaris } from '../components/Polaris';
import { FuturesCanvas } from '../components/FuturesCanvas';

export type Alignment = 'on-course' | 'tangent' | 'off-course';
export const ALIGNMENTS: { key: Alignment; label: string; hint: string }[] = [
  { key: 'on-course', label: 'On course', hint: 'Pulls toward the north star — promote when it firms up' },
  { key: 'tangent', label: 'Tangent', hint: 'Interesting but sideways — park it, revisit later' },
  { key: 'off-course', label: 'Off course', hint: 'Pulls away from the north star — usually a dismiss' },
];
const alignLabel = (a: string) => ALIGNMENTS.find((x) => x.key === a)?.label || a;

// The ideas group in curation order: judged on-course first, then the unsorted
// pile, then tangents and off-course at the bottom.
const GROUPS: { key: string; label: string }[] = [
  { key: 'on-course', label: 'On course' },
  { key: '', label: 'Unsorted' },
  { key: 'tangent', label: 'Tangents' },
  { key: 'off-course', label: 'Off course' },
];

// The Futures tab: the project's north star (one paragraph on what this is
// becoming) and the loose ideas curated against it. Curate = judge each idea's
// alignment; the panel groups itself by verdict. Ideas firm up by being
// promoted into the roadmap (ProjectDetail owns that flow), or get dismissed.
export function Futures({
  northStar, futures, highlightId, onSaveNorthStar, onAdd, onEdit, onAlign, onDelete, onPromote,
  onMove, onAskGemini, slug,
}: {
  northStar: string;
  futures: Future[];
  slug?: string;
  highlightId?: string | null;
  onSaveNorthStar: (text: string) => void;
  onAdd: (title: string, note: string) => void;
  onEdit: (id: number, patch: { title: string; note: string; area: string }) => void;
  onAlign: (id: number, alignment: Alignment | '') => void;
  onDelete: (id: number) => void;
  onPromote: (future: Future) => void;
  onMove: (id: number, x: number, y: number) => void;
  onAskGemini?: (id: number) => Promise<JudgeSuggestion>;
}) {
  const [editingStar, setEditingStar] = useState(false);
  const [starDraft, setStarDraft] = useState(northStar);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'list' | 'canvas'>('list');

  const saveStar = () => {
    const t = starDraft.trim();
    if (t !== northStar) onSaveNorthStar(t);
    setEditingStar(false);
  };

  // First line = the idea; anything after = the why (stored as the note).
  const add = () => {
    const lines = draft.split('\n');
    const title = (lines[0] || '').trim();
    if (!title) return;
    onAdd(title, lines.slice(1).join('\n').trim());
    setDraft('');
  };

  // Area tags: an orthogonal axis to alignment — alignment groups (should we),
  // area filters (where it lives).
  const [areaFilter, setAreaFilter] = useState('');
  const areas = [...new Set(futures.map((f) => f.area).filter(Boolean))].sort();
  // Source filter (#182): generated = auto-extracted from pushes / Gemini
  // (source 'hook'), manual = typed or agreed with Polaris. Only offered when
  // the funnel actually holds both kinds.
  const [sourceFilter, setSourceFilter] = useState<'' | 'hook' | 'manual'>('');
  const mixedSources = futures.some((f) => f.source === 'hook') && futures.some((f) => f.source !== 'hook');
  const bySource = futures
    .filter((f) => !sourceFilter || (sourceFilter === 'hook' ? f.source === 'hook' : f.source !== 'hook'));
  const visible = bySource.filter((f) => !areaFilter || f.area === areaFilter);

  const judged = futures.some((f) => f.alignment);
  const groups = GROUPS
    .map((g) => ({ ...g, items: visible.filter((f) => f.alignment === g.key) }))
    .filter((g) => g.items.length > 0);

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

      {/* polaris (#209) — the claude planning session, pinned under the north star */}
      {slug && <Polaris slug={slug} />}

      {/* ideas */}
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Ideas</div>
          <div className="subtitle">Judge each against the north star — promote what's on course, park the tangents</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {view === 'list' && areas.length > 0 && (
            <div className="chips">
              <button className={`chip-sm ${areaFilter === '' ? 'on' : ''}`} onClick={() => setAreaFilter('')}>
                All {futures.length}
              </button>
              {areas.map((a) => (
                <button key={a} className={`chip-sm ${areaFilter === a ? 'on' : ''}`}
                  onClick={() => setAreaFilter(areaFilter === a ? '' : a)}>
                  {a} {futures.filter((f) => f.area === a).length}
                </button>
              ))}
            </div>
          )}
          {mixedSources && (
            <div className="seg-control sm" role="tablist" aria-label="Idea sources">
              <button className={`seg-opt ${sourceFilter === '' ? 'on' : ''}`} onClick={() => setSourceFilter('')}>All</button>
              <button className={`seg-opt ${sourceFilter === 'hook' ? 'on' : ''}`} onClick={() => setSourceFilter('hook')}
                title="Ideas auto-extracted from pushes and reviews">Generated</button>
              <button className={`seg-opt ${sourceFilter === 'manual' ? 'on' : ''}`} onClick={() => setSourceFilter('manual')}
                title="Ideas you typed (or agreed with Polaris)">Manual</button>
            </div>
          )}
          <div className="seg-control sm" role="tablist" aria-label="Ideas view">
            <button className={`seg-opt ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}>List</button>
            <button className={`seg-opt ${view === 'canvas' ? 'on' : ''}`} onClick={() => setView('canvas')}>Canvas</button>
          </div>
        </div>
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder={'Could this become… ?\nFirst line is the idea — add lines below for the why.'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
            else if (e.key === 'Escape') { e.preventDefault(); setDraft(''); }
          }}
        />
        <div className="row">
          <span className="hint">⏎ to add · ⇧⏎ for a "why" line</span>
          <button className="add" onClick={add}>Add idea</button>
        </div>
      </div>

      {view === 'canvas' ? (
        // The source filter (#182) applies here too; the area chips stay
        // list-only (columns already give the canvas its structure).
        <FuturesCanvas futures={bySource} onMove={onMove} highlightId={highlightId} />
      ) : futures.length ? (
        groups.map((g) => (
          <div className="futures-group" key={g.key || 'unsorted'}>
            {judged && <div className={`futures-group-head ${g.key || 'unsorted'}`}>{g.label} <span className="n">{g.items.length}</span></div>}
            <div className="futures-list">
              {g.items.map((f) => (
                <IdeaRow key={f.id} future={f} highlighted={highlightId === String(f.id)}
                  onEdit={onEdit} onAlign={onAlign} onDelete={onDelete} onPromote={onPromote}
                  onAskGemini={onAskGemini} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="empty-state">
          <div className="big">No ideas yet</div>
          <div>Futures land here from you or from checkpoints — the loose "what ifs" worth keeping.</div>
        </div>
      )}
    </div>
  );
}

function IdeaRow({
  future: f, highlighted, onEdit, onAlign, onDelete, onPromote, onAskGemini,
}: {
  future: Future;
  highlighted?: boolean;
  onEdit: (id: number, patch: { title: string; note: string; area: string }) => void;
  onAlign: (id: number, alignment: Alignment | '') => void;
  onDelete: (id: number) => void;
  onPromote: (future: Future) => void;
  onAskGemini?: (id: number) => Promise<JudgeSuggestion>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(f.title);
  const [note, setNote] = useState(f.note);
  const [area, setArea] = useState(f.area);
  const [picking, setPicking] = useState(false);
  // Gemini's suggested verdict: shown until applied or waved away, never
  // written to the idea by itself.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<JudgeSuggestion | null>(null);
  const [suggestErr, setSuggestErr] = useState('');

  const askGemini = async () => {
    if (!onAskGemini || suggesting) return;
    setSuggesting(true);
    setSuggestErr('');
    try {
      setSuggestion(await onAskGemini(f.id));
    } catch (e) {
      setSuggestErr((e as Error)?.message || 'Gemini call failed.');
    } finally {
      setSuggesting(false);
    }
  };

  const save = () => {
    const t = title.trim();
    const a = area.trim().toLowerCase();
    if (t && (t !== f.title || note.trim() !== f.note || a !== f.area)) {
      onEdit(f.id, { title: t, note: note.trim(), area: a });
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="future-row editing" data-hl={f.id}>
        <div className="future-body">
          <input className="field-input sm" value={title} autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEditing(false); }} />
          <textarea className="field-area" style={{ marginTop: 8, minHeight: 46 }} value={note}
            placeholder="Why it might matter…" onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }} />
          <input className="field-input sm" style={{ marginTop: 8, maxWidth: 220 }} value={area}
            placeholder="area — e.g. settings, mobile (optional)"
            onChange={(e) => setArea(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEditing(false); }} />
          <div className="future-edit-row">
            <button className="btn-cancel sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn-submit sm" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`future-row ${highlighted ? 'hl' : ''}`} data-hl={f.id}>
      <div className="future-body">
        <div className="future-title">{f.title}</div>
        {f.note && <div className="future-note">{f.note}</div>}
        <div className="future-meta">
          {picking ? (
            <span className="review-pick">
              {ALIGNMENTS.map((a) => (
                <button key={a.key} className={`review-pick-opt ${a.key}`} title={a.hint}
                  onClick={() => { setPicking(false); onAlign(f.id, f.alignment === a.key ? '' : a.key); }}>
                  {a.label}
                </button>
              ))}
            </span>
          ) : (
            <button className={`align-chip ${f.alignment || 'none'}`} onClick={() => setPicking(true)}
              title={f.alignment ? 'Change the verdict (pick the same to clear)' : 'Judge this against the north star'}>
              {f.alignment ? alignLabel(f.alignment) : '✦ Judge'}
            </button>
          )}
          {onAskGemini && !suggestion && (
            <button className="gemini-btn" onClick={askGemini} disabled={suggesting}
              title="Ask Gemini for a suggested verdict — you still make the call">
              {suggesting ? '✧ Asking…' : '✧ Ask Gemini'}
            </button>
          )}
          {f.area && <span className="area-chip" title="Product area — edit the idea to change it">{f.area}</span>}
          {f.source === 'hook' && <span className="auto-badge">✦ auto</span>}
          <span className="when">{f.when}</span>
        </div>
        {suggestErr && <div className="gemini-suggest err">✧ {suggestErr}</div>}
        {suggestion && (
          <div className="gemini-suggest">
            <span className="g-verdict">✧ Gemini suggests <b>{alignLabel(suggestion.alignment)}</b></span>
            <span className="g-why">— {suggestion.why}</span>
            <button className="g-apply" onClick={() => { onAlign(f.id, suggestion.alignment); setSuggestion(null); }}>
              Apply
            </button>
            <button className="g-dismiss" onClick={() => setSuggestion(null)} aria-label="Dismiss suggestion">×</button>
          </div>
        )}
      </div>
      <div className="future-actions">
        <button className="edit" onClick={() => { setTitle(f.title); setNote(f.note); setEditing(true); }} aria-label="Edit idea" title="Edit idea">✎</button>
        <button className="promote" onClick={() => onPromote(f)}>→ Roadmap</button>
        <button className="dismiss" onClick={() => onDelete(f.id)}>Dismiss</button>
      </div>
    </div>
  );
}
