import { useCallback, useEffect, useRef, useState } from 'react';
import type { Priority, PlanStep, RoadmapItem, Tier } from '../types';
import { TIERS } from '../types';
import type { RoadmapAssist } from '../store';
import { Modal } from './Modal';
import { PRIORITY_META } from '../lib/ui';

// Add OR edit a roadmap item — `mode: 'edit'` prefills and relabels.
// The note leads: it's the first field and the ✧ button reads it to fill
// everything else (title, tidied note, area, branch, priority, tier) —
// suggestions the human can still edit before saving.
//
// #277: the desire TIER is set here as well as on the Tiers view. Bucket says
// how necessary the work is; tier says how much you want it NEXT, and it leads
// the run queue. Gemini may propose one, but only into an empty field — a tier
// you set by hand is never re-decided.
// #298: RISK is read from the note the same way, and with the same rule — it
// only ever fills a Normal nobody has touched. The one exception in both
// directions is tier S: it decides what the machine works first, so the assist
// may argue for it but only a human press applies it.
// A stray click on the overlay (or Escape) with typed content calls onDismiss
// with the fields so the caller can keep a draft; the explicit Cancel button
// stays a genuine discard.
// What the modal hands back on save (and on a draft-keeping dismiss).
export interface RoadmapFields {
  title: string; note: string; priority: Priority; branch: string; area: string; subArea: string;
  plan: PlanStep[]; risk: RoadmapItem['risk']; tier: Tier;
  riskChanged: boolean; // #262 — did the human actually touch Risk this time?
}

