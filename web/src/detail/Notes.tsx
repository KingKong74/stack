// NOTES — the owner's loose ideas, a rail row of their own under the board
// (owner's call, 2026-11-09). A note is not work: nothing counts it, nothing
// runs it, and no agent reads it. It is where an idea waits until it is ready
// to become a MILESTONE, a SLICE or a TASK.
//
//  • A NOTE IS A `note` ARTIFACT (routes/artifacts.js): Markdown, its first
//    line is its title. The plain Artifacts list leaves notes out.
//  • TURNING ONE INTO WORK splits it: the first line names the new milestone,
//    slice or task, and the rest becomes its goal, spec or notes. It is an
//    ordinary create (a milestone is born Upcoming, never current; a task with
//    no slice goes to the Icebox), the same writes the board and Milestones
//    make.
//  • A CONVERTED NOTE IS KEPT, tagged `converted` and `became:<kind>:<id>`,
//    so where an idea went stays findable. It folds into "Converted" below.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown } from '../components/Markdown';
import type { Artifact, Milestone, Slice } from '../types';
import { getNotes, createArtifact, patchArtifact, deleteArtifact, createMilestone, createSlice, createRoadmapItem } from '../store';
import { SlicePicker, currentMilestone } from './Spine';
import { PRIORITY_DEFAULT, timeAgo } from '../lib/ui';

type Kind = 'milestone' | 'slice' | 'task';
const KIND_LABEL: Record<Kind, string> = { milestone: 'Milestone', slice: 'Slice', task: 'Task' };

