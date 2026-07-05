import { useState } from 'react';
import type { Project, Activity, ProjectStatus } from '../types';
import { isAccentTag, PRODUCT_NAME } from '../lib/ui';

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

// The Deployment panel, hand-editable: status, platform label, logs URL.
function DeploymentPanel({ project, onSave }: { project: Project; onSave: (p: DeployPatch) => void }) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [platform, setPlatform] = useState(project.deployPlatform);
  const [logs, setLogs] = useState(project.logsUrl);

  const start = () => {
    setStatus(project.status); setPlatform(project.deployPlatform); setLogs(project.logsUrl);
    setEditing(true);
  };
  const save = () => {
    onSave({ status, deploy_platform: platform.trim(), logs_url: logs.trim() });
    setEditing(false);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="lbl">Deployment</div>
        {!editing && <button className="panel-edit" onClick={start} aria-label="Edit deployment" title="Edit deployment">✎</button>}
      </div>
      {editing ? (
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
            onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEditing(false); }} />
          <div className="row">
            <button className="btn-cancel sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn-submit sm" onClick={save}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <div className="deploy-row">
            <span className={`dot ${project.status}`} /><b>{STATUS_TEXT[project.status]}</b>
            <span className="mono">· main</span>
          </div>
          <div className="deploy-meta">
            Last push {project.meta.lastDeploy}{project.deployPlatform ? ` · ${project.deployPlatform}` : ''}
          </div>
          {project.logsUrl && (
            <button className="deploy-link" onClick={() => window.open(project.logsUrl, '_blank', 'noopener')}>
              View logs ↗
            </button>
          )}
        </>
      )}
    </div>
  );
}

// The Tech stack panel, hand-edited: chips with × in edit mode, ⏎ to add.
function TechStackPanel({ stack, onSave }: { stack: string[]; onSave: (next: string[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState<string[]>(stack);
  const [draft, setDraft] = useState('');

  const start = () => { setList(stack); setDraft(''); setEditing(true); };
  const withDraft = () => {
    const t = draft.trim();
    return t && !list.includes(t) ? [...list, t] : list;
  };
  const add = () => { setList(withDraft()); setDraft(''); };
  const save = () => { onSave(withDraft()); setEditing(false); };

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="lbl">Tech stack</div>
        {!editing && <button className="panel-edit" onClick={start} aria-label="Edit tech stack" title="Edit tech stack">✎</button>}
      </div>
      {editing ? (
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
            onKeyDown={(e) => { if (e.key === 'Enter') add(); else if (e.key === 'Escape') setEditing(false); }} />
          <div className="row">
            <button className="btn-cancel sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn-submit sm" onClick={save}>Save</button>
          </div>
        </div>
      ) : (
        <div className="techchips">
          {stack.length ? stack.map((s) => <span key={s} className="techchip">{s}</span>)
            : <span className="empty-soft">No stack set yet.</span>}
        </div>
      )}
    </div>
  );
}

// Standing instructions for the next session(s): edited here, injected
// verbatim at every SessionStart — steering without the terminal. Lines stay
// until removed.
function DirectivesCard({ directives, onChange }: { directives: string[]; onChange: (next: string[]) => void }) {
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
    <div className="directives">
      <div className="directives-head">
        <div className="left">
          <span className="directives-ico">⚑</span>
          <span className="directives-title">Directives</span>
          <span className="directives-sub">standing instructions — injected into every session start</span>
        </div>
        {!open && <button className="directives-add" onClick={() => setOpen(true)}>+ Add</button>}
      </div>
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
        <div className="directives-empty">
          Nothing standing. Add a line and the next session opens with it front and centre.
        </div>
      )}
    </div>
  );
}

function ActivityCard({ a }: { a: Activity }) {
  return (
    <div className="acard">
      <div className="top">
        <span className="hash">{a.hash}</span>
        <span className="branch">{a.branch}</span>
        <span className="when">{a.when}</span>
      </div>
      <div className="body">{a.summary}</div>
      <div className="tags">
        {a.tags.map((t, i) => <span key={i} className={`tag ${isAccentTag(t) ? 'accent' : ''}`}>{t}</span>)}
      </div>
    </div>
  );
}

