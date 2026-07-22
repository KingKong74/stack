import { useCallback, useEffect, useRef, useState } from 'react';
import type { Priority, PlanStep, RoadmapItem } from '../types';
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
  initialTitle = '', initialNote = '', initialLane = '', initialArea = '', initialPlan = [],
  initialRisk = 'normal', lanes = [], areas = [], mode = 'add',
}: {
  initialPriority: Priority; onClose: () => void;
  onSubmit: (v: { title: string; note: string; priority: Priority; lane: string; area: string; plan: PlanStep[]; risk: RoadmapItem['risk'] }) => void;
  onDismiss?: (v: { title: string; note: string; priority: Priority; lane: string; area: string; plan: PlanStep[]; risk: RoadmapItem['risk'] }) => void;
  onAssist?: (note: string) => Promise<RoadmapAssist>;
  initialTitle?: string; initialNote?: string; initialLane?: string; initialArea?: string;
  initialPlan?: PlanStep[]; initialRisk?: RoadmapItem['risk'];
  lanes?: string[]; areas?: string[]; mode?: 'add' | 'edit';
}) {
  const [title, setTitle] = useState(initialTitle);
  const [note, setNote] = useState(initialNote);
  const [lane, setLane] = useState(initialLane);
  const [area, setArea] = useState(initialArea);
  const [priority, setPriority] = useState<Priority>(initialPriority);
  const [risk, setRisk] = useState<RoadmapItem['risk']>(initialRisk);
  // The implementation plan (#75): ordered steps for bigger work. A pending
  // draft line is folded in on save so a typed-but-not-entered step isn't lost.
  const [plan, setPlan] = useState<PlanStep[]>(initialPlan);
  const [planDraft, setPlanDraft] = useState('');
  const addStep = () => {
    const text = planDraft.trim().slice(0, 300);
    if (!text) return;
    setPlan((p) => [...p, { text, done: false }]);
    setPlanDraft('');
  };
  const fullPlan = () =>
    planDraft.trim() ? [...plan, { text: planDraft.trim().slice(0, 300), done: false }] : plan;
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
  const fields = () => ({ title, note, priority, lane: lane.trim(), area: area.trim().toLowerCase(), plan: fullPlan(), risk });
  const submit = () => { if (title.trim()) onSubmit(fields()); };
  const typed = Boolean(title.trim() || note.trim());
  const dismiss = () => {
    if (mode === 'add' && onDismiss && typed) onDismiss(fields());
    onClose();
  };

  // The note grows with its content — no inner scrolling while composing.
  // #147: also called on mount so edit-mode reopens at the right height.
  const growNote = useCallback(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, []);

  // #147: size the textarea to its initial content as soon as the modal mounts.
  useEffect(() => {
    growNote();
  }, [growNote]);

  const assist = async () => {
    if (!onAssist || !note.trim() || suggesting) return;
    setSuggesting(true);
    setSuggestErr('');
    try {
      const s = await onAssist(note);
      // Never overwrite a field the human already filled (#211) — the assist
      // fills gaps, it doesn't re-decide. The note is the exception by design
      // (it's the input; tidying it is the feature), and priority always
      // carries a value so a suggestion may still refine it.
      if (!title.trim()) setTitle(s.title);
      if (s.note) { setNote(s.note); requestAnimationFrame(growNote); }
      if (s.area && !area.trim()) setArea(s.area);
      if (s.lane && !lane.trim()) { setLane(s.lane); setNewLane(false); }
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
      <textarea className="field-area" style={{ marginBottom: 6, overflow: 'hidden', minHeight: 60, maxHeight: 320 }} value={note} ref={noteRef}
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
      <div className="lbl">Plan <span className="optional">optional — ordered steps for bigger work; whoever builds it ticks them off</span></div>
      <div className="plan-edit" style={{ marginBottom: 18 }}>
        {plan.map((s, idx) => (
          <div className="plan-row" key={idx}>
            <input type="checkbox" checked={s.done}
              onChange={() => setPlan(plan.map((p, i) => (i === idx ? { ...p, done: !p.done } : p)))} />
            <span className={`plan-text ${s.done ? 'done' : ''}`}>{s.text}</span>
            <button type="button" className="plan-x" aria-label="Remove step" title="Remove step"
              onClick={() => setPlan(plan.filter((_, i) => i !== idx))}>×</button>
          </div>
        ))}
        <input className="field-input" value={planDraft}
          placeholder={plan.length ? 'add another step… (Enter)' : 'first step… (Enter to add)'}
          onChange={(e) => setPlanDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } }} />
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
      <div className="lbl" style={{ marginBottom: 9 }}>
        Risk <span className="optional">low = a green overnight run merges itself; you still give the verdict</span>
      </div>
      <div className="seg" style={{ marginBottom: 26 }}>
        {(['low', 'normal', 'high'] as const).map((r) => (
          <button key={r} type="button" className={`opt risk-${r} ${risk === r ? 'on' : ''}`} onClick={() => setRisk(r)}>
            {r === 'low' ? 'Low' : r === 'normal' ? 'Normal' : 'High'}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
        <button className="btn-submit" onClick={submit}>
          {mode === 'edit' ? 'Save changes' : 'Add item'}
        </button>
      </div>
    </Modal>
  );
}
