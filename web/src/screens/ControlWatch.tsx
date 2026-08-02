import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import {
  AuthError, getAutoSession, viewAutoPane,
  type FleetSlot, type AutoSessionDetail, type AutoPaneView,
} from '../store';
import { useAutoRefresh } from '../lib/autoRefresh';

// ---------------------------------------------------------------------------
// #366 — the WATCH panel: what a running autopilot session is doing, and a
// read-only window onto its pane.
//
// Two independent reads sit behind it, and they stay independent on purpose:
// `getAutoSession` is the session's own RECORD — what it's on, its plan, what
// it has already banked tonight — cheap and database-backed. `viewAutoPane`
// is an on-demand FRESH read of the tmux pane, taken host-side at the moment
// it is asked for; it is the only thing here that can be stale by more than a
// refresh tick, so it carries its own "read at" stamp.
//
// Neither one, nor anything in this panel, can type into the session: the
// fleet runs unattended by design (--dangerously-skip-permissions), and a
// watch panel does not change that. No mutation handler is wired here — no
// kill, no answer, no keystrokes.
// ---------------------------------------------------------------------------

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
const fmtUsd = (n: number) => (n >= 0.005 ? `$${n.toFixed(2)}` : n > 0 ? '<$0.01' : '$0.00');

const ago = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
};

const since = (iso: string | null) => {
  if (!iso) return '';
  return ago(Math.max(0, Date.now() - new Date(iso).getTime()));
};