export function Overview({
  project, activity, directives, reviewQueue, openBugCount, fixingCount, roadmapCount,
  onViewAll, onExport, onChangeDirectives, onReviewKeep, onReviewDismiss, onSaveDeploy, onSaveStack,
  keepResumeCard = true, onReplan,
}: {
  project: Project; activity: Activity[]; directives: string[]; reviewQueue: ReviewEntry[];
  openBugCount: number; fixingCount: number; roadmapCount: number;
  onViewAll: () => void; onExport: () => void; onChangeDirectives: (next: string[]) => void;
  onReviewKeep: (e: ReviewEntry) => void; onReviewDismiss: (e: ReviewEntry) => void;
  onSaveDeploy: (patch: DeployPatch) => void; onSaveStack: (next: string[]) => void;
  keepResumeCard?: boolean;
  onReplan?: () => void;
}) {
  const r = project.resume;
  const latest = activity.slice(0, 2);

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
              <div className="resume-when">updated {r.when} · after push {r.ref}</div>
              {onReplan && (
                <button className="btn-export" onClick={onReplan}
                  title="Gemini drafts a first-session-back plan from the live state">
                  ✧ Re-entry plan
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

      {/* project-scoped review queue — same semantics as the deck inbox */}
      {reviewQueue.length > 0 && (
        <div className="proj-review">
          <div className="proj-review-head">
            <span className="title">Needs review</span>
            <span className="review-count">{reviewQueue.length}</span>
            <span className="auto-badge">✦ auto-extracted</span>
          </div>
          {reviewQueue.map((e) => (
            <div className="proj-review-row" key={`${e.kind}:${e.key}`}>
              <span className={`review-kind ${e.kind}`}>{e.kind === 'bug' ? e.key : e.kind === 'roadmap' ? 'roadmap' : 'idea'}</span>
              <span className="txt">{e.title}</span>
              <span className="review-meta">{e.meta}</span>
              <span className="review-actions">
                <button className="review-keep" onClick={() => onReviewKeep(e)} title="Keep — mark reviewed">✓ Keep</button>
                <button className="review-dismiss" onClick={() => onReviewDismiss(e)} title="Dismiss — delete and don't re-extract">✕ Dismiss</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* directives — the steer list injected into every session start */}
      <DirectivesCard directives={directives} onChange={onChangeDirectives} />

      {/* stat panels */}
      <div className="stats">
        <DeploymentPanel project={project} onSave={onSaveDeploy} />
        <TechStackPanel stack={project.meta.stack} onSave={onSaveStack} />
        <div className="panel">
          <div className="lbl">Snapshot</div>
          <div className="snap">
            <div className="snap-row"><span>Open bugs</span><span><b>{openBugCount}</b> <span className="fixing">· {fixingCount} fixing</span></span></div>
            <div className="snap-row"><span>Roadmap items</span><b>{roadmapCount}</b></div>
            <div className="snap-row"><span>Pushes this week</span><b>{project.meta.pushesThisWeek}</b></div>
          </div>
        </div>
      </div>

      {/* latest summaries */}
      <div className="section-head">
        <div className="left">
          <div className="section-title">Latest summaries</div>
          <span className="auto-badge">✦ auto-generated per push</span>
        </div>
        {activity.length > 0 && <button className="viewall" onClick={onViewAll}>View all →</button>}
      </div>
      {latest.length ? (
        <div className="summary-list">{latest.map((a) => <ActivityCard key={a.hash} a={a} />)}</div>
      ) : (
        <div className="empty-state">
          <div className="big">No pushes yet</div>
          <div>Every push posts a summary here through the {PRODUCT_NAME} API.</div>
        </div>
      )}
    </div>
  );
}
