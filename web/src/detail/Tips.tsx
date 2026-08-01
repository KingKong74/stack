import { useEffect, useMemo, useState } from 'react';
import type { Tip, TipStage } from '../types';
import {
  getTips, createTip, patchTip, deleteTip, runTip, type TipInput,
  getTipsRailCollapsed, setTipsRailCollapsed,
} from '../store';
import { go } from '../lib/route';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';

// The recipe library (from the Stack Planning design): prompts that worked,
// kept with the context of WHEN to reach for them. The library is app-wide —
// it is the same list from anywhere — so it opens from the bottom-left dock
// (components/TipsDock) rather than owning a per-project tab. ▶ Run opens a
// terminal session in the project you're on with the prompt handed over via
// the board's one-shot brief mechanism — nothing runs until Enter. With no
// project in view (`slug` undefined) the session opens without a cwd.

const STAGES: { key: TipStage | 'all'; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'diverge', label: 'Diverge' },
  { key: 'converge', label: 'Converge' }, { key: 'judge', label: 'Judge' },
  { key: 'ship', label: 'Ship' },
];

// Render a prompt with its [square-bracket] fill-in slots highlighted.
function PromptText({ prompt }: { prompt: string }) {
  const parts = prompt.split(/(\[[^\]]+\])/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('[') && p.endsWith(']')
          ? <mark className="tip-slot" key={i}>{p.slice(1, -1)}</mark>
          : <span key={i}>{p}</span>)}
    </>
  );
}