export function WatchPanel({ slot, onClose }: { slot: FleetSlot; onClose: () => void }) {
  const [detail, setDetail] = useState<AutoSessionDetail | null>(null);
  const [detailErr, setDetailErr] = useState('');
  const [pane, setPane] = useState<AutoPaneView | null>(null);
  const [paneErr, setPaneErr] = useState('');
  const [paneAt, setPaneAt] = useState(0);
  const [paneBusy, setPaneBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const paneRef = useRef<HTMLPreElement>(null);

  const loadDetail = () => {
    getAutoSession(slot.jobId)
      .then((d) => { setDetail(d); setDetailErr(''); })
      .catch((e) => { if (!(e instanceof AuthError)) setDetailErr((e as Error)?.message || 'Could not read this session.'); });
  };

  const loadPane = () => {
    setPaneBusy(true);
    viewAutoPane(slot.tmux)
      .then((v) => {
        setPane(v);
        setPaneErr('');
        setPaneAt(Date.now());
        // Keep the newest lines visible on a fresh read.
        requestAnimationFrame(() => {
          const el = paneRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      })
      .catch((e) => { if (!(e instanceof AuthError)) setPaneErr((e as Error)?.message || 'The host could not read that pane.'); })
      .finally(() => setPaneBusy(false));
  };

  useEffect(() => {
    loadDetail();
    loadPane();
    // Re-fires only if a different session is opened into the same panel
    // instance — the common case is a fresh mount per Watch press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.jobId, slot.tmux]);

  // Gated on the panel being open: this component only exists while it is, so
  // the hook is armed for its whole lifetime and torn down on unmount. One
  // device-local Auto refresh setting governs every host-watching screen
  // (#312) — no bare setInterval beside it.
  useAutoRefresh(() => { loadDetail(); loadPane(); }, true);

  const copyAttach = async () => {
    try {
      await navigator.clipboard.writeText(`tmux attach -t ${slot.tmux}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the field is selectable */ }
  };

  // The freshest read wins: a landed pane read beats the session's own
  // activity record, which beats the fleet strip's snapshot from when the
  // panel opened. All three are the SAME shape (#366), read off the same host
  // report at different moments.
  const liveActivity = detail?.activity ?? slot.activity ?? null;
  const doing = pane?.doing || liveActivity?.doing || '';
  const idleMs = pane ? pane.idleMs : liveActivity?.idleMs;
  const canSeePane = !!pane || !!liveActivity;

  const runs = detail?.runs ?? [];

  return (
    <Modal onClose={onClose} wide>
      <div className="mc-watch">
        <div className="mc-watch-head">
          <span className="tintdot" style={slot.tint ? { background: slot.tint } : undefined} />
          <div className="who">
            <b>{slot.name}</b>
            <i>
              {slot.itemId
                ? `#${slot.itemId} ${slot.itemTitle || 'item'}`
                : slot.kind === 'nightly' ? 'general night — picks as it goes' : `${slot.kind} job`}
            </i>
          </div>
          <span className={`state ${slot.status === 'claimed' ? 'quiet' : 'live'}`}>
            {slot.status === 'claimed' ? 'STARTING' : 'RUNNING'}
          </span>
          <span className="age">{slot.startedAt ? `running ${since(slot.startedAt)}` : slot.since}</span>
          <button className="mc-watch-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        {detailErr && <div className="action-error">{detailErr}</div>}

        <div className="mc-watch-sec">
          <span className="cap">WHAT IT'S DOING</span>
          {canSeePane ? (
            <div className="mc-watch-doing">
              <p>{doing || 'The host has reported this session, but has not read a summary line from its pane yet.'}</p>
              {typeof idleMs === 'number' && <span className="idle">last moved {ago(idleMs)}</span>}
            </div>
          ) : (
            <div className="mc-watch-doing empty">
              Stack cannot see this session's pane — the host daemon has not reported it. That is not
              the same as the session being idle or calm; it means nothing has looked.
            </div>
          )}
        </div>

        <div className="mc-watch-sec">
          <span className="cap">PROGRESS</span>
          {!detail ? (
            <p className="mc-watch-empty">Loading…</p>
          ) : detail.planTotal === 0 ? (
            <p className="mc-watch-empty">This item has no plan.</p>
          ) : (
            <div className="mc-watch-plan">
              <span className="n">{detail.planDone}/{detail.planTotal} done</span>
              <ul>
                {detail.plan.map((s, i) => (
                  <li key={i} className={s.done ? 'done' : ''}>
                    <span className="tick" aria-hidden>{s.done ? '✓' : '○'}</span>{s.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mc-watch-sec">
          <span className="cap">BANKED TONIGHT</span>
          {runs.length === 0 ? (
            <p className="mc-watch-empty">
              This session has not finished a unit yet — banked spend lands per finished item, so
              zero here is normal and is not a stall.
            </p>
          ) : (
            <div className="mc-watch-runs">
              {runs.map((r) => (
                <div key={r.id} className="row">
                  <span className="t">{r.itemId ? `#${r.itemId} ${r.itemTitle || 'item'}` : (r.itemTitle || 'item')}</span>
                  <span className="o">{r.outcome}</span>
                  <span className="c">{r.commits} commit{r.commits === 1 ? '' : 's'}</span>
                  <span className="s">{fmtTok(r.tokens)} · {fmtUsd(r.costUsd)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mc-watch-sec">
          <div className="mc-watch-panehead">
            <span className="cap">THE LIVE PANE</span>
            <span className="when">{paneAt ? `read ${ago(Date.now() - paneAt)}` : ''}</span>
            <button className="btn-repo sm" disabled={paneBusy} onClick={loadPane}>
              {paneBusy ? '◴ reading…' : '↻ refresh'}
            </button>
          </div>
          {paneErr && <div className="mc-watch-paneerr">{paneErr}</div>}
          <pre className="mc-watch-pane" ref={paneRef}>
            {pane?.tail || (paneBusy ? 'Reading…' : paneErr ? '' : 'No read yet.')}
          </pre>
        </div>

        <div className="mc-watch-sec">
          <span className="cap">ACCESS</span>
          <p className="mc-watch-note">
            Read-only: this view can watch the session but cannot type into it — the autopilot runs
            with permissions pre-granted. The only way IN is over ssh, on the host:
          </p>
          <div className="mc-watch-attach">
            <input className="field-input mono" readOnly value={`tmux attach -t ${slot.tmux}`}
              onFocus={(e) => e.currentTarget.select()} />
            <button className="btn-repo sm" onClick={() => void copyAttach()}>{copied ? '✓ Copied' : 'Copy'}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
