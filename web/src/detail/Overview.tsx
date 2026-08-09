// The Overview tab — design 4a, "queue depth, not a funnel".
//
// The tab used to be five point-in-time bands with no direction of travel, and
// it hid the one number the Dashboard shows about a project. It is now built
// around the SPINE: the five stages a change passes through, each drawn as the
// queue standing in it, each a doorway into the tab or room that owns that
// stage. Everything below the spine either explains the headline number or is
// something the spine sends you into.
//
// Three rules this file exists to hold:
//
//  1. NO STAGE IS COMPUTED HERE. Every predicate lives in `lib/spine.ts`, pure
//     and tested (`scripts/spine.test.mjs`), because the Built stage's
//     predicate must stay identical to the Review room's own (#374) — a copy
//     in a component is how the two silently stop agreeing.
//  2. NO INVENTED THROUGHPUT. The design draws a flow rate between each pair of
//     stages; Stack has no stage-transition stamp to compute one from (rows
//     carry `updatedAt`, which is MOVEMENT, not a ledger), so the connectors
//     carry no number. What IS honest — how long a queue has sat still — is
//     shown on the stage itself. Absent is not zero.
//  3. THE CADENCE STRIP IS ABSENT, NEVER EMPTY, when the server didn't measure
//     it. A month of zero-height bars reads as "this project died", which is a
//     different claim from "this server is older than the strip".
//
// Deployment and Tech stack are twice-a-year config and now sit collapsed in
// the rail; their editors are unchanged, just no longer at the same visual
// weight as live state.

import { useState } from 'react';
import type { Activity, Bug, Future, Project, ProjectStatus, Roadmap as RoadmapData } from '../types';
import { PRODUCT_NAME } from '../lib/ui';
import { ResumeSinceStrip } from '../components/ResumeSinceStrip';
import {
  buildSpine, progressLedger, nextUp, bugSpread, readCadence, PROGRESS_CAP,
  type Stage,
} from '../lib/spine';
import { go } from '../lib/route';

// One row of the project-scoped review queue (hook-created, not yet reviewed).
export interface ReviewEntry {
  kind: 'bug' | 'roadmap' | 'future';
  key: string;      // bug key or row id
  title: string;
  meta: string;     // severity / bucket / 'idea'
}

export interface DeployPatch { deploy_platform: string; logs_url: string; status: ProjectStatus }

const STATUS_OPTS: { key: ProjectStatus; label: string }[] = [
  { key: 'live', label: 'Live' }, { key: 'building', label: 'Building' },
  { key: 'paused', label: 'Paused' }, { key: 'archived', label: 'Archived' },
];
const STATUS_TEXT: Record<ProjectStatus, string> = {
  live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived',
};

// ---------------------------------------------------------------------------
// the spine
// ---------------------------------------------------------------------------

// Bar height is the queue's depth on a SQUARE-ROOT scale, not a linear one: a
// 230-deep archive beside a 1-deep lane renders every working stage as a
// hairline under a linear scale, and the comparison the band exists to make —
// which queue is deepest — disappears. Landed is excluded from the scale and
// drawn as a fixed plinth, because it is where work is meant to pile up.
const BAR_MIN = 8;
const BAR_MAX = 74;
function barHeight(count: number, peak: number): number {
  if (count <= 0) return 3;
  if (peak <= 0) return BAR_MIN;
  return Math.round(BAR_MIN + (BAR_MAX - BAR_MIN) * (Math.sqrt(count) / Math.sqrt(peak)));
}

function StageColumn({ stage, peak }: { stage: Stage; peak: number }) {
  const landed = stage.key === 'landed';
  return (
    <button className={`spine-stage${stage.blocked ? ' blocked' : ''}${landed ? ' landed' : ''}`}
      onClick={() => { window.location.hash = stage.href; }}
      title={`${stage.count} ${stage.label.toLowerCase()} — open ${stage.hrefLabel}`}>
      <div className="spine-plot">
        <div className="spine-n">
          <span className="n">{stage.count}</span>
          {stage.blocked && <span className="flag">backed up</span>}
        </div>
        <div className="spine-bar" style={{ height: landed ? 26 : barHeight(stage.count, peak) }} />
      </div>
      <div className="spine-legend">
        <span className="label">{stage.label}</span>
        <span className="sub">{stage.sub}</span>
        <span className="to">{stage.hrefLabel} →</span>
      </div>
    </button>
  );
}

