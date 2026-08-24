import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoute, go } from '../lib/route';
import { PRIORITY_META } from '../lib/ui';
import type { Priority, Project } from '../types';
import {
  createRoadmapItem, getProjects, getLastViewedProject, emitItemFiled,
  assistRoadmapItem, getAgentState, agentCan, agentOffReason,
  type TabAgentState,
} from '../store';

// The bottom-left corner used to hold the recipe library. It holds the ＋
// instead: the thing you reach for from any screen is somewhere to put what you
// just decided before it is gone.
//
// It had TWO destinations until the Workbench was culled — a roadmap item, or a
// Thought filed as a note the canvas drew. The canvas went and the notes went
// with it, so the ＋ is single-purpose now, and that is the honest shape: a
// composer whose second destination is a table nothing reads is a write into
// the dark. Anything unfinished goes on the board as a `could`, where at least
// it is somewhere the owner looks.
//
// A filed item lands as `source: 'manual'`, which is deliberate: a manual item
// is NEVER held from the runner (unlike a hook-extracted one), because blocking
// hand-written work is the failure mode the approval rule exists to avoid.
//
// It is app-wide, so it needs a project the way ▶ Run did: the one you are
// looking at, else the last project you opened, else the first on the list.
// The picker stays visible even when there is only one — a quick-add whose
// target is implicit is a quick-add that files into the wrong app once.
//
// ✧ FILL FROM NOTE — the CURATOR's `assist`, the same op and the same route the
// Roadmap modal's ✧ uses. Same rule too: it fills what you left EMPTY and never
// re-decides what you typed. What it does NOT take here is as deliberate as
// what it does. `tier` is the run queue's own rank and this composer has no
// control for it, and `risk` sent from a form the human did not touch would be
// credited as a HUMAN decision (`risk_source`, #262) and lock out the plan-time
// pre-pass — so a quick add leaves both unset and the full modal keeps being
// where they are decided. `area` it does take, and shows as a chip you can
// drop: untagged work is in no lane, which is the population that quietly
// never runs.
//
// Readiness comes from `GET /api/agents/state` — the same map a project tab
// reads, so this cannot grow a second opinion about whether an agent may act.
// Unknown means yes (`agentCan`), so a slow or older server offers a button
// that answers honestly rather than hiding one that works; a switched-off agent
// or a missing backend takes the button AWAY and leaves the sentence that says
// which, since a dead ✧ explaining itself is the thing that rule forbids.
export function QuickAddDock() {
  const route = useRoute();
  const [open, setOpen] = useState(false);

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState('');
  const [slug, setSlug] = useState('');

  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState<Priority>('should');

  // The assist's area suggestion, held as a droppable chip: the composer has no
  // area field to fill, and applying one invisibly would tag work with a lane
  // nobody chose. '' = none suggested (or dropped).
  const [area, setArea] = useState('');
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistErr, setAssistErr] = useState('');
  const [agents, setAgents] = useState<TabAgentState | undefined>(undefined);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What the last save actually created — kept so the sheet can offer the way
  // to it. A save with no way back reads as a press that went nowhere.
  const [filed, setFiled] = useState<{ id: number; slug: string } | null>(null);

  const firstField = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  // The note box is three rows because a quick add is usually a line. The ✧
  // fills paragraphs into it, and a composer that hides what you are about to
  // save is worse than a tall one — so it grows to what it holds, to a cap,
  // and scrolls beyond that rather than taking over the sheet.
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const growNote = () => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

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

  // Whether the ✧ may be drawn. Read once per open, and NOT per project: the map is
  // app-wide (the agents are the app's, not a project's), which is why it has a
  // route of its own rather than riding a detail payload.
  useEffect(() => {
    if (!open || agents) return;
    let live = true;
    // A failed read leaves it undefined, which agentCan reads as YES — the
    // buttons stay and the server refuses honestly if it has to. Hiding a
    // working feature because a readiness probe fell over is the worse way
    // round.
    getAgentState().then((s) => { if (live) setAgents(s); }).catch(() => { /* unknown means yes */ });
    return () => { live = false; };
  }, [open, agents]);

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
  }, [open]);

  const project = (projects || []).find((p) => p.id === slug);
  // The button and the sentence beside a missing one are read off the one map,
  // so this can never print a reason it did not check.
  const curatorCan = agentCan(agents, 'curator', 'assist');
  const curatorOff = agentOffReason(agents, 'curator', 'assist');
  const ready = Boolean(slug) && !busy;
  const filled = title.trim().length > 0;

  // ✧ Fill from note. The note leads, but a quick add is often a title and
  // nothing else — so whatever you actually typed is what it reads, rather than
  // refusing over an empty second field.
  const assistSource = note.trim() || title.trim();
  async function assist() {
    if (!slug || !assistSource || assistBusy) return;
    setAssistBusy(true);
    setAssistErr('');
    try {
      const s = await assistRoadmapItem(slug, assistSource);
      // Fills gaps, never re-decides: the title only when you left it empty.
      // The note is the exception by design — it is the input, and tidying it
      // is the feature.
      if (!title.trim()) setTitle(s.title);
      if (s.note) { setNote(s.note); requestAnimationFrame(growNote); }
      if (s.priority) setPriority(s.priority);
      if (s.area) setArea(s.area);
      // s.branch / s.tier / s.tierSuggested / s.risk are deliberately dropped
      // here — see the header. They are the full modal's to decide.
    } catch (e) {
      setAssistErr((e as Error)?.message || 'The Curator could not answer.');
    } finally {
      setAssistBusy(false);
    }
  }

  async function save() {
    if (!ready || !filled) return;
    setBusy(true);
    setError('');
    try {
      const item = await createRoadmapItem(slug, {
        title: title.trim(), note: note.trim(), bucket: priority,
        // Only when there is one to send: an empty string is a real area
        // value ('' = untagged) and posting it would be indistinguishable
        // from a lane somebody chose.
        ...(area ? { area } : {}),
      });
      setFiled({ id: item.id, slug });
      setTitle(''); setNote(''); setArea(''); setAssistErr('');
      requestAnimationFrame(growNote);   // a box grown to a filled note must shrink back with it
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
    go.detail(filed.slug, 'roadmap', String(filed.id));
  };

  return (
    <>
      <button className={`quick-dock ${open ? 'on' : ''}`} onClick={() => { setOpen((o) => !o); setFiled(null); setError(''); }}
        title="Add a roadmap item" aria-label="Quick add">
        {/* An ASCII '+', not the fullwidth ＋ the rest of the app writes in
            prose: the body font has no glyph for U+FF0B and the pill rendered
            a tofu box — which the strict build cannot see and only shows up at
            3× on the collapsed, label-less pill. */}
        <span className="glyph">+</span>
        <span className="label">Add</span>
      </button>
      {open && (
        <>
          <div className="quick-scrim" onClick={() => setOpen(false)} />
          <div className="quick-sheet" role="dialog" aria-label="Quick add">
            <div className="qa-head">
              <div className="qa-title">◆ Roadmap item</div>
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

            <input ref={firstField as React.RefObject<HTMLInputElement>} className="qa-input"
              placeholder="What needs building?" value={title} maxLength={300}
              onChange={(e) => { setTitle(e.target.value); setFiled(null); }} onKeyDown={onFieldKey} />
            <textarea ref={noteRef} className="qa-area" rows={3} placeholder="Note — the why, the shape, what done looks like (optional)"
              value={note} maxLength={1000}
              onChange={(e) => { setNote(e.target.value); growNote(); }} onKeyDown={onFieldKey} />
            <div className="qa-tools">
              {curatorCan ? (
                <button type="button" className="gemini-btn sm" onClick={() => void assist()}
                  disabled={!assistSource || assistBusy || !slug}
                  title={assistSource
                    ? 'The Curator fills the title, priority and area from what you have written, and tidies the note'
                    : 'Write something first — it all comes from what you typed'}>
                  {assistBusy ? '✧ Filling…' : '✧ Fill from note'}
                </button>
              ) : <span className="qa-hint">{curatorOff}</span>}
            </div>
            <div className="qa-priorities">
              {PRIORITY_META.map((p) => (
                <button key={p.key} className={`qa-pri ${priority === p.key ? 'on' : ''}`}
                  onClick={() => setPriority(p.key)}
                  style={priority === p.key ? { borderColor: p.color, color: p.color } : undefined}>
                  {p.short}
                </button>
              ))}
            </div>
            {/* The one field the assist fills that this composer cannot
                show: an area is a LANE, so it is drawn where you can see
                it and drop it, never applied out of sight. */}
            {area && (
              <div className="qa-chiprow">
                <span className="qa-chip">area · {area}
                  <button className="x" onClick={() => setArea('')} aria-label="Drop the suggested area">×</button>
                </span>
                <span className="qa-hint">✧ suggested — untagged work sits in no lane</span>
              </div>
            )}
            {assistErr && <div className="qa-err">✧ {assistErr}</div>}

            {error && <div className="qa-err">{error}</div>}
            {filed && !error && (
              <div className="qa-filed">
                <span>Filed #{filed.id} in {project?.name || filed.slug}.</span>
                <button className="qa-link" onClick={openFiled}>Open on the Roadmap →</button>
              </div>
            )}

            <div className="qa-foot">
              <span className="qa-kbd">⌘↵ to save · esc to close</span>
              <button className="btn-accent" disabled={!ready || !filled} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Add to roadmap'}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
