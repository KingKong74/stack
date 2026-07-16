import { useEffect, useState } from 'react';
import {
  getControl, patchProject, patchSettings, AuthError,
  type ControlData, type ControlProject,
} from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME } from '../lib/ui';
import type { ProjectStatus } from '../types';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived',
};
const CAPS = [
  { minutes: 60, label: '1h' }, { minutes: 120, label: '2h' }, { minutes: 180, label: '3h' },
];

// Mission Control — every project's automation state on one screen: the
// autopilot's arm switch + cap, per-project automode toggles, who's live now,
// what's lane-claimed, what needs review, and what tonight's run would pick.
export function Control() {
  const [data, setData] = useState<ControlData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getControl()
      .then(setData)
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Failed to load mission control.'); });
  }, []);

  // Optimistic with rollback — same contract as Settings.
  const setAutopilot = async (patch: { autopilotEnabled?: boolean; autopilotMinutes?: number }) => {
    if (!data) return;
    const prev = data.autopilot;
    setData({
      ...data,
      autopilot: {
        enabled: patch.autopilotEnabled ?? prev.enabled,
        minutes: patch.autopilotMinutes ?? prev.minutes,
      },
    });
    try {
      const s = await patchSettings(patch);
      setData((cur) => cur && { ...cur, autopilot: { enabled: s.autopilotEnabled, minutes: s.autopilotMinutes } });
    } catch (e) {
      setData((cur) => cur && { ...cur, autopilot: prev });
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not update the autopilot.');
    }
  };

  const toggleAutomode = async (p: ControlProject) => {
    if (!data) return;
    const flip = (v: boolean) => (cur: ControlData | null) => cur && {
      ...cur,
      projects: cur.projects.map((x) => (x.slug === p.slug ? { ...x, automode: v } : x)),
      totals: { ...cur.totals, automode: cur.totals.automode + (v ? 1 : -1) },
    };
    setData(flip(!p.automode));
    try {
      await patchProject(p.slug, { automode: !p.automode });
    } catch (e) {
      setData(flip(p.automode));
      if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Could not update the project.');
    }
  };

  return (
    <div>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">Mission Control</span>
        </div>
        <div className="right">
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
          <button className="avatar sm" onClick={go.settings} aria-label="Settings" />
        </div>
      </div>

      <div className="page detail" style={{ maxWidth: 1080 }}>
        <div className="dash-head" style={{ marginBottom: 20 }}>
          <div>
            <div className="dash-title">Mission Control</div>
            <div className="dash-count">Every project and its automation, from one point.</div>
          </div>
        </div>

        {error && <div className="action-error">{error}</div>}

        {!data ? (
          !error && <div className="empty-state"><div className="big">Loading…</div></div>
        ) : (
          <>
            {/* the autopilot strip — the global arm switch + cap, and the day's numbers */}
            <div className="mc-strip">
              <div className="mc-arm">
                <button role="switch" aria-checked={data.autopilot.enabled} aria-label="Autopilot armed"
                  className={`switch ${data.autopilot.enabled ? 'on' : ''}`}
                  onClick={() => setAutopilot({ autopilotEnabled: !data.autopilot.enabled })}>
                  <span className="switch-knob" />
                </button>
                <div className="mc-arm-text">
                  <div className="mc-arm-label">Autopilot {data.autopilot.enabled ? 'armed' : 'off'}</div>
                  <div className="mc-arm-hint">
                    {data.autopilot.enabled
                      ? 'The nightly run will work one item on each automode project.'
                      : 'The nightly schedule exits without doing anything.'}
                  </div>
                </div>
                <div className="seg-control sm" role="tablist" aria-label="Session cap">
                  {CAPS.map((c) => (
                    <button key={c.minutes} role="tab" aria-selected={data.autopilot.minutes === c.minutes}
                      className={`seg-opt ${data.autopilot.minutes === c.minutes ? 'on' : ''}`}
                      onClick={() => setAutopilot({ autopilotMinutes: c.minutes })}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mc-totals">
                <button className="btn-repo sm" onClick={() => go.terminal()}
                  title="A real shell (or Claude) on the host, from any device">⌨ Terminal</button>
                <span className={`mc-daemon ${data.terminal?.connected ? 'on' : ''}`}
                  title={data.terminal?.connected
                    ? 'stack-term is connected — terminal sessions available'
                    : 'The host daemon is offline — start stack-term on the host'}>
                  {data.terminal?.connected ? '● daemon online' : '○ daemon offline'}
                </span>
                <span><b>{data.totals.automode}</b> on automode</span>
                <span><b>{data.totals.liveSessions}</b> live session{data.totals.liveSessions === 1 ? '' : 's'}</span>
                <span><b>{data.totals.claims}</b> claimed lane{data.totals.claims === 1 ? '' : 's'}</span>
                <span><b>{data.totals.review}</b> awaiting review</span>
              </div>
            </div>

            {/* one row per project — automode first */}
            <div className="mc-list">
              {data.projects.map((p) => (
                <div className={`mc-row ${p.automode ? 'auto' : ''}`} key={p.slug}>
                  <div className="mc-main">
                    <button className="mc-name" onClick={() => go.detail(p.slug)}>
                      <span className="tintdot" style={{ background: p.tint || 'var(--sand)' }} />
                      {p.name}
                    </button>
                    <span className={`statusbadge ${p.status}`}><span className="dot" />{STATUS_LABEL[p.status]}</span>
                    {p.live && (
                      <span className="mc-live" title={`${p.live.count} live session${p.live.count === 1 ? '' : 's'}`}>
                        ● {p.live.branches.join(' · ')}
                      </span>
                    )}
                    <button className="mc-term" onClick={() => go.terminal(p.slug)}
                      title={`Open a terminal in ~/${p.slug}`}>⌨</button>
                    <span className="mc-push">{p.lastPush ? `pushed ${p.lastPush}` : 'no pushes yet'}</span>
                    <button role="switch" aria-checked={p.automode} aria-label={`Automode for ${p.name}`}
                      className={`switch sm ${p.automode ? 'on' : ''}`} onClick={() => toggleAutomode(p)}
                      title={p.automode ? 'Automode on — the autopilot may work this project' : 'Automode off — hands off'}>
                      <span className="switch-knob" />
                    </button>
                  </div>
                  <div className="mc-facts">
                    <span className="mc-fact">
                      {p.automode ? (
                        p.nextPick
                          ? <>tonight: <button className="mc-pick" onClick={() => go.detail(p.slug, 'roadmap', p.nextPick!.id)}>#{p.nextPick.id} {p.nextPick.title}</button></>
                          : <span className="quiet">tonight: nothing eligible</span>
                      ) : (
                        <span className="quiet">manual only</span>
                      )}
                    </span>
                    {p.lastAuto && (
                      <span className="mc-fact" title={p.lastAuto.summary}>
                        last run: <button className="mc-pick" onClick={() => go.detail(p.slug, 'activity')}>{p.lastAuto.branch}</button> {p.lastAuto.when}
                      </span>
                    )}
                    {p.claims.map((c) => (
                      <button key={c.id} className="mc-claim" title={c.title}
                        onClick={() => go.detail(p.slug, 'roadmap', c.id)}>⚑ {c.lane}</button>
                    ))}
                    {p.reviewCount > 0 && (
                      <button className="mc-review" onClick={() => go.detail(p.slug)}>
                        {p.reviewCount} to review
                      </button>
                    )}
                    {p.bugs.serious > 0 && (
                      <button className="mc-bugs" onClick={() => go.detail(p.slug, 'bugs')}>
                        {p.bugs.serious} serious bug{p.bugs.serious === 1 ? '' : 's'}
                      </button>
                    )}
                    {p.blockers.length > 0 && (
                      <span className="mc-fact mc-blocked" title={p.blockers.join('\n')}>
                        ⛔ {p.blockers.length} blocker{p.blockers.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {data.projects.length === 0 && (
                <div className="empty-state">
                  <div className="big">No projects yet</div>
                  <div>Connect a repo from the dashboard and it'll appear here.</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
