// Mission Control — the NOW room (design 2a, "work on the left, meters on the
// right"). Lifted out of Control.tsx, which was the last room still inline
// while the other five had their own files.
//
// The room is ordered by what a stalled fleet costs, and that ordering is the
// whole design:
//
//   1. the arm switch      is anything allowed to run at all
//   2. Needs you           what has STOPPED and is waiting on a human
//   3. collisions          two live sessions writing one file
//   4. Sessions            what is running, grouped by project
//   5. Mirror sites        what is up on a public URL
//   6. Up next             what runs when a slot frees
//   7. Active projects     the board, and each project's branches
//
// The change from the room this replaces is the second and third entries.
// "What is running" was answerable before; "what has stopped and wants me" was
// not, and it is the more expensive question — a session blocked on a
// permission prompt reads, from every other signal, exactly like one thinking
// hard. Both now arrive on the payload (attention[] / conflicts[]) from the
// host's own pane scan and transcript tail.
import { useState } from 'react';
import {
  answerPrompt, AuthError,
  type ControlData, type ControlProject, type AutopilotJob, type AttentionRow,
  type Preview,
} from '../store';
import { SessionLanes } from './ControlLanes';
import { go, hrefTo } from '../lib/route';
import type { ProjectStatus } from '../types';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived',
};
const JOB_LABEL: Record<AutopilotJob['status'], string> = {
  queued: 'queued', claimed: 'starting', running: 'running', done: 'done', failed: 'failed',
  paused: 'hung up',
};
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const OPEN_JOB = new Set(['queued', 'claimed', 'running']);

// #142 — a paused session: a resume job holding for the limit reset
// (queued + notBefore) or hung up by hand (status 'paused').
export const isPausedSession = (j: AutopilotJob) =>
  j.kind === 'resume' && (j.status === 'paused' || j.status === 'queued');
