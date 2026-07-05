import { useState } from 'react';
import type { Priority } from '../types';
import { Modal } from './Modal';
import { PRIORITY_META } from '../lib/ui';

// Add OR edit a roadmap item — `mode: 'edit'` prefills and relabels.
// A stray click on the overlay (or Escape) with typed content calls onDismiss
// with the fields so the caller can keep a draft; the explicit Cancel button
// stays a genuine discard.
export function RoadmapModal({
  initialPriority, onClose, onSubmit, onDismiss, initialTitle = '', initialNote = '', initialLane = '', mode = 'add',
}: {
  initialPriority: Priority; onClose: () => void;
  onSubmit: (v: { title: string; note: string; priority: Priority; lane: string }) => void;
  onDismiss?: (v: { title: string; note: string; priority: Priority; lane: string }) => void;
  initialTitle?: string; initialNote?: string; initialLane?: string; mode?: 'add' | 'edit';
}) {
  const [title, setTitle] = useState(initialTitle);
  const [note, setNote] = useState(initialNote);
  const [lane, setLane] = useState(initialLane);
  const [priority, setPriority] = useState<Priority>(initialPriority);
  const submit = () => { if (title.trim()) onSubmit({ title, note, priority, lane: lane.trim() }); };
  const dismiss = () => {
    if (mode === 'add' && onDismiss && (title.trim() || note.trim())) {
      onDismiss({ title, note, priority, lane: lane.trim() });
    }
    onClose();
  };

  return (
    <Modal onClose={dismiss} wide>
      <h3>{mode === 'edit' ? 'Edit roadmap item' : 'Add roadmap item'}</h3>
      <div className="lbl">What is it?</div>
      <input className="field-input" style={{ marginBottom: 16 }} value={title} autoFocus
        placeholder="e.g. Offline map caching" onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      <div className="lbl">Note <span className="optional">optional</span></div>
      <textarea className="field-area" style={{ marginBottom: 18 }} value={note}
        placeholder="Why it matters, or context…" onChange={(e) => setNote(e.target.value)} />
      <div className="lbl">Lane <span className="optional">optional — who's claiming this</span></div>
      <input className="field-input" style={{ marginBottom: 18 }} value={lane}
        placeholder="e.g. lane/ui, or a name" onChange={(e) => setLane(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
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