/** The first non-empty line, without a heading or list marker, and the rest. */
function split(body: string): { head: string; rest: string } {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return { head: '', rest: '' };
  const head = lines[i].replace(/^\s*(#+|[-*]|\d+\.)\s*/, '').trim();
  return { head, rest: lines.slice(i + 1).join('\n').trim() };
}
const became = (n: Artifact) => {
  const tag = n.tags.find((t) => t.startsWith('became:'));
  if (!tag) return null;
  const [, kind, id] = tag.split(':');
  return { kind: kind as Kind, id: Number(id) };
};

export function Notes({ slug, milestones, slices, onRefresh }: {
  slug: string; milestones: Milestone[]; slices: Slice[]; onRefresh: () => void;
}) {
  const [notes, setNotes] = useState<Artifact[] | null>(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    getNotes(slug).then(setNotes).catch((e) => setErr((e as Error)?.message || 'Could not read the notes.'));
  }, [slug]);
  useEffect(() => { setNotes(null); load(); }, [load]);
  const put = (a: Artifact) => setNotes((xs) => {
    const list = xs || [];
    return list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a];
  });
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr((e as Error)?.message || 'Something went wrong.'); } finally { setBusy(false); }
  };

  const add = () => guard(async () => {
    const body = draft.trim();
    if (!body) return;
    put(await createArtifact(slug, { type: 'note', title: split(body).head.slice(0, 300) || 'Note', body }));
    setDraft('');
  });

  // Newest first: a scratchpad is read from the top.
  const sorted = useMemo(() => [...(notes || [])].sort((a, b) => b.id - a.id), [notes]);
  const open = sorted.filter((n) => !n.tags.includes('converted'));
  const done = sorted.filter((n) => n.tags.includes('converted'));

  const whereTo = (n: Artifact) => {
    const b = became(n);
    if (!b) return 'Converted';
    if (b.kind === 'milestone') return `Became milestone “${milestones.find((m) => m.id === b.id)?.name ?? `#${b.id}`}”`;
    if (b.kind === 'slice') return `Became slice “${slices.find((s) => s.id === b.id)?.title ?? `#${b.id}`}”`;
    return `Became task #${b.id}`;
  };

  const convert = (n: Artifact, kind: Kind, target: number | null) => guard(async () => {
    const { head, rest } = split(n.body);
    if (!head) throw new Error('This note has no first line to name it by.');
    let id: number;
    if (kind === 'milestone') {
      id = (await createMilestone(slug, { name: head.slice(0, 120), goal: rest })).id;
    } else if (kind === 'slice') {
      if (target === null) throw new Error('Pick the milestone this slice belongs to.');
      id = (await createSlice(slug, { title: head.slice(0, 200), spec: rest, milestoneId: target })).id;
    } else {
      id = (await createRoadmapItem(slug, {
        title: head, note: rest, bucket: PRIORITY_DEFAULT, kind: 'task', ...(target !== null ? { sliceId: target } : {}),
      })).id;
    }
    put(await patchArtifact(slug, n.id, { tags: [...n.tags.filter((t) => t !== 'converted' && !t.startsWith('became:')), 'converted', `became:${kind}:${id}`] }));
    onRefresh();
  });

  return (
    <div className="sp nt">
      <div className="sp-lede">
        <h2 className="sp-h">Notes</h2>
        <span>Loose ideas and notes. Nothing here is work yet: when one is ready, turn it into a milestone, a slice or a task. Its first line becomes the name.</span>
      </div>
      {err && <div className="km-err" role="alert">{err}</div>}

      <div className="nt-compose">
        <textarea className="km-textarea" rows={3} value={draft} placeholder="Jot an idea… (⌘/Ctrl + Enter to save)"
          aria-label="New note"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }} />
        <div className="sp-docacts">
          <button className="k-btn sm" onClick={add} disabled={busy || !draft.trim()}>
            <KitIcon name="plus" size={13} />Add note
          </button>
        </div>
      </div>

      {notes === null && !err && <span className="sp-empty">Reading…</span>}
      {notes !== null && open.length === 0 && <span className="sp-empty">No open notes. Anything you jot above lands here.</span>}
      <div className="nt-list">
        {open.map((n) => (
          <NoteCard key={n.id} note={n} busy={busy} milestones={milestones} slices={slices}
            onSave={(body) => guard(async () => { put(await patchArtifact(slug, n.id, { body, title: split(body).head.slice(0, 300) || 'Note' })); })}
            onDelete={() => guard(async () => { await deleteArtifact(slug, n.id); setNotes((xs) => (xs || []).filter((x) => x.id !== n.id)); })}
            onConvert={(kind, target) => convert(n, kind, target)} />
        ))}
      </div>

      {done.length > 0 && (
        <details className="nt-done">
          <summary><span className="sp-eyebrow">Converted</span><span className="sp-dim">{done.length}</span></summary>
          <div className="nt-list">
            {done.map((n) => (
              <div key={n.id} className="nt-card converted">
                <div className="nt-body"><Markdown text={n.body} /></div>
                <div className="nt-foot">
                  <span className="k-tag success">{whereTo(n)}</span>
                  <span className="sp-rule" />
                  <span className="sp-when">{timeAgo(n.updatedAt)}</span>
                  <button className="k-btn ghost sm" disabled={busy}
                    onClick={() => guard(async () => { put(await patchArtifact(slug, n.id, { tags: n.tags.filter((t) => t !== 'converted' && !t.startsWith('became:')) })); })}>
                    Reopen
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function NoteCard({ note, busy, milestones, slices, onSave, onDelete, onConvert }: {
  note: Artifact; busy: boolean; milestones: Milestone[]; slices: Slice[];
  onSave: (body: string) => void; onDelete: () => void;
  onConvert: (kind: Kind, target: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const [confirming, setConfirming] = useState(false);
  const [turning, setTurning] = useState(false);
  const [kind, setKind] = useState<Kind>('task');
  const live = milestones.filter((m) => m.status !== 'done');
  const [msId, setMsId] = useState<number | null>(currentMilestone(milestones)?.id ?? live[0]?.id ?? null);
  const [sliceId, setSliceId] = useState<number | null>(null);
  const { head, rest } = split(note.body);
  const into = kind === 'milestone' ? 'its goal' : kind === 'slice' ? 'its spec' : 'its notes';

  if (editing) {
    return (
      <div className="nt-card">
        <textarea className="km-textarea" rows={6} value={text} autoFocus aria-label="Edit note"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); setEditing(false); onSave(text.trim()); }
            if (e.key === 'Escape') { setText(note.body); setEditing(false); }
          }} />
        <div className="sp-docacts">
          <button className="k-btn ghost sm" onClick={() => { setText(note.body); setEditing(false); }}>Cancel</button>
          <button className="k-btn sm" disabled={!text.trim()} onClick={() => { setEditing(false); onSave(text.trim()); }}>Save</button>
        </div>
      </div>
    );
  }
  return (
    <div className="nt-card">
      <div className="nt-body"><Markdown text={note.body} /></div>
      <div className="nt-foot">
        <span className="sp-when">{timeAgo(note.updatedAt)}</span>
        <span className="sp-rule" />
        <button className={`k-btn sm secondary${turning ? ' on' : ''}`} onClick={() => setTurning(!turning)} aria-expanded={turning}>
          <KitIcon name="arrow-up-right" size={13} />Turn into…
        </button>
        <button className="k-btn ghost sm" onClick={() => { setText(note.body); setEditing(true); }}>
          <KitIcon name="pencil" size={13} />Edit
        </button>
        <button className="k-btn ghost sm danger" onClick={() => (confirming ? onDelete() : setConfirming(true))}
          onBlur={() => setConfirming(false)}>
          {confirming ? 'Really delete?' : 'Delete'}
        </button>
      </div>
      {turning && (
        <div className="nt-turn">
          <div className="seg-control sm" role="tablist" aria-label="Turn this note into">
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <button key={k} role="tab" aria-selected={kind === k} className={`seg-opt${kind === k ? ' on' : ''}`}
                onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
            ))}
          </div>
          {kind === 'slice' && (
            <select className="k-select sm" aria-label="Milestone for the new slice" value={msId === null ? '' : String(msId)}
              onChange={(e) => setMsId(e.target.value === '' ? null : Number(e.target.value))}>
              {live.length === 0 && <option value="">No open milestone</option>}
              {live.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status === 'active' ? ' (current)' : ''}</option>)}
            </select>
          )}
          {kind === 'task' && (
            <SlicePicker value={sliceId} slices={slices} milestones={milestones} onPick={setSliceId}
              label="Slice for the new task" iceboxLabel="Icebox (no slice yet)" />
          )}
          <span className="nt-preview">
            {head
              ? <>“{head}”{rest ? <>, the rest as {into}</> : null}{kind === 'milestone' ? ', as an upcoming milestone' : ''}</>
              : 'This note has no first line to name it by.'}
          </span>
          <button className="k-btn sm" disabled={busy || !head || (kind === 'slice' && msId === null)}
            onClick={() => { setTurning(false); onConvert(kind, kind === 'slice' ? msId : kind === 'task' ? sliceId : null); }}>
            Create {KIND_LABEL[kind].toLowerCase()}
          </button>
        </div>
      )}
    </div>
  );
}