const resumeWhen = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${DAY_LABELS[d.getDay()]} ${t}`;
};

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;

export interface NowRoomProps {
  data: ControlData;
  // the arm switch and its folded-open config, owned by the shell so the Roles
  // room's "edit the policy" can still open it from another room
  cfgOpen: boolean;
  onToggleCfg: () => void;
  onSetArmed: (on: boolean) => void;
  configPanel: React.ReactNode;
  // rooms
  onGoRoom: (room: 'nights' | 'plan' | 'review') => void;
  // jobs
  onResumeJob: (j: AutopilotJob) => void;
  onHangupJob: (j: AutopilotJob) => void;
  onDismissJob: (j: AutopilotJob) => void;
  // projects
  onRunNow: (p: ControlProject) => void;
  onToggleAutomode: (p: ControlProject) => void;
  onSetTargetArea: (p: ControlProject, area: string) => void;
  // branches
  onMerge: (p: ControlProject, b: ControlProject['branches'][number]) => void;
  onMergeTrain: (p: ControlProject) => void;
  // previews
  previews: Preview[];
  previewBusy: string | null;
  mirrorBusy: string;
  onStartPreview: (slug: string, branch: string, itemId: string | null) => void;
  onStopPreview: (pv: Preview) => void;
  onExtendPreview: (pv: Preview) => void;
  // lanes
  labelBusy: boolean;
  onLabel: () => void;
  onReload: () => void;
}

export function NowRoom(p: NowRoomProps) {
  const { data } = p;
  const [answering, setAnswering] = useState('');
  // The host's refusal, kept beside the row it refused. It is the interesting
  // half of this feature: "already answered at the keyboard" and "the session
  // moved on" are the normal outcomes of a twenty-second-old row, and swallowing
  // them would leave the human pressing a button that silently does nothing.
  const [answerNote, setAnswerNote] = useState<Record<string, string>>({});
  const [showIdle, setShowIdle] = useState(false);
  const [openProject, setOpenProject] = useState('');

  const attention = data.attention ?? [];
  const conflicts = data.conflicts ?? [];
  const hostSeen = data.terminal?.connected === true;

  const answer = async (row: AttentionRow, choice: 'approve' | 'deny') => {
    if (!row.tmux || !row.fingerprint || answering) return;
    setAnswering(row.key);
    setAnswerNote((n) => ({ ...n, [row.key]: '' }));
    try {
      const r = await answerPrompt(row.tmux, row.fingerprint, choice);
      setAnswerNote((n) => ({
        ...n,
        [row.key]: r.state === 'still-up'
          ? 'Sent, but the prompt is still up — jump in and answer it at the keyboard.'
          : r.state === 'next-prompt'
            ? 'Answered — the session is already asking something else.'
            : `${choice === 'approve' ? 'Approved' : 'Denied'} — the session is moving again.`,
      }));
      p.onReload();
    } catch (e) {
      if (e instanceof AuthError) return;
      // The host's own sentence, verbatim. It is more useful than anything
      // this side could compose: only the host knows what the pane says now.
      setAnswerNote((n) => ({ ...n, [row.key]: (e as Error)?.message || 'The host would not answer that prompt.' }));
    } finally {
      setAnswering('');
    }
  };

  // ---- 1. the arm switch ---------------------------------------------------
  // #270's loud-idle line and the old settle bar were two rows saying one
  // thing. 2a folds them together: the switch, the honest reason, and the
  // one-click fix, in the tone the reason deserves.
  const fleetStatus = data.fleet?.status;
  const armed = data.autopilot.enabled;
  const tone = fleetStatus?.tone ?? (armed ? 'good' : 'bad');
  const summary = armed
    ? `nightly ${data.autopilot.time} · ${data.autopilot.maxItems === 0 ? '∞' : `≤${data.autopilot.maxItems}`}/night · ${data.autopilot.minutes % 60 === 0 ? `${data.autopilot.minutes / 60}h` : `${data.autopilot.minutes}m`} cap · ${data.autopilot.tokens === 0 ? '∞ tokens' : fmtTok(data.autopilot.tokens)}`
    : 'Nightly and every scheduled session are paused · Run now still works.';

  // ---- 6. up next ----------------------------------------------------------
  // The RUN QUEUE, not the calendar — the rail's NEXT UP is the calendar and
  // they are deliberately different lists. Queued jobs first (they run the
  // moment a slot frees), then tonight's nightly if it is armed and eligible.
  //
  // 2a draws a drag handle on these rows and there is deliberately none here.
  // The queue's order is DERIVED — tier first, then bucket and position (#227)
  // — so a handle would promise a reordering the queue would ignore on its next
  // poll. The Tiers view is where that order is actually set.
  const queued = data.jobs.filter((j) => j.status === 'queued' && !isPausedSession(j));
  const nightlyDue = armed && data.totals.automode > 0;

  const openJobFor = (slug: string) => data.jobs.find((j) => j.slug === slug && OPEN_JOB.has(j.status));
  const previewFor = (slug: string, branch: string) =>
    p.previews.find((v) => v.slug === slug && v.branch === branch
      && ['queued', 'starting', 'live', 'stopping'].includes(v.status)) || null;

  const MIRROR_ORDER = ['live', 'stopping', 'starting', 'queued'];
  const openMirrors = p.previews
    .filter((v) => MIRROR_ORDER.includes(v.status))
    .sort((a, b) => MIRROR_ORDER.indexOf(a.status) - MIRROR_ORDER.indexOf(b.status));
  const mirrorLeft = (iso: string | null) => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'expiring now';
    const mins = Math.round(ms / 60_000);
    return mins < 60 ? `${mins}m left` : `${Math.floor(mins / 60)}h ${mins % 60}m left`;
  };

  // ---- 7. active projects --------------------------------------------------
  // Active = running something, automode, or pushed recently enough to be on
  // your mind. The rest are idle and sit behind the "N idle" link rather than
  // padding the grid — which is 2a's cut, and the honest one: a project nobody
  // has touched in a month is not competing for attention.
  const isActive = (x: ControlProject) =>
    !!x.live || x.automode || x.branches.length > 0 || !!openJobFor(x.slug);
  const active = data.projects.filter(isActive);
  const idleProjects = data.projects.filter((x) => !isActive(x));
  const shownProjects = showIdle ? [...active, ...idleProjects] : active;

  return (<>
    {/* ---- 1. the arm switch ------------------------------------------- */}
    <div className={`now-arm ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <div className="row">
        <button role="switch" aria-checked={armed} aria-label="Autopilot armed"
          className={`switch ${armed ? 'on' : ''}`}
          onClick={() => p.onSetArmed(!armed)}>
          <span className="switch-knob" />
        </button>
        <span className="lbl">{fleetStatus ? fleetStatus.text : `Autopilot is ${armed ? 'armed' : 'off'}`}</span>
        <span className="sum">{fleetStatus?.hint || summary}</span>
        {fleetStatus?.fix?.kind === 'arm' && (
          <button className="btn-danger sm" onClick={() => p.onSetArmed(true)}>{fleetStatus.fix.label}</button>
        )}
        {fleetStatus?.fix?.kind === 'plan' && (
          <button className="btn-repo sm" onClick={() => p.onGoRoom('plan')}>{fleetStatus.fix.label}</button>
        )}
        {fleetStatus?.fix?.kind === 'resume' && (() => {
          const j = data.jobs.find(isPausedSession);
          return j ? <button className="btn-repo sm" onClick={() => p.onResumeJob(j)}>{fleetStatus.fix!.label}</button> : null;
        })()}
        <button className="cfg" onClick={p.onToggleCfg} aria-expanded={p.cfgOpen}>
          {p.cfgOpen ? '▾ close' : '▸ configure'}
        </button>
      </div>
      {p.cfgOpen && <div className="mc14-cfg">{p.configPanel}</div>}
    </div>

    {/* ---- 2. Needs you ------------------------------------------------- */}
    <div className={`att-card now-needs ${attention.length ? 'flag' : 'calm'}`}>
      <div className="att-head">
        <span className="att-title">Needs you</span>
        <span className="att-count">{attention.length || '✓'}</span>
      </div>
      {attention.length === 0 ? (
        <div className="now-none">
          {hostSeen
            ? 'Nothing is waiting on you — no session is stopped on a prompt, nothing is paused, and every change has a verdict.'
            : 'The host daemon is offline, so Stack cannot see whether a session is stopped on a prompt. This is not an all-clear.'}
        </div>
      ) : (
        <div className="now-rows">
          {attention.map((a) => (
            <div className={`now-row ${a.kind}`} key={a.key}>
              <span className="tag">{a.kind}</span>
              <span className="txt">
                <b>{a.name}</b> {a.text}
                {a.detail && <code>{a.detail}</code>}
                {answerNote[a.key] && <em className="note">{answerNote[a.key]}</em>}
              </span>
              <span className="when">{a.when}</span>
              <span className="acts">
                {a.kind === 'permission' && (<>
                  {/* Jump in first, and deliberately first: the row carries one
                      line of a question that may have a whole diff behind it,
                      and reading it in the session is always the better answer. */}
                  <a className="btn-repo sm" href={hrefTo.terminal(a.cwd || undefined, a.tmux)}>Jump in</a>
                  <button className="btn-repo sm" disabled={answering === a.key}
                    title="Send Escape — cancels the prompt and hands the session back to whoever is at the keyboard"
                    onClick={() => void answer(a, 'deny')}>Deny</button>
                  <button className="btn-accent sm" disabled={answering === a.key}
                    title="Send the plain Yes. Never the 'and don't ask again' option — widening a permission for the rest of a session is a decision for the keyboard."
                    onClick={() => void answer(a, 'approve')}>
                    {answering === a.key ? '◴' : 'Approve'}
                  </button>
                </>)}
                {a.kind === 'paused' && (() => {
                  const j = data.jobs.find((x) => x.id === a.jobId);
                  if (!j) return null;
                  return (<>
                    {j.status === 'queued' && j.notBefore && (
                      <button className="btn-repo sm" onClick={() => p.onHangupJob(j)}
                        title="Hang up — hold the session so it only resumes when you say">⏸ Hang up</button>
                    )}
                    <button className="btn-repo sm" onClick={() => p.onResumeJob(j)}
                      title="Resume now — the dispatcher picks it up within a minute">▶ Resume</button>
                    <button className="now-x" onClick={() => p.onDismissJob(j)}
                      aria-label="Dismiss this paused session"
                      title="Dismiss — drop the pending resume entirely">×</button>
                  </>);
                })()}
                {a.kind === 'review' && (
                  <button className="btn-repo sm" onClick={() => p.onGoRoom('review')}>Review</button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>

    {/* ---- 3. collisions ------------------------------------------------ */}
    {conflicts.map((c) => (
      <div className="now-clash" key={c.key}>
        <span className="tag">conflict</span>
        <span className="txt">
          {c.count} <b>{c.name}</b> session{c.count === 1 ? '' : 's'} are editing <code>{c.file}</code>
          {c.branch && <> on <code>{c.branch}</code></>} — whoever lands second will rebase.
        </span>
        <span className="when">{c.when}</span>
        <span className="acts">
          <a className="btn-repo sm" href={hrefTo.terminal(c.slug || undefined)}>Open</a>
        </span>
      </div>
    ))}

    {/* ---- 4. sessions, grouped by project ------------------------------ */}
    {/* "Change the roles" OPENS the config — it never toggles it. A lane's
        button reaching for a panel that is already open must not shut it. */}
    <SessionLanes data={data} labelBusy={p.labelBusy} onLabel={p.onLabel}
      onConfigureRoles={() => { if (!p.cfgOpen) p.onToggleCfg(); }} onReload={p.onReload} />

    {/* ---- 5. mirror sites ---------------------------------------------- */}
    {/* (#208) Rendered even when empty, on the same reasoning as the fleet's
        idle slots: a feature you cannot see when it is idle is a feature
        nobody finds. The link is the entire point — it is how a branch
        reaches a phone, or anyone you want to show. */}
    <div className="now-sec">
      <div className="now-cap">
        <span className="cap">Mirror sites</span>
        <span className="hair" />
        <span className="note">
          {openMirrors.length === 0 ? 'nothing mirrored' : `${openMirrors.length} up · public while they live`}
        </span>
      </div>
      <div className="now-table">
        {openMirrors.length === 0 ? (
          <div className="now-none">
            Empty — ◱ Preview on a branch below brings one up, a minute or two for a warm build.
          </div>
        ) : openMirrors.map((v) => (
          <div className={`now-mirror ${v.status}`} key={v.id}>
            <span className="who">
              <span className={`dot ${v.status}`} />
              <b>{v.name || v.slug}</b>
            </span>
            <span className="what">
              <code>{v.branch}</code>
              {v.status === 'live' && v.url ? (
                <a href={v.url} target="_blank" rel="noreferrer noopener"
                  title="Opens the mirror in a new tab — public link, no sign-in wall in front of it">
                  {v.url.replace(/^https?:\/\//, '')}
                </a>
              ) : <em>{v.detail || 'starting on the host'}</em>}
            </span>
            <span className="left">{mirrorLeft(v.expiresAt)}</span>
            <span className="acts">
              {(v.status === 'live' || v.status === 'starting') && (
                <button className="btn-repo sm" disabled={p.mirrorBusy === v.id}
                  title="Give this mirror another hour before it expires"
                  onClick={() => p.onExtendPreview(v)}>{p.mirrorBusy === v.id ? '◴' : '＋1h'}</button>
              )}
              {v.status !== 'stopping' && (
                <button className="now-x" title="Stop this mirror and free the host"
                  onClick={() => p.onStopPreview(v)}>×</button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>

    {/* ---- 6. up next --------------------------------------------------- */}
    <div className="now-sec">
      <div className="now-cap">
        <span className="cap">Up next</span>
        <span className="hair" />
        <span className="note">
          {queued.length === 0 && !nightlyDue ? 'nothing queued'
            : `${queued.length} queued · order is tier, then bucket`}
        </span>
      </div>
      <div className="now-table">
        {queued.length === 0 && !nightlyDue ? (
          <div className="now-none">
            The queue is empty. ▶ Run now on a project below puts a session in it, and the Nights
            room books one for later.
          </div>
        ) : (<>
          {queued.map((j, i) => (
            <div className="now-queued" key={j.id}>
              <span className="n">{i + 1}</span>
              <span className="who"><b>{j.name}</b></span>
              <span className="what">{j.itemId ? `#${j.itemId} ${j.itemTitle || 'item'}` : `${j.kind} job`}</span>
              <span className="left">{j.when || 'waits for a slot'}</span>
              <span className="acts">
                {/* The Build room used to own this jump; with it gone, "open
                    what this session will work" is the item itself on its own
                    board — a room-free answer, and a truer one. A job with no
                    item (a plan sweep) opens the board it will plan. */}
                <button className="btn-repo sm"
                  onClick={() => go.detail(j.slug, 'roadmap', j.itemId || undefined)}
                  title="Open what this session will work, on its project's board">Open</button>
              </span>
            </div>
          ))}
          {nightlyDue && (
            <div className="now-queued nightly">
              <span className="n">☾</span>
              <span className="who"><b>Nightly</b></span>
              <span className="what">
                {data.totals.automode} automode project{data.totals.automode === 1 ? '' : 's'} ·{' '}
                {data.autopilot.maxItems === 0 ? 'unlimited' : `≤${data.autopilot.maxItems}`} items
              </span>
              <span className="left">tonight {data.autopilot.time}</span>
              <span className="acts">
                <button className="btn-repo sm" onClick={() => p.onGoRoom('nights')}>Nights</button>
              </span>
            </div>
          )}
        </>)}
      </div>
    </div>

    {/* ---- 7. active projects ------------------------------------------- */}
    <div className="now-sec">
      <div className="now-cap">
        <span className="cap">Active projects</span>
        <span className="hair" />
        {idleProjects.length > 0 && (
          <button className="now-idlelink" onClick={() => setShowIdle((v) => !v)}>
            {showIdle ? '← hide idle' : `${idleProjects.length} idle →`}
          </button>
        )}
      </div>
      <div className="now-grid">
        {shownProjects.map((x) => {
          const job = openJobFor(x.slug);
          const isOpen = openProject === x.slug;
          const branchN = x.branches.length;
          return (
            <div className={`now-card${x.automode ? ' auto' : ''}${isOpen ? ' open' : ''}`} key={x.slug}>
              <div className="head">
                <button className="nm" onClick={() => go.detail(x.slug)}>
                  <span className="tintdot" style={{ background: x.tint || 'var(--sand)' }} />
                  {x.name}
                </button>
                <span className={`statusbadge ${x.status}`}><span className="dot" />{STATUS_LABEL[x.status]}</span>
              </div>
              <div className="facts">
                <span>{x.lastPush ? `pushed ${x.lastPush}` : 'no pushes yet'}</span>
                {x.live && <span className="live">● {x.live.branches.join(' · ')}</span>}
                {x.bugs.serious > 0 && (
                  <button className="bad" onClick={() => go.detail(x.slug, 'quality')}>
                    {x.bugs.serious} serious
                  </button>
                )}
                {x.reviewCount > 0 && (
                  <button onClick={() => p.onGoRoom('review')}>{x.reviewCount} to review</button>
                )}
              </div>
              {/* Tonight's pick and its target area — the two facts that decide
                  what an automode project actually does when the night comes. */}
              {x.automode && (
                <div className="pick">
                  {x.nextPick ? (
                    <button className="mc-pick" onClick={() => go.detail(x.slug, 'roadmap', x.nextPick!.id)}>
                      tonight: #{x.nextPick.id} {x.nextPick.title}
                    </button>
                  ) : (
                    <span className="quiet">tonight: nothing eligible{x.autopilotArea ? ` in ${x.autopilotArea}` : ''}</span>
                  )}
                  {(x.areas.length > 0 || x.autopilotArea) && (
                    <select className="mc-area" value={x.autopilotArea} aria-label={`Target area for ${x.name}`}
                      title="Point the nightly pick at one product area; the whole board otherwise"
                      onChange={(e) => p.onSetTargetArea(x, e.target.value)}>
                      <option value="">all areas</option>
                      {[...new Set([...x.areas, ...(x.autopilotArea ? [x.autopilotArea] : [])])].map((a) => (
                        <option key={a} value={a}>{a}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <div className="acts">
                {job ? (
                  <span className={`mc-job ${job.status}`} title={job.detail || undefined}>
                    {job.kind === 'resume' && job.notBefore ? `resumes ${resumeWhen(job.notBefore)}` : JOB_LABEL[job.status]}
                    {job.itemId ? ` #${job.itemId}` : ''}
                  </span>
                ) : (
                  <button className={x.automode ? 'btn-accent sm' : 'btn-repo sm'} onClick={() => p.onRunNow(x)}
                    title="Queue an autopilot session on this project now — the host picks it up within a minute">
                    ▶ Run now
                  </button>
                )}
                <a className="term" href={hrefTo.terminal(x.slug)} title={`Open a terminal in ~/${x.slug}`}>⌨</a>
                <button role="switch" aria-checked={x.automode} aria-label={`Automode for ${x.name}`}
                  className={`switch sm ${x.automode ? 'on' : ''}`} onClick={() => p.onToggleAutomode(x)}
                  title={x.automode ? 'Automode on — the autopilot may work this project' : 'Automode off — hands off'}>
                  <span className="switch-knob" />
                </button>
                {/* The merge strip lives under the card rather than beside the
                    name. 2a's grid has no room for it, and it is the one thing
                    on the old project row that cannot be cut: with the Build
                    room gone this is the only ⇥ Merge in the app. */}
                <button className="drop" aria-expanded={isOpen}
                  onClick={() => setOpenProject(isOpen ? '' : x.slug)}
                  title={branchN ? `${branchN} open branch${branchN === 1 ? '' : 'es'}` : 'No open branches'}>
                  {branchN > 0 && <em>{branchN}</em>}{isOpen ? '⌃' : '⌄'}
                </button>
              </div>
              {isOpen && (
                <BranchStrip project={x} data={data} previewFor={previewFor}
                  previewBusy={p.previewBusy} onStartPreview={p.onStartPreview}
                  onStopPreview={p.onStopPreview} onMerge={p.onMerge} onMergeTrain={p.onMergeTrain} />
              )}
            </div>
          );
        })}
      </div>
      {data.projects.length === 0 && (
        <div className="empty-state">
          <div className="big">No projects yet</div>
          <div>Connect a repo from the dashboard and it'll appear here.</div>
        </div>
      )}
      {active.length === 0 && data.projects.length > 0 && (
        <div className="now-none">
          Nothing is active — every project is idle. The {idleProjects.length} above the fold are
          one ▶ Run now away.
        </div>
      )}
    </div>
  </>);
}

// #154 / #207 / #208 — the merge strip, unchanged in behaviour and moved into
// the project card's drawer. One chip per open branch, enriched with the host's
// git report where there is one, and every number on it is a SNAPSHOT: the
// dispatcher fetches and re-probes on its own ~10-minute cycle, not on this
// page load. That caveat rides at the end of the strip rather than in a hover
// on the container, which is exactly where a reader given precise-looking
// counts will not look (#288).
function BranchStrip({ project: x, data, previewFor, previewBusy, onStartPreview, onStopPreview, onMerge, onMergeTrain }: {
  project: ControlProject;
  data: ControlData;
  previewFor: (slug: string, branch: string) => Preview | null;
  previewBusy: string | null;
  onStartPreview: (slug: string, branch: string, itemId: string | null) => void;
  onStopPreview: (pv: Preview) => void;
  onMerge: (p: ControlProject, b: ControlProject['branches'][number]) => void;
  onMergeTrain: (p: ControlProject) => void;
}) {
  const openMergeJobs = (branch: string) => data.jobs.some((j) => j.slug === x.slug && j.kind === 'merge'
    && j.detail.includes(`origin/${branch} into`) && OPEN_JOB.has(j.status));
  const cleanN = x.branches.filter((b) => b.mergeClean === true && !openMergeJobs(b.branch)).length;

  if (x.branches.length === 0 && (x.absorbedBranches ?? 0) === 0) {
    return (
      <div className="mc-branches" aria-label={`Open branches for ${x.name}`}>
        <span className="mc-branch-asof">
          No open branches{x.branchesWhen ? ` — git as of ${x.branchesWhen}` : ' — no git report from the host yet'}.
        </span>
      </div>
    );
  }

  return (
    <div className="mc-branches" aria-label={`Open branches for ${x.name}`}
      title={x.branchesWhen ? `git state as of ${x.branchesWhen}` : undefined}>
      {[...x.branches].sort((a, b) => {
        // #288 — order by what needs a HUMAN, the same rule the lane list
        // sorts on. A conflicting branch is the one the machine cannot finish
        // at all; a clean one is a decision away; an unprobed one is neither
        // yet. Within a group, most work first.
        const rank = (v: typeof a) => (v.mergeClean === false ? 0 : v.mergeClean === true ? 1 : 2);
        return rank(a) - rank(b) || (b.ahead ?? 0) - (a.ahead ?? 0) || a.branch.localeCompare(b.branch);
      }).map((b) => {
        const mergeJob = data.jobs.find((j) => j.slug === x.slug && j.kind === 'merge' && j.detail.includes(b.branch));
        const chipTitle = [
          b.itemTitle ? `#${b.itemId} ${b.itemTitle}` : b.branch,
          b.subject ? `Last commit: ${b.subject}${b.when ? ` (${b.when})` : ''}` : '',
        ].filter(Boolean).join('\n');
        const pv = previewFor(x.slug, b.branch);
        const busy = previewBusy === `${x.slug}:${b.branch}`;
        return (
          <span key={b.branch} title={chipTitle}
            className={`mc-branch ${mergeJob ? mergeJob.status : ''}`
              + (b.mergeClean === false ? ' conflicts' : b.mergeClean === true ? ' clean' : '')}>
            <button className="mc-branch-name" onClick={() => go.detail(x.slug, 'roadmap', b.itemId)}>
              {b.branch}
            </button>
            {b.itemId && <span className="mc-branch-item">#{b.itemId}</span>}
            {typeof b.ahead === 'number' && (
              <span className="mc-branch-diff"
                title={`${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead of main${b.behind ? `, ${b.behind} behind` : ''}`}>
                ↑{b.ahead}{(b.behind ?? 0) > 0 && <> ↓{b.behind}</>}
              </span>
            )}
            {b.mergeClean === true && <span className="mc-branch-clean" title="Merges cleanly into main">✓</span>}
            {b.mergeClean === false && (
              <span className="mc-branch-conflict" title="Conflicts with main — rebase or merge by hand">⚠</span>
            )}
            {b.when && (
              <span className="mc-branch-age"
                title={b.subject ? `Last commit ${b.when}: ${b.subject}` : `Last commit ${b.when}`}>
                {b.when}
              </span>
            )}
            {mergeJob ? (
              <span className="mc-branch-status">{
                mergeJob.status === 'queued' || mergeJob.status === 'claimed' ? 'queuing…'
                  : mergeJob.status === 'running' ? 'merging…'
                  : mergeJob.status === 'done' ? 'merged'
                  : mergeJob.detail.slice(0, 60) || mergeJob.status
              }</span>
            ) : (
              <button className="mc-branch-merge"
                title={`Merge origin/${b.branch} into main on the host — conflicts fail safely`}
                onClick={() => onMerge(x, b)}>⇥ Merge</button>
            )}
            {!pv ? (
              <button className="mc-branch-preview" disabled={busy}
                title={`Bring ${b.branch} up as an isolated stack on the host and open it on a temporary public URL. Expires in 2 hours.`}
                onClick={() => onStartPreview(x.slug, b.branch, b.itemId || null)}>
                {busy ? '◴ …' : '◱ Preview'}
              </button>
            ) : pv.status === 'live' && pv.url ? (
              <span className="mc-branch-previewlive">
                <a className="url" href={pv.url} target="_blank" rel="noopener noreferrer"
                  title={`${pv.url} — public while it lives, expires ${pv.expiresAt ? new Date(pv.expiresAt).toLocaleTimeString() : 'soon'}`}>
                  ◱ Open
                </a>
                <button className="x" aria-label="Stop preview" title="Stop this preview and free the host"
                  onClick={() => onStopPreview(pv)}>×</button>
              </span>
            ) : (
              <span className="mc-branch-status" title={pv.detail}>
                {pv.status === 'stopping' ? 'stopping…' : pv.status === 'queued' ? 'preview queued…' : 'preview building…'}
              </span>
            )}
          </span>
        );
      })}
      {/* #193 — the merge train: queue every probe-clean branch in one press;
          they run sequentially, each merging into the main the last produced. */}
      {cleanN >= 2 && (
        <button className="mc-branch-merge mc-train"
          title="Queue a merge for every branch the probe calls clean — they merge one after another, each onto the main the last one produced"
          onClick={() => onMergeTrain(x)}>
          ⇥ Merge train ({cleanN} clean)
        </button>
      )}
      {(x.absorbedBranches ?? 0) > 0 && (
        <span className="mc-branch-absorbed"
          title="Fully merged into main but never deleted on origin — prune with: git push origin --delete <branch>">
          🧹 {x.absorbedBranches} merged branch{x.absorbedBranches === 1 ? '' : 'es'} to prune
        </span>
      )}
      <span className="mc-branch-asof"
        title="The host dispatcher fetches each repo and re-probes every ~10 minutes; the ahead/behind counts and the conflict probe are from that pass, not from this page load.">
        {x.branchesWhen ? `git as of ${x.branchesWhen}` : 'no git report yet — chips are claims only'}
      </span>
    </div>
  );
}
