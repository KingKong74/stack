import { useRef, useState } from 'react';
import type { Priority } from '../types';
import type { RoadmapAssist } from '../store';
import { Modal } from './Modal';
import { PRIORITY_META } from '../lib/ui';

// Add OR edit a roadmap item — `mode: 'edit'` prefills and relabels.
// The note leads: it's the first field and the ✧ button reads it to fill
// everything else (title, tidied note, area, lane, priority) — suggestions
// the human can still edit before saving.
// A stray click on the overlay (or Escape) with typed content calls onDismiss
// with the fields so the caller can keep a draft; the explicit Cancel button
// stays a genuine discard.
export function RoadmapModal({
  initialPriority, onClose, onSubmit, onDismiss, onAssist,
  initialTitle = '', initialNote = '', initialLane = '', initialArea = '',
  lanes = [], areas = [], mode = 'add',
}: {
  initialPriority: Priority; onClose: () => void;
  onSubmit: (v: { title: string; note: string; priority: Priority; lane: string; area: string }) => void;
  onDismiss?: (v: { title: string; note: string; priority: Priority; lane: string; area: string }) => void;
  onAssist?: (note: string) => Promise<RoadmapAssist>;
  initialTitle?: string; initialNote?: string; initialLane?: string; initialArea?: string;
  lanes?: string[]; areas?: string[]; mode?: 'add' | 'edit';
}) {
  const [title, setTitle] = useState(initialTitle);
  const [note, setNote] = useState(initialNote);
  const [lane, setLane] = useState(initialLane);
  const [area, setArea] = useState(initialArea);
  const [priority, setPriority] = useState<Priority>(initialPriority);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestErr, setSuggestErr] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Lane picker: a dropdown of the lanes already in use on this project, with
  // "New lane…" flipping to a free-text input. Starts on the input when the
  // current lane isn't in the list (or there are no lanes yet).
  const knownLanes = [...new Set([...lanes, ...(initialLane ? [initialLane] : [])])].sort();
  const [newLane, setNewLane] = useState(knownLanes.length === 0);
  // Area combobox: type freely, or pick from the project's known areas.
  const knownAreas = [...new Set([...areas, ...(initialArea ? [initialArea] : [])])].sort();
  const [areaOpen, setAreaOpen] = useState(false);
  const areaMatches = knownAreas.filter(
    (a) => !area.trim() || a.includes(area.trim().toLowerCase()));
  const fields = () => ({ title, note, priority, lane: lane.trim(), area: area.trim().toLowerCase() });
  const submit = () => { if (title.trim()) onSubmit(fields()); };
  const typed = Boolean(title.trim() || note.trim());
  const dismiss = () => {
    if (mode === 'add' && onDismiss && typed) onDismiss(fields());
    onClose();
  };

  // The note grows with its content — no inner scrolling while composing.
  const growNote = () => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };

  const assist = async () => {
    if (!onAssist || !note.trim() || suggesting) return;
    setSuggesting(true);
    setSuggestErr('');
    try {
      const s = await onAssist(note);
      setTitle(s.title);
      if (s.note) { setNote(s.note); requestAnimationFrame(growNote); }
      if (s.area) setArea(s.area);
      if (s.lane) { setLane(s.lane); setNewLane(false); }
      if (s.priority) setPriority(s.priority);
    } catch (e) {
      setSuggestErr((e as Error)?.message || 'Gemini call failed.');
    } finally {
      setSuggesting(false);
    }
  };

  return (
    // Clicking off with typed content closes AND keeps a draft (add mode) —
    // the draft chip on the Roadmap bar brings it back. Cancel is the real
    // discard. (`typed` feeds dismiss(), which decides whether to save.)
    <Modal onClose={dismiss} wide>
      <h3>{mode === 'edit' ? 'Edit roadmap item' : 'Add roadmap item'}</h3>
      <div className="lbl lbl-row">
        Note <span className="optional">what you actually want done — start here</span>
        {onAssist && (
          <button type="button" className="gemini-btn sm" onClick={assist}
            disabled={!note.trim() || suggesting}
            title={note.trim()
              ? 'Gemini fills the title, area, priority (and tidies the note) from what you wrote'
              : 'Write the note first — everything comes from it'}>
            {suggesting ? '✧ Filling…' : '✧ Fill from note'}
          </button>
        )}
      </div>
      <textarea className="field-area" style={{ marginBottom: 6, overflow: 'hidden' }} value={note} ref={noteRef}
        autoFocus={mode === 'add'}
        placeholder="The outcome you're after, acceptance criteria, context…"
        onChange={(e) => { setNote(e.target.value); growNote(); }} />
      {suggestErr && <div className="gemini-suggest err" style={{ marginBottom: 10 }}>✧ {suggestErr}</div>}
      <div className="lbl" style={{ marginTop: 10 }}>What is it?</div>
      <input className="field-input" style={{ marginBottom: 18 }} value={title} autoFocus={mode === 'edit'}
        placeholder="e.g. Offline map caching" onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      <div className="lbl">Area <span className="optional">optional — which part of the project</span></div>
      <div className="combo" style={{ marginBottom: 18 }}>
        <input className="field-input" value={area}
          placeholder="e.g. settings, mobile, api"
          onChange={(e) => { setArea(e.target.value); setAreaOpen(true); }}
          onFocus={() => setAreaOpen(true)}
          onBlur={() => setAreaOpen(false)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setAreaOpen(false); submit(); } if (e.key === 'Escape') setAreaOpen(false); }} />
        {areaOpen && areaMatches.length > 0 && (
          <div className="combo-list">
            {areaMatches.map((a) => (
              // onMouseDown beats the input's blur, so the pick actually lands.
              <button type="button" className={`combo-opt ${a === area.trim().toLowerCase() ? 'on' : ''}`} key={a}
                onMouseDown={(e) => { e.preventDefault(); setArea(a); setAreaOpen(false); }}>
                {a}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="lbl">Lane <span className="optional">optional — who's claiming this</span></div>
      {!newLane ? (
        <div className="lane-pick" style={{ marginBottom: 8 }}>
          <select className="field-input" value={lane} onChange={(e) => setLane(e.target.value)}>
            <option value="">No lane — open for anyone</option>
            {knownLanes.map((l) => <option key={l} value={l}>⚑ {l}</option>)}
          </select>
          <button type="button" className="btn-cancel sm" onClick={() => { setLane(''); setNewLane(true); }}>
            + New lane
          </button>
        </div>
      ) : (
        <div className="lane-pick" style={{ marginBottom: 8 }}>
          <input className="field-input" value={lane}
            placeholder="e.g. lane/ui, autopilot, or a name" onChange={(e) => setLane(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          {knownLanes.length > 0 && (
            <button type="button" className="btn-cancel sm" onClick={() => { setLane(''); setNewLane(false); }}>
              Pick existing
            </button>
          )}
        </div>
      )}
      <div className="field-hint" style={{ marginBottom: 18 }}>
        A lane claims the item for one session or agent — other sessions (and the overnight
        autopilot) see the ⚑ claim and leave it alone. Clear the lane to release it.
      </div>
      <div className="lbl" style={{ marginBottom: 9 }}>Priority</div>
      <div className="seg" style={{ marginBottom: 26 }}>
        {PRIORITY_META.map((p) => (
          <button key={p.key} className={`opt prio ${p.key} ${priority === p.key ? 'on' : ''}`} onClick={() => setPriority(p.key)}>
            {p.short}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
        <button className="btn-submit" onClick={submit}>{mode === 'edit' ? 'Save changes' : 'Add item'}</button>
      </div>
    </Modal>
  );
}
