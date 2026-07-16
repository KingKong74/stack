import { useRef, useState } from 'react';
import type { Priority } from '../types';
import { Modal } from './Modal';
import { PRIORITY_META } from '../lib/ui';

// Add OR edit a roadmap item — `mode: 'edit'` prefills and relabels.
// A stray click on the overlay (or Escape) with typed content calls onDismiss
// with the fields so the caller can keep a draft; the explicit Cancel button
// stays a genuine discard.
export function RoadmapModal({
  initialPriority, onClose, onSubmit, onDismiss, onSuggestTitle,
  initialTitle = '', initialNote = '', initialLane = '', initialArea = '',
  lanes = [], areas = [], mode = 'add',
}: {
  initialPriority: Priority; onClose: () => void;
  onSubmit: (v: { title: string; note: string; priority: Priority; lane: string; area: string }) => void;
  onDismiss?: (v: { title: string; note: string; priority: Priority; lane: string; area: string }) => void;
  onSuggestTitle?: (note: string) => Promise<string>;
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

  const suggest = async () => {
    if (!onSuggestTitle || !note.trim() || suggesting) return;
    setSuggesting(true);
    setSuggestErr('');
    try {
      setTitle(await onSuggestTitle(note));
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
        What is it?
        {onSuggestTitle && (
          <button type="button" className="gemini-btn sm" onClick={suggest}
            disabled={!note.trim() || suggesting}
            title={note.trim() ? 'Gemini titles it from the note' : 'Write the note first — the title comes from it'}>
            {suggesting ? '✧ Titling…' : '✧ Title from note'}
          </button>
        )}
      </div>
      <input className="field-input" style={{ marginBottom: 6 }} value={title} autoFocus
        placeholder="e.g. Offline map caching" onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      {suggestErr && <div className="gemini-suggest err" style={{ marginBottom: 10 }}>✧ {suggestErr}</div>}
      <div className="lbl" style={{ marginTop: 10 }}>Note <span className="optional">what you actually want done</span></div>
      <textarea className="field-area" style={{ marginBottom: 18, overflow: 'hidden' }} value={note} ref={noteRef}
        placeholder="The outcome you're after, acceptance criteria, context…"
        onChange={(e) => { setNote(e.target.value); growNote(); }} />
      <div className="lbl">Area <span className="optional">optional — which part of the project</span></div>
      <input className="field-input" style={{ marginBottom: 18 }} value={area} list="road-areas"
        placeholder="e.g. settings, mobile, api" onChange={(e) => setArea(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      {areas.length > 0 && (
        <datalist id="road-areas">
          {areas.map((a) => <option key={a} value={a} />)}
        </datalist>
      )}
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
