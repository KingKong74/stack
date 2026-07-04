import { useState } from 'react';
import type { Note } from '../types';

export function Notes({
  notes, onAdd, onEdit, onDelete, onPromote, highlightId,
}: {
  notes: Note[];
  onAdd: (text: string) => void;
  onEdit: (id: number, text: string) => void;
  onDelete: (id: number) => void;
  onPromote: (note: Note, kind: 'bug' | 'roadmap') => void;
  highlightId?: string | null;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft('');
  };

  return (
    <div>
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Notes</div>
          <div className="subtitle">Quick capture — ideas, reminders, things to fix</div>
        </div>
      </div>
      <div className="note-intro">No structure, no pressure. Jot it and get back to building.</div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder="Jot an idea, a thing to fix, anything…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }}
        />
        <div className="row">
          <span className="hint">⏎ to add · ⇧⏎ for newline</span>
          <button className="add" onClick={add}>Add note</button>
        </div>
      </div>

      <div className="notes-wall">
        {notes.map((n, i) => (
          <NoteCard key={n.id} note={n} rotate={i % 2 ? 0.7 : -0.7} highlighted={highlightId === String(n.id)}
            onEdit={onEdit} onDelete={onDelete} onPromote={onPromote} />
        ))}
      </div>
    </div>
  );
}

function NoteCard({
  note, rotate, highlighted, onEdit, onDelete, onPromote,
}: {
  note: Note;
  rotate: number;
  highlighted?: boolean;
  onEdit: (id: number, text: string) => void;
  onDelete: (id: number) => void;
  onPromote: (note: Note, kind: 'bug' | 'roadmap') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);

  const save = () => {
    const t = draft.trim();
    if (t && t !== note.text) onEdit(note.id, t);
    setEditing(false);
  };
  const cancel = () => { setDraft(note.text); setEditing(false); };

  return (
    <div className={`note ${highlighted ? 'hl' : ''}`} data-hl={note.id}
      style={{ '--note-c': note.colour, transform: `rotate(${rotate}deg)` } as React.CSSProperties}>
      <button className="x" onClick={() => onDelete(note.id)} aria-label="Delete note">×</button>
      {editing ? (
        <textarea
          className="note-edit"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
        />
      ) : (
        <div className="txt" onClick={() => { setDraft(note.text); setEditing(true); }} title="Click to edit">
          {note.text}
        </div>
      )}
      <div className="note-foot">
        <span className="when">{note.when}</span>
        {!editing && (
          <span className="note-actions">
            <button className="promote" onClick={() => onPromote(note, 'bug')}>→ Bug</button>
            <button className="promote" onClick={() => onPromote(note, 'roadmap')}>→ Roadmap</button>
          </span>
        )}
      </div>
    </div>
  );
}