export function RoadmapModal({
  initialPriority, onClose, onSubmit, onDismiss, onAssist,
  initialTitle = '', initialNote = '', initialBranch = '', initialArea = '', initialPlan = [],
  initialRisk = 'normal', initialRiskSource = '', initialRiskReason = '',
  initialTier = '', branches = [], areas = [], subAreas = [], initialSubArea = '', mode = 'add',
}: {
  initialPriority: Priority; onClose: () => void;
  onSubmit: (v: RoadmapFields) => void;
  onDismiss?: (v: RoadmapFields) => void;
  onAssist?: (note: string) => Promise<RoadmapAssist>;
  initialTitle?: string; initialNote?: string; initialBranch?: string; initialArea?: string;
  initialPlan?: PlanStep[]; initialRisk?: RoadmapItem['risk'];
  initialRiskSource?: RoadmapItem['riskSource']; initialRiskReason?: string;
  initialTier?: Tier;
  branches?: string[]; areas?: string[]; subAreas?: string[]; initialSubArea?: string; mode?: 'add' | 'edit';
}) {
  const [title, setTitle] = useState(initialTitle);
  const [note, setNote] = useState(initialNote);
  const [branch, setBranch] = useState(initialBranch);
  const [area, setArea] = useState(initialArea);
  const [subArea, setSubArea] = useState(initialSubArea);
  const [priority, setPriority] = useState<Priority>(initialPriority);
  const [risk, setRisk] = useState<RoadmapItem['risk']>(initialRisk);
  // #277 — the desire tier, '' = unranked (which sorts last in the run queue).
  const [tier, setTier] = useState<Tier>(initialTier);
  // #298 — "do not override user-selected values". An empty tier says plainly
  // that nobody has ranked it, but RISK has no empty: every item carries
  // 'normal', so the field cannot tell a deliberate Normal from a default one.
  // These flags are what makes the difference legible — once you touch either
  // control, the assist stops filling it, whatever you set it to.
  const [tierTouched, setTierTouched] = useState(false);
  const [riskTouched, setRiskTouched] = useState(false);
  // An S the assist argued for, held as an OFFER rather than applied (S is the
  // owner's own call). Cleared once accepted, dismissed or overtaken by a hand-set tier.
  const [tierOffer, setTierOffer] = useState<Tier>('');
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
  // Branch picker: a dropdown of the branches already in use on this project, with
  // "New branch…" flipping to a free-text input. Starts on the input when the
  // current branch isn't in the list (or there are no branches yet).
  const knownBranches = [...new Set([...branches, ...(initialBranch ? [initialBranch] : [])])].sort();
  const [newBranch, setNewBranch] = useState(knownBranches.length === 0);
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
    ({ title, note, priority, branch: branch.trim(), area: area.trim().toLowerCase(), subArea: subArea.trim().toLowerCase(), plan: fullPlan(),
      risk, tier, riskChanged: risk !== initialRisk });
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
      if (s.branch && !branch.trim()) { setBranch(s.branch); setNewBranch(false); }
      if (s.priority) setPriority(s.priority);
      // #277 — "adjusted by Gemini unless manually set": a tier already chosen
      // (here or on the Tiers view) is left exactly as it is.
      if (s.tier && !tier && !tierTouched) setTier(s.tier);
      // #298 — S is offered, never assigned: it decides what the machine works
      // tonight, and that ranking is the owner's. Only shown while the tier is
      // still unset — an S proposed against a rank you already made is noise.
      setTierOffer(s.tierSuggested === 'S' && !tier && !tierTouched ? 'S' : '');
      // #298 — risk fills only a Normal nobody has touched (see riskTouched).
      if (s.risk && !riskTouched && risk === 'normal') setRisk(s.risk);
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
      <div className="lbl">Branch <span className="optional">optional — who's claiming this</span></div>
      {!newBranch ? (
        <div className="branch-pick" style={{ marginBottom: 8 }}>
          <select className="field-input" value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">No branch — open for anyone</option>
            {knownBranches.map((l) => <option key={l} value={l}>⚑ {l}</option>)}
          </select>
          <button type="button" className="btn-cancel sm" onClick={() => { setBranch(''); setNewBranch(true); }}>
            + New branch
          </button>
        </div>
      ) : (
        <div className="branch-pick" style={{ marginBottom: 8 }}>
          <input className="field-input" value={branch}
            placeholder="e.g. ui/12-dark-mode, autopilot, or a name" onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          {knownBranches.length > 0 && (
            <button type="button" className="btn-cancel sm" onClick={() => { setBranch(''); setNewBranch(false); }}>
              Pick existing
            </button>
          )}
        </div>
      )}
      <div className="field-hint" style={{ marginBottom: 18 }}>
        A branch claims the item for one session or agent — other sessions (and the overnight
        autopilot) see the ⚑ claim and leave it alone. Clear the branch to release it.
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
        Tier <span className="optional">how much you want it NEXT — leads the run queue; unranked goes last</span>
      </div>
      <div className="seg" style={{ marginBottom: tierOffer ? 10 : 26 }} role="tablist" aria-label="Desire tier">
        <button type="button" role="tab" aria-selected={tier === ''}
          className={`opt ${tier === '' ? 'on' : ''}`}
          onClick={() => { setTier(''); setTierTouched(true); setTierOffer(''); }}
          title="Unranked — sorts behind every ranked item, so an unranked board queues exactly as it always did">
          Unranked
        </button>
        {TIERS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tier === t}
            className={`opt tier-${t} ${tier === t ? 'on' : ''}`}
            onClick={() => { setTier(t); setTierTouched(true); setTierOffer(''); }}
            title={`Tier ${t} — the queue works S first, then A, B, C`}>
            {t}
          </button>
        ))}
      </div>
      {/* #298 — the S offer. Everything else the assist reads it just fills;
          S is the one rank that says "work this tonight, before the rest", so
          it arrives as a sentence with a button rather than as a done deal. */}
      {tierOffer === 'S' && (
        <div className="gemini-suggest tier-offer" style={{ marginBottom: 26 }}>
          <span>✧ This reads like <b>S</b> — top of the queue, worked before everything else. S is
            yours to give.</span>
          <span className="tier-offer-acts">
            <button type="button" className="btn-cancel sm"
              onClick={() => { setTier('S'); setTierTouched(true); setTierOffer(''); }}>Make it S</button>
            <button type="button" className="g-dismiss" onClick={() => setTierOffer('')}
              title="Dismiss the suggestion — the tier stays unranked">no</button>
          </span>
        </div>
      )}
      <div className="lbl" style={{ marginBottom: 9 }}>
        Risk <span className="optional">low = a green overnight run merges itself; you still give the verdict</span>
      </div>
      <div style={{ marginBottom: 26 }}>
        <div className="seg" role="tablist" aria-label="Risk">
          {(['low', 'normal', 'high'] as const).map((r) => (
            <button key={r} type="button" role="tab" aria-selected={risk === r}
              className={`opt risk-${r} ${risk === r ? 'on' : ''}`}
              onClick={() => { setRisk(r); setRiskTouched(true); }}>
              {r === 'low' ? 'Low' : r === 'normal' ? 'Normal' : 'High'}
            </button>
          ))}
        </div>
        {initialRiskSource === 'auto' && (
          <div className="risk-prov">
            ✧ Derived at plan time{initialRiskReason ? ` — ${initialRiskReason}` : ''}. Change it and it becomes yours.
          </div>
        )}
        {initialRiskSource === 'human' && (
          <div className="risk-prov">Set by you — the overnight pre-pass will not change it.</div>
        )}
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