function Spine({ stages, slug }: { stages: Stage[]; slug: string }) {
  const peak = Math.max(...stages.filter((s) => s.key !== 'landed').map((s) => s.count), 1);
  const blocked = stages.find((s) => s.blocked) || null;
  const still = blocked?.lastMovedDays ?? null;

  return (
    <div className="spine">
      <div className="spine-head">
        <div className="left">
          <span className="lbl">Progression</span>
          {/* `hint`, not `note` — `.note` is the Workbench sticky and would
              paint this line on yellow paper. */}
          <span className="hint">bar height is the queue standing in a stage</span>
        </div>
      </div>

      <div className="spine-row">
        {stages.map((s, i) => (
          <div className="spine-cell" key={s.key}>
            {i > 0 && <span className="spine-link" aria-hidden="true">›</span>}
            <StageColumn stage={s} peak={peak} />
          </div>
        ))}
      </div>

      {blocked ? (
        <div className="spine-foot blocked">
          <span className="txt">
            <b>{blocked.label}</b> is where this project is stuck. {blocked.count} {
              blocked.key === 'built' ? 'changes are waiting on a verdict'
                : blocked.key === 'inflight' ? 'items are claimed and running'
                  : 'items are planned and unclaimed'
            }{still !== null && `, and none has moved in ${still} day${still === 1 ? '' : 's'}`} — clearing
            them is what unblocks everything behind.
          </span>
          <button className="btn-accent sm" onClick={() => { window.location.hash = blocked.href; }}>
            Open {blocked.hrefLabel}
          </button>
        </div>
      ) : (
        <div className="spine-foot">
          <span className="txt">
            Nothing is banked up. The deepest queue is moving, so the next thing to do is whatever
            you want built — not whatever is waiting on you.
          </span>
          <button className="btn-cancel sm" onClick={() => go.detail(slug, 'roadmap')}>Open Roadmap</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the progress ledger
// ---------------------------------------------------------------------------

function ProgressLedgerCard({ project, roadmap, bugs }: {
  project: Project; roadmap: RoadmapData; bugs: Bug[];
}) {
  const led = progressLedger(project.progress, roadmap, bugs);
  const items = led.lines.reduce((n, l) => n + l.total, 0);
  const doneItems = led.lines.reduce((n, l) => n + l.done, 0);

  return (
    <div className="ledger">
      <div className="ledger-head">
        <span className="lbl">Progress</span>
        <span className="hint">recomputed on read · not stored over time</span>
      </div>
      <div className="ledger-figure">
        <span className="pct">{led.pct}%</span>
        <span className="says">
          {items === 0
            ? 'No Musts or Shoulds on the board yet, so there is nothing to be a fraction of.'
            : <>Weighted across the Musts and Shoulds — {doneItems} of {items} done, and a finished
              Must counts double a finished Should.</>}
        </span>
      </div>
      {items > 0 && (
        <div className="ledger-bars">
          {led.lines.map((l, i) => (
            <div className="ledger-bar" key={l.label}>
              <span className={`mk ${i === 0 ? 'must' : 'should'}`} />
              <span className="name">{l.label}</span>
              <span className="track">
                <span className={`fill ${i === 0 ? 'must' : 'should'}`}
                  style={{ width: l.total ? `${(l.done / l.total) * 100}%` : 0 }} />
              </span>
              <span className="count">{l.done} / {l.total}</span>
            </div>
          ))}
        </div>
      )}
      {led.seriousBugs > 0 && (
        <div className="ledger-cap">
          <span className="mk" />
          <span>
            {led.seriousBugs} critical or high bug{led.seriousBugs === 1 ? ' is' : 's are'} open, so
            this figure is capped at {PROGRESS_CAP}%
            {led.capBiting
              ? ' — and that ceiling is what you are looking at. Closing them is what moves the number.'
              : '. It is not capped today: the arithmetic sits below the ceiling on its own.'}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the cadence strip
// ---------------------------------------------------------------------------

function CadenceCard({ cadence, lastPushAt }: {
  cadence: { day: string; n: number }[]; lastPushAt: string | null;
}) {
  // Absent, not empty: an older server sends no buckets, and 28 flat bars would
  // claim a month of silence this page cannot actually see.
  if (!cadence.length) return null;
  const c = readCadence(cadence, lastPushAt);
  const dayLabel = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${d.getUTCDate()} ${d.toLocaleString('en-AU', { month: 'short', timeZone: 'UTC' })}`;
  };

  return (
    <div className="cadence">
      <div className="cadence-head">
        <span className="lbl">Cadence — 28 days</span>
        {c.quietFor === null
          ? <span className="hint">no pushes yet</span>
          : <span className={`hint${c.quiet ? ' warn' : ''}`}>
            {c.quietFor === 0 ? 'pushed today' : `quiet for ${c.quietFor} day${c.quietFor === 1 ? '' : 's'}`}
          </span>}
      </div>
      <div className="cadence-bars">
        {/* Square-root scaled, same reason as the spine's bars: one 37-push
            night against a fortnight of ones and twos flattens every ordinary
            day to a 2px stub under a linear scale, and an ordinary day is
            exactly what this strip is for. */}
        {c.days.map((d) => (
          <span key={d.day} className={`cbar${d.n === 0 ? ' none' : ''}`}
            style={{ height: d.n === 0 ? 2 : Math.max(7, Math.round(48 * Math.sqrt(d.n / c.peak))) }}
            title={`${dayLabel(d.day)} — ${d.n} push${d.n === 1 ? '' : 'es'}`} />
        ))}
      </div>
      <div className="cadence-axis">
        <span>{dayLabel(c.days[0].day)}</span>
        <span>{dayLabel(c.days[c.days.length - 1].day)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// config — twice-a-year settings, collapsed into one quiet strip
// ---------------------------------------------------------------------------

function DeploymentEditor({ project, onSave, onDone }: {
  project: Project; onSave: (p: DeployPatch) => void; onDone: () => void;
}) {
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [platform, setPlatform] = useState(project.deployPlatform);
  const [logs, setLogs] = useState(project.logsUrl);
  const save = () => {
    onSave({ status, deploy_platform: platform.trim(), logs_url: logs.trim() });
    onDone();
  };
  return (
    <div className="deploy-edit">
      <div className="seg-control" role="tablist" aria-label="Status">
        {STATUS_OPTS.map((s) => (
          <button key={s.key} role="tab" aria-selected={status === s.key}
            className={`seg-opt ${status === s.key ? 'on' : ''}`} onClick={() => setStatus(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <input className="field-input sm" value={platform} placeholder="Platform — e.g. Dokploy, Vercel"
        onChange={(e) => setPlatform(e.target.value)} />
      <input className="field-input sm" value={logs} placeholder="Logs URL (optional)"
        onChange={(e) => setLogs(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') onDone(); }} />
      <div className="row">
        <button className="btn-cancel sm" onClick={onDone}>Cancel</button>
        <button className="btn-submit sm" onClick={save}>Save</button>
      </div>
    </div>
  );
}

function StackEditor({ stack, onSave, onDone }: {
  stack: string[]; onSave: (next: string[]) => void; onDone: () => void;
}) {
  const [list, setList] = useState<string[]>(stack);
  const [draft, setDraft] = useState('');
  const withDraft = () => {
    const t = draft.trim();
    return t && !list.includes(t) ? [...list, t] : list;
  };
  const save = () => { onSave(withDraft()); onDone(); };
  return (
    <div className="deploy-edit">
      <div className="techchips">
        {list.map((s) => (
          <span key={s} className="techchip editable">
            {s}
            <button onClick={() => setList(list.filter((x) => x !== s))} aria-label={`Remove ${s}`}>×</button>
          </span>
        ))}
      </div>
      <input className="field-input sm" autoFocus value={draft} placeholder="Add — e.g. React, Postgres…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { setList(withDraft()); setDraft(''); } else if (e.key === 'Escape') onDone();
        }} />
      <div className="row">
        <button className="btn-cancel sm" onClick={onDone}>Cancel</button>
        <button className="btn-submit sm" onClick={save}>Save</button>
      </div>
    </div>
  );
}

function ConfigStrip({ project, onSaveDeploy, onSaveStack }: {
  project: Project; onSaveDeploy: (p: DeployPatch) => void; onSaveStack: (next: string[]) => void;
}) {
  const [editing, setEditing] = useState<'' | 'deploy' | 'stack'>('');
  const stack = project.meta.stack;

  return (
    <div className="config-strip">
      <div className="config-head">
        <span className="lbl">Config</span>
        {!editing && (
          <span className="config-edits">
            <button onClick={() => setEditing('deploy')}>deployment</button>
            <button onClick={() => setEditing('stack')}>stack</button>
          </span>
        )}
      </div>

      {editing === 'deploy' ? (
        <DeploymentEditor project={project} onSave={onSaveDeploy} onDone={() => setEditing('')} />
      ) : editing === 'stack' ? (
        <StackEditor stack={stack} onSave={onSaveStack} onDone={() => setEditing('')} />
      ) : (
        <>
          <div className="config-line">
            <span className={`dot ${project.status}`} />
            <span>{STATUS_TEXT[project.status]}</span>
            {project.deployPlatform && <span className="sep">·</span>}
            {project.deployPlatform && <span>{project.deployPlatform}</span>}
            <span className="sep">·</span>
            <span>main</span>
          </div>
          <div className="config-line dim">
            {stack.length ? stack.join(' · ') : 'no stack set'}
          </div>
          {project.logsUrl && (
            <button className="config-link"
              onClick={() => window.open(project.logsUrl, '_blank', 'noopener')}>View logs ↗</button>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the rail panels
// ---------------------------------------------------------------------------

// Standing instructions for the next session(s): edited here, injected
// verbatim at every SessionStart — steering without the terminal. Lines stay
// until removed.
function DirectivesPanel({ directives, onChange }: {
  directives: string[]; onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...directives, t]);
    setDraft('');
    setOpen(false);
  };

  return (
    <div className="rail-panel">
      <div className="rail-head">
        <span className="lbl">⚑ Directives</span>
        {!open && <button className="rail-link" onClick={() => setOpen(true)}>+ Add</button>}
      </div>
      <div className="rail-note">injected into every session start</div>
      {directives.length > 0 && (
        <div className="directives-list">
          {directives.map((d, i) => (
            <div className="directive" key={i}>
              <span className="mk">⚑</span>
              <span className="txt">{d}</span>
              <button className="x" onClick={() => onChange(directives.filter((_, x) => x !== i))}
                aria-label="Remove directive" title="Remove — it has been honoured or no longer applies">×</button>
            </div>
          ))}
        </div>
      )}
      {open ? (
        <div className="directive-composer">
          <input className="field-input sm" autoFocus value={draft}
            placeholder="e.g. Ship the token gate next — don't touch ingest"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); else if (e.key === 'Escape') setOpen(false); }} />
          <button className="btn-submit sm" onClick={add}>Add</button>
          <button className="btn-cancel sm" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : directives.length === 0 && (
        <div className="rail-empty">Nothing standing. Add a line and the next session opens with it front and centre.</div>
      )}
    </div>
  );
}

// 4a's river: one line per push, not a stack of full cards. The tab's job here
// is "what has this project been doing", which needs REACH — a dozen pushes at
// a glance — where the Activity tab's job is the detail. Summaries are clamped
// rather than truncated server-side, so the full text is still in the DOM for
// ⌘F and a screen reader.
function LandedRow({ a }: { a: Activity }) {
  return (
    <div className="landed-row">
      <span className="hash">{a.hash}</span>
      {/* A push with no summary is a real push whose session never wrote one
          (the hook's metadata backstop). Blank would read as a rendering
          fault; say which it is. */}
      <span className={`txt${a.summary.trim() ? '' : ' none'}`}>
        {a.summary.trim() || 'Pushed with no summary — the session ended without a checkpoint.'}
      </span>
      <span className="when">{a.when}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Overview({
  project, activity, directives, reviewQueue, roadmap, futures, bugs, cadence, lastPushAt,
  onViewAll, onExport, onChangeDirectives, onReviewKeep, onReviewDismiss, onSaveDeploy, onSaveStack,
  keepResumeCard = true, onJumpBack,
}: {
  project: Project; activity: Activity[]; directives: string[]; reviewQueue: ReviewEntry[];
  roadmap: RoadmapData; futures: Future[]; bugs: Bug[];
  cadence: { day: string; n: number }[]; lastPushAt: string | null;
  onViewAll: () => void; onExport: () => void; onChangeDirectives: (next: string[]) => void;
  onReviewKeep: (e: ReviewEntry) => void; onReviewDismiss: (e: ReviewEntry) => void;
  onSaveDeploy: (patch: DeployPatch) => void; onSaveStack: (next: string[]) => void;
  keepResumeCard?: boolean;
  onJumpBack?: () => void;
}) {
  const r = project.resume;
  const slug = project.id;
  const stages = buildSpine(roadmap, futures, slug);
  const queue = nextUp(roadmap);
  const spread = bugSpread(bugs);
  const openBugs = spread.reduce((n, s) => n + s.n, 0);
  const latest = activity.slice(0, 8);

  return (
    <div>
      {/* resume card — hidden when the resume card is switched off in Settings */}
      {keepResumeCard && (
      <div className="resume">
        <div className="resume-head">
          <div className="left">
            <div className="resume-ico">↩</div>
            <div className="resume-title">Pick up where you left off</div>
          </div>
          {r && (
            <div className="resume-meta">
              {/* `when` is the LAST PUSH, which is only when this card was
                  updated if that push authored a checkpoint. When it didn't,
                  say when the content was actually written. */}
              <div className="resume-when">
                {r.since?.authoredWhen
                  ? `checkpoint ${r.since.authoredWhen} · ${r.since.count} push${r.since.count === 1 ? '' : 'es'} since`
                  : `updated ${r.when} · after push ${r.ref}`}
              </div>
              {onJumpBack && (
                <button className="btn-export" onClick={onJumpBack}
                  title="Open a Claude session in this project with a debrief of where things stand">
                  Jump back in <span className="arr">↗</span>
                </button>
              )}
              <button className="btn-export" onClick={onExport} title="Download a markdown brief for starting back into this project">
                Export brief <span className="arr">↓</span>
              </button>
            </div>
          )}
        </div>

        {r ? (
          <>
            <ResumeSinceStrip since={r.since} slug={project.id} />
            <div className="resume-summary">{r.summary}</div>
            <div className="resume-cols">
              <div className="resume-col col-progress">
                <div className="lbl">Currently in progress</div>
                <div className="itemlist">
                  {r.inProgress.length ? r.inProgress.map((t, i) => (
                    <div className="item" key={i}><span className="mk dot" /><span>{t}</span></div>
                  )) : <div className="empty-soft">Nothing mid-flight.</div>}
                </div>
              </div>
              <div className="resume-col col-next">
                <div className="lbl">Suggested next</div>
                <div className="itemlist">
                  {r.nextUp.length ? r.nextUp.map((t, i) => (
                    <div className="item" key={i}><span className="mk arrow">→</span><span>{t}</span></div>
                  )) : <div className="empty-soft">Open road.</div>}
                </div>
              </div>
              <div className="resume-col col-keep">
                <div className="lbl">Working well — keep</div>
                <div className="itemlist">
                  {r.liked.length ? r.liked.map((t, i) => (
                    <div className="item" key={i}><span className="mk tick">✓</span><span>{t}</span></div>
                  )) : <div className="empty-soft">—</div>}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="resume-summary" style={{ marginBottom: 0 }}>
            Nothing captured yet. After your first push, a summary of where you left off lands here.
          </div>
        )}
      </div>
      )}

      <Spine stages={stages} slug={slug} />

      <div className="ov-grid">
        <div className="ov-main">
          <ProgressLedgerCard project={project} roadmap={roadmap} bugs={bugs} />
          <CadenceCard cadence={cadence} lastPushAt={lastPushAt} />

          <div className="landed">
            <div className="landed-head">
              <span className="lbl">What landed lately</span>
              <span className="hint">✦ auto-generated per push</span>
              {/* NOT "all {activity.length}" — this feed is server-capped at 50
                  rows, so a count here would name the cap and call it the
                  total. The Activity tab is where "all" actually lives. */}
              {activity.length > 0 && <button className="rail-link" onClick={onViewAll}>View all →</button>}
            </div>
            {latest.length ? (
              // Keyed by hash AND index: two sessions in one checkout end at the
              // same HEAD, so commit hashes repeat in this feed and a bare hash
              // key makes React drop one of the two rows.
              latest.map((a, i) => <LandedRow key={`${a.hash}:${i}`} a={a} />)
            ) : (
              <div className="rail-empty">
                No pushes yet. Every push posts a summary here through the {PRODUCT_NAME} API.
              </div>
            )}
          </div>
        </div>

        <div className="ov-rail">
          <div className="rail-panel">
            <div className="rail-head">
              <span className="lbl">Next up</span>
              <button className="rail-link" onClick={() => go.detail(slug, 'roadmap')}>the board</button>
            </div>
            {queue.length ? (
              <div className="rail-list">
                {queue.map((it) => (
                  <button className="rail-row" key={it.id}
                    onClick={() => go.detail(slug, 'roadmap', String(it.id))}>
                    <span className={`mk ${it.bucket === 'must' ? 'must' : 'should'}`} />
                    <span className="txt">{it.title}</span>
                    {it.tier && <span className="tier">{it.tier}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rail-empty">Nothing planned and unclaimed. The queue is empty, not stalled.</div>
            )}
          </div>

          {reviewQueue.length > 0 && (
            <div className="rail-panel">
              <div className="rail-head">
                <span className="lbl">Needs review</span>
                <span className="rail-count">{reviewQueue.length}</span>
              </div>
              <div className="rail-note">✦ auto-extracted from your pushes</div>
              <div className="rail-list">
                {reviewQueue.slice(0, 3).map((e) => (
                  <div className="rail-review" key={`${e.kind}:${e.key}`}>
                    <div className="line">
                      <span className={`review-kind ${e.kind}`}>
                        {e.kind === 'bug' ? e.key : e.kind === 'roadmap' ? 'roadmap' : 'idea'}
                      </span>
                      <span className="txt">{e.title}</span>
                    </div>
                    <div className="acts">
                      <button className="review-keep" onClick={() => onReviewKeep(e)} title="Keep — mark reviewed">✓ Keep</button>
                      <button className="review-dismiss" onClick={() => onReviewDismiss(e)} title="Dismiss — delete and don't re-extract">✕ Dismiss</button>
                    </div>
                  </div>
                ))}
              </div>
              {reviewQueue.length > 3 && (
                <div className="rail-more">{reviewQueue.length - 3} more waiting</div>
              )}
            </div>
          )}

          <div className="rail-panel">
            <div className="rail-head">
              <span className="lbl">Bugs</span>
              <button className="rail-link" onClick={() => go.detail(slug, 'quality')}>Quality</button>
            </div>
            {openBugs === 0 ? (
              <div className="rail-empty">No open bugs.</div>
            ) : (
              <div className="rail-list">
                {spread.map((s) => (
                  <div className="rail-sev" key={s.severity}>
                    <span className={`mk sev-${s.severity}`} />
                    <span className="name">{s.severity}</span>
                    <span className="n">{s.n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DirectivesPanel directives={directives} onChange={onChangeDirectives} />

          <ConfigStrip project={project} onSaveDeploy={onSaveDeploy} onSaveStack={onSaveStack} />
        </div>
      </div>
    </div>
  );
}
