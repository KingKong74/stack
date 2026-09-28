// PLANS → SESSION PLANS — the plan-mode plans a human approved, as captured by
// hook/stack-plan.mjs. A list on the left, the chosen plan read on the right.
//
// IT READS AND DISCARDS, AND THAT IS ALL. Turning a plan into roadmap items is
// the next piece and it is a human's action; nothing here writes the board, so
// a plan the fleet could build from without anyone looking cannot come from
// this screen.
//
// AN EMPTY LIST IS NOT "NO PLANS". The capture is a hook on each machine that
// runs Claude Code, and a machine without it posts nothing, so the empty state
// says how a plan gets here rather than implying none were made.
//
// Fetched when the sub-tab opens and on ↻, never polled: a plan lands when a
// human approves one, which is not something to watch for.

import { useEffect, useState } from 'react';
import { KitIcon } from './kit/KitIcon';
import { Markdown } from '../components/Markdown';
import { ConfirmModal } from '../components/ConfirmModal';
import { deleteSessionPlan, getSessionPlan, getSessionPlans } from '../store';
import type { SessionPlan } from '../types';

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

export function SessionPlansView({ slug }: { slug: string }) {
  const [list, setList] = useState<SessionPlan[] | null>(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<number | null>(null);
  const [open, setOpen] = useState<SessionPlan | null>(null);
  const [readErr, setReadErr] = useState('');
  const [discard, setDiscard] = useState<SessionPlan | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setErr('');
    getSessionPlans(slug)
      .then((rows) => {
        if (!live) return;
        setList(rows);
        setPicked((cur) => (cur !== null && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null));
      })
      .catch((e: Error) => { if (live) setErr(e.message || 'Could not load plans.'); });
    return () => { live = false; };
  }, [slug, tick]);

  useEffect(() => {
    if (picked === null) { setOpen(null); return; }
    let live = true;
    setReadErr('');
    getSessionPlan(slug, picked)
      .then((p) => { if (live) setOpen(p); })
      .catch((e: Error) => { if (live) { setOpen(null); setReadErr(e.message || 'Could not load this plan.'); } });
    return () => { live = false; };
  }, [slug, picked]);

  const confirmDiscard = async () => {
    const p = discard;
    setDiscard(null);
    if (!p) return;
    try {
      await deleteSessionPlan(slug, p.id);
      if (picked === p.id) setPicked(null);
      setTick((t) => t + 1);
    } catch (e) {
      setErr((e as Error).message || 'Could not discard that plan.');
    }
  };

  const head = (
    <div className="pl-toolbar">
      <span className="pl-saved">
        Plans you approved in Claude Code’s plan mode, newest first. Reading only: nothing here changes the board.
      </span>
      <div className="right">
        <button className="k-btn sm secondary" onClick={() => setTick((t) => t + 1)}>↻ Refresh</button>
      </div>
    </div>
  );

  if (err) {
    return <div className="pl-view">{head}<div className="sp-empty"><b>Couldn’t load plans.</b> {err}</div></div>;
  }
  if (!list) return <div className="pl-view">{head}<div className="sp-empty">Loading plans…</div></div>;
  if (!list.length) {
    return (
      <div className="pl-view">
        {head}
        <div className="sp-empty">
          <b>No plans recorded for this project.</b> A plan lands here when you approve one in plan
          mode (Shift+Tab in Claude Code) inside this repo. That needs the <code>stack-plan</code> hook
          on the machine running Claude, so an empty list can also mean the hook isn’t installed
          there: see <code>hook/settings.snippet.json</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="pl-view">
      {head}
      <div className="sp">
        <div className="sp-list" role="listbox" aria-label="Session plans">
          {list.map((p) => (
            <button key={p.id} role="option" aria-selected={p.id === picked}
              className={`sp-item${p.id === picked ? ' on' : ''}`} onClick={() => setPicked(p.id)}>
              <span className="t">{p.title || 'Untitled plan'}</span>
              <span className="m">{p.when} · {kb(p.size)}</span>
            </button>
          ))}
        </div>

        <div className="sp-read">
          {readErr && <div className="sp-empty"><b>Couldn’t load this plan.</b> {readErr}</div>}
          {!readErr && !open && <div className="sp-empty">Loading…</div>}
          {!readErr && open && (
            <>
              <div className="sp-readhead">
                <div className="sp-meta">
                  <KitIcon name="file-text" size={14} />
                  <span>Approved {open.when}</span>
                  {open.planFile && <span className="mono" title="Under ~/.claude/plans">{open.planFile}</span>}
                  {(open.branch || open.commit) && (
                    <span className="mono" title="Where the checkout was when the plan was approved, not what built it">
                      {[open.branch, open.commit].filter(Boolean).join(' @ ')}
                    </span>
                  )}
                  {open.sessionId && <span className="mono" title={`Session ${open.sessionId}`}>session {open.sessionId.slice(0, 8)}</span>}
                </div>
                <button className="k-btn sm ghost" onClick={() => setDiscard(open)}>
                  <KitIcon name="trash-2" size={13} />Discard
                </button>
              </div>
              <Markdown text={open.body ?? ''} />
            </>
          )}
        </div>
      </div>

      {discard && (
        <ConfirmModal title="Discard this plan?"
          body={<>“{discard.title || 'Untitled plan'}” comes off this list. The file in <code>~/.claude/plans</code> is
            not touched, and nothing on the board changes.</>}
          confirmLabel="Discard" danger
          onConfirm={confirmDiscard} onCancel={() => setDiscard(null)} />
      )}
    </div>
  );
}
