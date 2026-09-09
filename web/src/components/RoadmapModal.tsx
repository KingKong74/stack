import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanStep } from '../types';
import type { RoadmapAssist } from '../store';
import { Modal } from './Modal';

// Add OR edit a roadmap item — `mode: 'edit'` prefills and relabels.
// The note leads: it's the first field and the ✧ button reads it to fill the
// rest — suggestions the human can still edit before saving.
//
// FOUR FIELDS CAME OFF THIS MODAL AT THE OWNER'S REQUEST (#469): PRIORITY, the
// desire TIER, RISK and the BRANCH claim. What is left is the work itself —
// note, title, area, sub-area, plan. Priority moved rather than went: the
// board's card picker writes `bucket` and is now its only writer, which is why
// this modal no longer needs `initialPriority` at all.
//
// THE OTHER THREE HAVE NO WRITER LEFT IN ANY BROWSER, and that is a real
// consequence rather than a tidy-up, so it is written down here once:
//
//  • `tier` (#227) is the PRIMARY sort of the overnight run queue — ahead of
//    priority. This modal was its only surface, so stored tiers now stand
//    still: the queue keeps ordering by them and nothing can re-rank one
//    except `./stack` and the API.
//  • `risk` (#212/#262) decides whether a green overnight run merges ITSELF.
//    A human `risk_source` could only be set here, so risk is now auto-only —
//    the plan-time pre-pass writes it and nobody can overrule the pre-pass
//    from a browser. `risk_source` still guards the write (an auto pass may
//    only replace the NULL nobody chose), so nothing is at risk of being
//    silently re-tiered; there is simply no longer a human in that loop.
//  • `claimed_by` (#277) is the branch claim. It was already gone from the
//    board (#443) and this was the last writer, so a claim can be made and
//    released only by a session or by the API.
//
// The ✧ assist still ANSWERS with a branch, a priority, a tier and a risk —
// the route and `assistFields` in Settings are unchanged — and this modal now
// drops all four on the floor. Settings still offers toggles for them, which
// is the one loose end: they govern a fill that has nowhere to land.
//
// A stray click on the overlay (or Escape) with typed content calls onDismiss
// with the fields so the caller can keep a draft; the explicit Cancel button
// stays a genuine discard.
// What the modal hands back on save (and on a draft-keeping dismiss).
export interface RoadmapFields {
  title: string; note: string; area: string; subArea: string; plan: PlanStep[];
}

export function RoadmapModal({
  onClose, onSubmit, onDismiss, onAssist,
  initialTitle = '', initialNote = '', initialArea = '', initialPlan = [],
  areas = [], subAreas = [], initialSubArea = '', mode = 'add',
}: {
  onClose: () => void;
  onSubmit: (v: RoadmapFields) => void;
  onDismiss?: (v: RoadmapFields) => void;
  onAssist?: (note: string) => Promise<RoadmapAssist>;
  initialTitle?: string; initialNote?: string; initialArea?: string;
  initialPlan?: PlanStep[];
  areas?: string[]; subAreas?: string[]; initialSubArea?: string; mode?: 'add' | 'edit';
}) {
  const [title, setTitle] = useState(initialTitle);
  const [note, setNote] = useState(initialNote);
  const [area, setArea] = useState(initialArea);
  const [subArea, setSubArea] = useState(initialSubArea);
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
  // Area combobox: type freely, or pick from the project's known areas.
  const knownAreas = [...new Set([...areas, ...(initialArea ? [initialArea] : [])])].sort();
  const [areaOpen, setAreaOpen] = useState(false);
  const areaMatches = knownAreas.filter(
    (a) => !area.trim() || a.includes(area.trim().toLowerCase()));
  // #411 — the sub-areas already in use, narrowed to the area you have chosen.
  // There is no sub-area table to read: the set IS the distinct values in use,
  // so offering ones from a DIFFERENT area would invent a hierarchy nobody made.
  const [subOpen, setSubOpen] = useState(false);
  const knownSubAreas = [...new Set([...subAreas, ...(initialSubArea ? [initialSubArea] : [])])].sort();
  const subMatches = knownSubAreas.filter(
    (a) => !subArea.trim() || a.includes(subArea.trim().toLowerCase()));
  const fields = (): RoadmapFields =>
    ({ title, note, area: area.trim().toLowerCase(), subArea: subArea.trim().toLowerCase(), plan: fullPlan() });
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
      // fills gaps, it doesn't re-decide. The note is the exception by design:
      // it is the input, and tidying it is the feature.
      //
      // #469 — `s.branch`, `s.priority`, `s.tier`, `s.tierSuggested` and
      // `s.risk` are still ANSWERED by the route and are dropped here, because
      // the fields they filled came off this modal. Dropped explicitly rather
      // than by omission: the shape still carries them, and a later reader
      // should see that ignoring them is a decision.
      if (!title.trim()) setTitle(s.title);
      if (s.note) { setNote(s.note); requestAnimationFrame(growNote); }
      if (s.area && !area.trim()) setArea(s.area);
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
              ? 'Gemini fills the title and area (and tidies the note) from what you wrote'
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
      {/* #411 — only under a chosen area. A sub-area with no area above it is
          not a second level, it is a second area spelled in the wrong field. */}
      {area.trim() && (
        <>
          <div className="lbl">Sub-area <span className="optional">optional — a finer split within {area.trim().toLowerCase()}</span></div>
          <div className="combo" style={{ marginBottom: 18 }}>
            <input className="field-input" value={subArea}
              placeholder="e.g. timeline, scope, plan"
              onChange={(e) => { setSubArea(e.target.value); setSubOpen(true); }}
              onFocus={() => setSubOpen(true)}
              onBlur={() => setSubOpen(false)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setSubOpen(false); submit(); } if (e.key === 'Escape') setSubOpen(false); }} />
            {subOpen && subMatches.length > 0 && (
              <div className="combo-list">
                {subMatches.map((a) => (
                  <button type="button" className={`combo-opt ${a === subArea.trim().toLowerCase() ? 'on' : ''}`} key={a}
                    onMouseDown={(e) => { e.preventDefault(); setSubArea(a); setSubOpen(false); }}>
                    {a}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
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
      <div className="modal-actions">
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
        <button className="btn-submit" onClick={submit}>
          {mode === 'edit' ? 'Save changes' : 'Add item'}
        </button>
      </div>
    </Modal>
  );
}
