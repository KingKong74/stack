import type { AgentProfilesRoom } from '../types';

export function AgentUtilisation({ room, onRefresh }: { room: AgentProfilesRoom; onRefresh: () => void }) {
  const usage = room.utilisation?.profiles;
  const rows = room.profiles.map(profile => ({ profile, usage: usage?.[profile.key] }))
    .sort((a, b) => ((b.usage?.calls ?? 0) + (b.usage?.diagnostics ?? 0)) - ((a.usage?.calls ?? 0) + (a.usage?.diagnostics ?? 0)));
  const observed = rows.flatMap(r => r.usage ? [r.usage] : []);
  const calls = observed.reduce((n, u) => n + u.calls, 0);
  const diagnostics = observed.reduce((n, u) => n + u.diagnostics, 0);
  const completed = observed.reduce((n, u) => n + u.completed, 0);
  const failed = observed.reduce((n, u) => n + u.failed, 0);
  const projects = new Set(observed.flatMap(u => u.projects)).size;
  const max = Math.max(1, ...observed.map(u => u.calls + u.diagnostics));
  const metrics = [
    ['Delegations', calls, 'Recorded Claude agent calls'],
    ['Diagnostics', diagnostics, 'Specialist attempts started'],
    ['Profiles used', observed.length, `of ${room.profiles.length} current profiles`],
    ['Projects reached', projects, 'With recorded agent activity'],
  ] as const;

  return <section className="au-dashboard" aria-label="Agent utilisation dashboard">
    <div className="mc-sechead">
      <div><h2>Agent activity</h2><p>How your agents are being used across projects.</p></div>
      <div className="au-toolbar"><span className="au-window">Last {room.utilisation?.windowDays ?? 30} days</span>
        <button className="k-btn secondary" onClick={onRefresh}>Refresh usage</button></div>
    </div>
    <div className="au-metrics">
      {metrics.map(([label, value, note]) => <div className="au-metric" key={label}>
        <span className="au-label">{label}</span><strong>{usage ? value.toLocaleString('en-AU') : '—'}</strong><span>{note}</span>
      </div>)}
    </div>
    {!usage ? <p role="status">Utilisation data unavailable. Refresh to try again.</p> : <div className="au-panels">
      <section className="mc-card">
        <header className="mc-cardhead"><span className="t">Usage by agent</span><span className="note">Current profiles · most used first</span></header>
        <div className="au-legend"><span><i className="au-delegations" />Delegations</span><span><i className="au-diagnostics" />Diagnostics</span></div>
        <div className="au-ranking">
          {rows.map(({ profile, usage: u }) => <article className="au-agent" key={profile.key}>
            <div className="au-agenthead"><div><strong>{profile.name}</strong><span>{profile.key}</span></div>
              <strong className="au-count">{u ? (u.calls + u.diagnostics).toLocaleString('en-AU') : '—'}</strong></div>
            <div className="au-track" role="img" aria-label={`${profile.name}: ${u?.calls ?? 0} recorded delegations, ${u?.diagnostics ?? 0} diagnostic attempts`}>
              <span className="au-delegations" style={{ width: `${(u?.calls ?? 0) / max * 100}%` }} />
              <span className="au-diagnostics" style={{ width: `${(u?.diagnostics ?? 0) / max * 100}%` }} />
            </div>
            {u ? <><div className="au-agentmeta"><span>{u.calls} delegations · {u.diagnostics} diagnostics</span>
              <time dateTime={u.lastAt}>Last recorded {new Date(u.lastAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</time></div>
              <p className="au-projects">{u.projects.join(' · ')}</p></> : <p className="au-projects">No use recorded in this window</p>}
          </article>)}
        </div>
      </section>
      <section className="mc-card au-outcomes">
        <header className="mc-cardhead"><span className="t">Diagnostic outcomes</span><span className="note">Started attempts only</span></header>
        <div className="au-outcome-total"><strong>{diagnostics}</strong><span>diagnostic attempts</span></div>
        <div className="au-outcome-list">
          {[[completed, 'Completed'], [failed, 'Failed'], [diagnostics - completed - failed, 'Other / in progress']].map(([n, label]) =>
            <div key={label}><span>{label}</span><strong>{n}</strong></div>)}
        </div>
        <p className="au-outcome-note">Completion records a finished diagnostic, not an approval of the work.</p>
      </section>
    </div>}
    <p className="au-coverage">Recorded activity only. No record does not prove an agent was unused. Codex activity and per-profile tokens or cost are unknown. Delegations use the session’s recording date; configured profiles and assignments are excluded.</p>
  </section>;
}