export function Tips({ slug, onClose }: { slug?: string; onClose?: () => void }) {
  const [tips, setTips] = useState<Tip[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<TipStage | 'all'>('all');
  const [selId, setSelId] = useState<number | null>(null);
  const [modal, setModal] = useState<{ open: boolean; editing: Tip | null }>({ open: false, editing: null });
  const [confirmDelete, setConfirmDelete] = useState<Tip | null>(null);
  // The rail folds away so the selected recipe gets the full width — a
  // device-local preference, remembered like the theme.
  const [railOpen, setRailOpen] = useState(() => !getTipsRailCollapsed());
  const toggleRail = () => {
    const next = !railOpen;
    setRailOpen(next);
    setTipsRailCollapsed(!next);
  };

  useEffect(() => {
    let alive = true;
    getTips()
      .then((t) => { if (alive) setTips(t); })
      .catch((e) => { if (alive) { setTips([]); setError((e as Error)?.message || 'Could not load the library.'); } });
    return () => { alive = false; };
  }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tips ?? []).filter((t) =>
      (stage === 'all' || t.stage === stage) &&
      (!q || `${t.name} ${t.blurb} ${t.when} ${t.surface}`.toLowerCase().includes(q)));
  }, [tips, query, stage]);

  const sel = list.find((t) => t.id === selId) ?? list[0] ?? null;

  const guard = async (fn: () => Promise<void>) => {
    setError('');
    try { await fn(); } catch (e) { setError((e as Error)?.message || 'That didn’t save.'); }
  };

  const replace = (updated: Tip) =>
    setTips((cur) => (cur ?? []).map((t) => (t.id === updated.id ? updated : t)));

  // ▶ Run: record the run (best-effort — the count is a ledger, not a gate),
  // hand the prompt to the terminal and go. The bracketed paste means the
  // slots get filled in the session before anything is sent.
  const run = (t: Tip) => {
    runTip(t.id).then(replace).catch(() => { /* count is best-effort */ });
    try { sessionStorage.setItem('stack.term.brief', t.prompt); } catch { /* private mode — the handoff just won't appear */ }
    go.terminal(slug);
  };

  const togglePin = (t: Tip) => guard(async () => replace(await patchTip(t.id, { pinned: !t.pinned })));

  const save = (input: TipInput) =>
    guard(async () => {
      if (modal.editing) {
        replace(await patchTip(modal.editing.id, input));
      } else {
        const created = await createTip(input);
        setTips((cur) => [...(cur ?? []), created]);
        setSelId(created.id);
      }
      setModal({ open: false, editing: null });
    });

  const remove = (t: Tip) =>
    guard(async () => {
      await deleteTip(t.id);
      setTips((cur) => (cur ?? []).filter((x) => x.id !== t.id));
      setConfirmDelete(null);
      if (selId === t.id) setSelId(null);
    });

  const total = tips?.length ?? 0;
  const pinnedCount = (tips ?? []).filter((t) => t.pinned).length;

  return (
    <div>
      <div className="section-bar" style={{ marginBottom: 14 }}>
        <div className="titles">
          <div className="h">Recipes</div>
          <div className="subtitle">Claude recipes, runnable in place — the library is shared across every project</div>
        </div>
        <span className="tips-count">{total} recipe{total === 1 ? '' : 's'}{pinnedCount ? ` · ${pinnedCount} pinned` : ''}</span>
        <button className="btn-repo" onClick={() => setModal({ open: true, editing: null })}>+ New recipe</button>
        {onClose && (
          <button className="tips-close" onClick={onClose} title="Close the library" aria-label="Close the library">×</button>
        )}
      </div>

      {error && <div className="action-error">{error}</div>}

      {tips === null ? (
        <div className="tips-loading">Loading the library…</div>
      ) : total === 0 ? (
        <div className="tips-empty">
          Recipes are just prompts you kept. Anything Claude did well — in a session, on the board,
          in Polaris — can be saved here with the context of when to reach for it, and run again
          without rewriting it.
          <button className="btn-repo" onClick={() => setModal({ open: true, editing: null })}>+ Keep the first one</button>
        </div>
      ) : (
        <div className={`tips-layout ${railOpen ? '' : 'rail-closed'}`}>
          {!railOpen && (
            <button className="tips-rail-strip" onClick={toggleRail}
              title="Expand the recipe list" aria-label="Expand the recipe list">
              <span className="glyph">▸</span>
              <span className="vlabel">Recipes · {list.length}</span>
            </button>
          )}
          {railOpen && (
          <div className="tips-rail">
            <div className="tips-search">
              <span className="glyph">⌕</span>
              <input value={query} placeholder="Search recipes…" onChange={(e) => setQuery(e.target.value)} />
              <button className="tips-rail-fold" onClick={toggleRail}
                title="Collapse the recipe list" aria-label="Collapse the recipe list">◂</button>
            </div>
            <div className="tips-cats">
              {STAGES.map((s) => (
                <button key={s.key} className={`tips-cat ${stage === s.key ? 'on' : ''}`} onClick={() => setStage(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="tips-list">
              {list.map((t) => (
                <button key={t.id} className={`tips-row ${sel?.id === t.id ? 'on' : ''}`} onClick={() => setSelId(t.id)}>
                  <span className="top">
                    <span className="name">{t.pinned && <span className="pin" title="Pinned">⚑ </span>}{t.name}</span>
                    <span className="uses">{t.uses} run{t.uses === 1 ? '' : 's'}</span>
                  </span>
                  <span className="sub">
                    {t.surface && <span className="tag">{t.surface}</span>}
                    <span className="blurb">{t.blurb}</span>
                  </span>
                </button>
              ))}
              {list.length === 0 && (
                <div className="tips-none">
                  Nothing matches. Describe what you want and keep it as a new recipe — the next run is one click.
                </div>
              )}
            </div>
          </div>
          )}

          {sel && (
            <div className="tips-detail">
              <div className="tips-head">
                <div className="meta">
                  <span className="stage">{sel.stage.toUpperCase()}</span>
                  <span className="quiet">
                    {sel.surface ? `· runs in ${sel.surface} ` : ''}· {sel.uses} run{sel.uses === 1 ? '' : 's'}
                    {sel.lastRun ? ` · last ${sel.lastRun}` : ''}
                  </span>
                </div>
                <div className="tips-head-row">
                  <div className="grow">
                    <div className="name">{sel.name}</div>
                    {sel.when && <div className="when">{sel.when}</div>}
                  </div>
                  <div className="acts">
                    <button className="tips-run" onClick={() => run(sel)}>▶ Run in a session</button>
                    <button className="tips-pin" onClick={() => togglePin(sel)}>
                      {sel.pinned ? '✓ pinned' : 'pin to the top'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="tips-body">
                <div className="tips-block">
                  <div className="tips-cap">THE PROMPT</div>
                  <div className="tips-prompt"><PromptText prompt={sel.prompt} /></div>
                  <div className="tips-slot-hint">
                    <mark className="tip-slot">highlighted slots</mark> are fill-ins — the prompt lands in the
                    session as a paste, so you complete them before pressing Enter
                  </div>
                </div>

                <div className="tips-cols">
                  {sel.best.length > 0 && (
                    <div className="tips-block grow">
                      <div className="tips-cap">WORKS BEST WHEN</div>
                      {sel.best.map((b, i) => (
                        <div className="tips-best" key={i}><span className="arrow">→</span><span>{b}</span></div>
                      ))}
                    </div>
                  )}
                  {sel.who && (
                    <div className="tips-who">
                      <div className="tips-cap">PROVENANCE</div>
                      <div className="txt">{sel.who}</div>
                    </div>
                  )}
                </div>

                <div className="tips-idle">
                  Recipes are just prompts you kept. ▶ Run opens a Claude session in this project with the
                  prompt typed in — grounded by the session-start context, nothing sent until you press Enter.
                </div>

                <div className="tips-manage">
                  <button className="tips-edit" onClick={() => setModal({ open: true, editing: sel })}>✎ Edit</button>
                  <button className="tips-delete" onClick={() => setConfirmDelete(sel)}>× Delete</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {modal.open && (
        <TipModal editing={modal.editing} onClose={() => setModal({ open: false, editing: null })} onSubmit={save} />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Delete this recipe?"
          body={<>“{confirmDelete.name}” leaves the library for every project. There’s no undo.</>}
          confirmLabel="Delete recipe" danger
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)} />
      )}
    </div>
  );
}

// Add / edit a recipe. The prompt is the recipe; everything else is the
// context that makes it findable — stage, surface, when to reach for it.
function TipModal({ editing, onClose, onSubmit }: {
  editing: Tip | null;
  onClose: () => void;
  onSubmit: (input: TipInput) => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [stage, setStage] = useState<TipStage>(editing?.stage ?? 'ship');
  const [surface, setSurface] = useState(editing?.surface ?? '');
  const [blurb, setBlurb] = useState(editing?.blurb ?? '');
  const [when, setWhen] = useState(editing?.when ?? '');
  const [prompt, setPrompt] = useState(editing?.prompt ?? '');
  const [best, setBest] = useState((editing?.best ?? []).join('\n'));
  const [who, setWho] = useState(editing?.who ?? '');

  const submit = () => {
    if (!name.trim() || !prompt.trim()) return;
    onSubmit({
      name: name.trim(), stage, surface: surface.trim(), blurb: blurb.trim(),
      when: when.trim(), prompt: prompt.trim(),
      best: best.split('\n').map((l) => l.trim()).filter(Boolean),
      who: who.trim(),
    });
  };

  return (
    <Modal onClose={onClose} wide closeOnOverlay={false}>
      <h3>{editing ? 'Edit recipe' : 'Keep a recipe'}</h3>
      <div className="lbl">Name</div>
      <input className="field-input" style={{ marginBottom: 14 }} value={name} autoFocus
        placeholder="Stress-test this plan" onChange={(e) => setName(e.target.value)} />
      <div className="lbl" style={{ marginBottom: 9 }}>Stage</div>
      <div className="seg" style={{ marginBottom: 14 }}>
        {(['diverge', 'converge', 'judge', 'ship'] as TipStage[]).map((s) => (
          <button key={s} className={`opt ${stage === s ? 'on' : ''}`} onClick={() => setStage(s)}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div className="lbl">Runs best in <span className="lbl-opt">— optional</span></div>
      <input className="field-input" style={{ marginBottom: 14 }} value={surface}
        placeholder="Polaris / Roadmap / anywhere" onChange={(e) => setSurface(e.target.value)} />
      <div className="lbl">One-line pitch <span className="lbl-opt">— shows in the list</span></div>
      <input className="field-input" style={{ marginBottom: 14 }} value={blurb}
        placeholder="Find where the plan breaks before the plan breaks" onChange={(e) => setBlurb(e.target.value)} />
      <div className="lbl">When to reach for it</div>
      <textarea className="field-area" style={{ marginBottom: 14, minHeight: 48 }} value={when}
        placeholder="Before a plan leaves the room…" onChange={(e) => setWhen(e.target.value)} />
      <div className="lbl">The prompt <span className="lbl-opt">— [square brackets] mark fill-in slots</span></div>
      <textarea className="field-area" style={{ marginBottom: 14, minHeight: 110 }} value={prompt}
        placeholder="Read [the current plan] and…" onChange={(e) => setPrompt(e.target.value)} />
      <div className="lbl">Works best when <span className="lbl-opt">— one line each</span></div>
      <textarea className="field-area" style={{ marginBottom: 14, minHeight: 64 }} value={best}
        placeholder={'The plan is written down.\nYou name the horizon.'} onChange={(e) => setBest(e.target.value)} />
      <div className="lbl">Provenance <span className="lbl-opt">— who kept it, where the output lands</span></div>
      <input className="field-input" style={{ marginBottom: 20 }} value={who}
        placeholder="Kept after the Q2 replan — run it before tickets harden" onChange={(e) => setWho(e.target.value)} />
      <div className="modal-actions">
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
        <button className="btn-submit" disabled={!name.trim() || !prompt.trim()} onClick={submit}>
          {editing ? 'Save changes' : 'Keep recipe'}
        </button>
      </div>
    </Modal>
  );
}
