import { useState } from 'react';
import type { Project, Activity } from '../types';
import { isAccentTag, PRODUCT_NAME } from '../lib/ui';

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
  project, activity, directives, openBugCount, fixingCount, roadmapCount,
  onViewAll, onExport, onChangeDirectives, keepResumeCard = true,
}: {
  project: Project; activity: Activity[]; directives: string[];
  openBugCount: number; fixingCount: number; roadmapCount: number;
  onViewAll: () => void; onExport: () => void; onChangeDirectives: (next: string[]) => void;
  keepResumeCard?: boolean;
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

      {/* directives — the steer list injected into every session start */}
      <DirectivesCard directives={directives} onChange={onChangeDirectives} />

      {/* stat panels */}
      <div className="stats">
        <div className="panel">
          <div className="lbl">Deployment</div>
          <div className="deploy-row">
            <span className="dot" /><b>{project.status === 'live' ? 'Live' : project.status === 'building' ? 'Building' : 'Paused'}</b>
            <span className="mono">· main · {project.meta.version}</span>
          </div>
          <div className="deploy-meta">Last deploy {project.meta.lastDeploy} · Vercel</div>
          {project.siteUrl && <div className="deploy-link">View logs ↗</div>}
        </div>
        <div className="panel">
          <div className="lbl">Tech stack</div>
          <div className="techchips">
            {project.meta.stack.length ? project.meta.stack.map((s) => <span key={s} className="techchip">{s}</span>)
              : <span className="empty-soft">No stack set yet.</span>}
          </div>
        </div>
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
