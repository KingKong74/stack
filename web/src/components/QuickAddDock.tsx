import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoute, go } from '../lib/route';
import { PRIORITY_META } from '../lib/ui';
import type { Priority, Project } from '../types';
import {
  createNote, createRoadmapItem, getProjects, getLastViewedProject, emitItemFiled,
} from '../store';

// The bottom-left corner used to hold the recipe library. It holds the ＋
// instead: the thing you reach for from any screen is not a prompt to copy, it
// is somewhere to put the thought you just had before it is gone. Two
// destinations, because Stack already has exactly two homes for an unfinished
// thought and picking the wrong one is how they rot:
//
//   Roadmap item — work you are committing to. It lands as `source: 'manual'`,
//     which is deliberate: a manual item is NEVER held from the runner (unlike
//     a hook-extracted one), because blocking hand-written work is the failure
//     mode the approval rule exists to avoid.
//   Thought — a plain note, which IS the Workbench. A note has no card until
//     the canvas reads it and backfills one, so filing through the ordinary
//     notes route is all it takes to make it appear there; nothing here needs
//     to know the canvas exists, and nothing here should place a card (only the
//     client that rendered the canvas knows where a card fits).
//
// It is app-wide, so it needs a project the way ▶ Run did: the one you are
// looking at, else the last project you opened, else the first on the list.
// The picker stays visible even when there is only one — a quick-add whose
// target is implicit is a quick-add that files into the wrong app once.
export function QuickAddDock() {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'item' | 'thought'>('item');

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState('');
  const [slug, setSlug] = useState('');

  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState<Priority>('should');
  const [thought, setThought] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What the last save actually created — kept so the sheet can offer the way
  // to it. A save with no way back reads as a press that went nowhere.
  const [filed, setFiled] = useState<{ kind: 'item' | 'thought'; id: number; slug: string } | null>(null);

  const firstField = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const routeSlug = route.name === 'detail' ? route.id : '';

  // The list is only needed once the sheet is open — the dock is on every
  // screen and must not cost a request on every page load.
  useEffect(() => {
    if (!open || projects) return;
    let live = true;
    getProjects()
      .then((rows) => { if (live) { setProjects(rows); setProjectsError(''); } })
      .catch((e) => { if (live) setProjectsError(e?.message || 'Could not load the project list.'); });
    return () => { live = false; };
  }, [open, projects]);

  // Preferred target, in order: the project on screen, the last one opened,
  // the first that loaded. Re-runs while the sheet is open so walking onto a
  // project retargets the dock rather than filing into where you came from.
  const preferred = useMemo(() => {
    const known = new Set((projects || []).map((p) => p.id));
    const last = getLastViewedProject();
    if (routeSlug && (!projects || known.has(routeSlug))) return routeSlug;
    if (last && known.has(last)) return last;
    return projects?.[0]?.id || '';
  }, [routeSlug, projects]);

  useEffect(() => { if (open) setSlug(preferred); }, [open, preferred]);

  // Escape closes — and there is no modal above this sheet to steal it, since
  // everything it needs is in the sheet itself.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => firstField.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, mode]);

  const project = (projects || []).find((p) => p.id === slug);
  const ready = Boolean(slug) && !busy;
  const filled = mode === 'item' ? title.trim().length > 0 : thought.trim().length > 0;

  async function save() {
    if (!ready || !filled) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'item') {
        const item = await createRoadmapItem(slug, { title: title.trim(), note: note.trim(), bucket: priority });
        setFiled({ kind: 'item', id: item.id, slug });
        setTitle(''); setNote('');
      } else {
        const created = await createNote(slug, { text: thought.trim() });
        setFiled({ kind: 'thought', id: created.id, slug });
        setThought('');
      }
      // The screen underneath may be the project just written to; it holds its
      // own copy of the payload and has no props path to this dock.
      emitItemFiled(slug);
      firstField.current?.focus();
    } catch (e) {
      setError((e as Error)?.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  const onFieldKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void save(); }
  };

  const openFiled = () => {
    if (!filed) return;
    setOpen(false);
    if (filed.kind === 'item') go.detail(filed.slug, 'roadmap', String(filed.id));
    else go.detail(filed.slug, 'workbench', String(filed.id));
  };

  return (
    <>
      <button className={`quick-dock ${open ? 'on' : ''}`} onClick={() => { setOpen((o) => !o); setFiled(null); setError(''); }}
        title="Add a roadmap item, or jot a thought to the Workbench" aria-label="Quick add">
        <span className="glyph">＋</span>
        <span className="label">Add</span>
      </button>
      {open && (
        <>
          <div className="quick-scrim" onClick={() => setOpen(false)} />
          <div className="quick-sheet" role="dialog" aria-label="Quick add">
            <div className="qa-head">
              <div className="qa-modes">
                <button className={`qa-mode ${mode === 'item' ? 'on' : ''}`}
                  onClick={() => { setMode('item'); setFiled(null); setError(''); }}>◆ Roadmap item</button>
                <button className={`qa-mode ${mode === 'thought' ? 'on' : ''}`}
                  onClick={() => { setMode('thought'); setFiled(null); setError(''); }}>✎ Thought</button>
              </div>
              <button className="qa-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>

            <div className="qa-project">
              <span className="cap">in</span>
              {projects ? (
                projects.length ? (
                  <select value={slug} onChange={(e) => { setSlug(e.target.value); setFiled(null); }}>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : <span className="qa-quiet">No projects yet — a push creates the first one.</span>
              ) : <span className="qa-quiet">{projectsError || 'Loading projects…'}</span>}
            </div>

            {mode === 'item' ? (
              <>
                <input ref={firstField as React.RefObject<HTMLInputElement>} className="qa-input"
                  placeholder="What needs building?" value={title} maxLength={300}
                  onChange={(e) => { setTitle(e.target.value); setFiled(null); }} onKeyDown={onFieldKey} />
                <textarea className="qa-area" rows={3} placeholder="Note — the why, the shape, what done looks like (optional)"
                  value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} onKeyDown={onFieldKey} />
                <div className="qa-priorities">
                  {PRIORITY_META.map((p) => (
                    <button key={p.key} className={`qa-pri ${priority === p.key ? 'on' : ''}`}
                      onClick={() => setPriority(p.key)}
                      style={priority === p.key ? { borderColor: p.color, color: p.color } : undefined}>
                      {p.short}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <textarea ref={firstField as React.RefObject<HTMLTextAreaElement>} className="qa-area tall" rows={5}
                  placeholder="Jot it down — it lands on the Workbench canvas" value={thought} maxLength={4000}
                  onChange={(e) => { setThought(e.target.value); setFiled(null); }} onKeyDown={onFieldKey} />
                <div className="qa-hint">Saved as a note; the Workbench draws it as a card next time you open the canvas.</div>
              </>
            )}

            {error && <div className="qa-err">{error}</div>}
            {filed && !error && (
              <div className="qa-filed">
                <span>{filed.kind === 'item' ? `Filed #${filed.id}` : 'Jotted down'} in {project?.name || filed.slug}.</span>
                <button className="qa-link" onClick={openFiled}>
                  {filed.kind === 'item' ? 'Open on the Roadmap →' : 'Open on the Workbench →'}
                </button>
              </div>
            )}

            <div className="qa-foot">
              <span className="qa-kbd">⌘↵ to save · esc to close</span>
              <button className="btn-accent" disabled={!ready || !filled} onClick={() => void save()}>
                {busy ? 'Saving…' : mode === 'item' ? 'Add to roadmap' : 'Jot to Workbench'}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
