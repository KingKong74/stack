import { useEffect, useState, type ReactNode } from 'react';
import type { Overview, ReviewItem } from '../types';
import { go } from '../lib/route';
import {
  getProjectDetail, patchBug, deleteBug, patchRoadmapItem, deleteRoadmapItem,
  patchFuture, deleteFuture, AuthError,
} from '../store';
import { ExportBriefModal } from './ExportBriefModal';
import { buildWeeks, contribLevel } from '../lib/contrib';

// The cross-project command deck that sits at the top of the dashboard:
// a resume hero, a quiet attention row, and a merged activity stream.
// Calm when all's well; loud only where something needs attention.
export function CommandDeck({ data }: { data: Overview }) {
  const { resume, keepResumeCard, presence, claims, blockers, stale, bugs, activity } = data;
  const worstBug = bugs.projects[0] || null;
  const weeks = buildWeeks(new Map((data.graph || []).map((g) => [g.date, g.count])));
  const yearTotal = (data.graph || []).reduce((sum, g) => sum + g.count, 0);

  // The hero only carries a slice of the project, so the export modal pulls
  // the full detail on demand when the user confirms.
  const [exportOpen, setExportOpen] = useState(false);
  const loadHeroInput = async () => {
    const d = await getProjectDetail(resume!.slug);
    return { project: d.project, currentPhase: d.currentPhase, blockers: d.blockers,
      directives: d.directives, activity: d.activity, bugs: d.bugs, roadmap: d.roadmap };
  };

  return (
    <section className="deck" aria-label="Command deck">
      {/* resume hero — hidden entirely when the resume card is switched off */}
      {!keepResumeCard ? null : resume ? (
        <div className="deck-hero">
          <div className="hero-main">
            <div className="hero-eyebrow"><span className="resume-ico">↩</span> Pick up where you left off</div>
            <div className="hero-row">
              <span className="hero-name">{resume.name}</span>
              {resume.currentPhase && <span className="hero-phase">{resume.currentPhase}</span>}
            </div>
            {resume.summary && <div className="hero-summary">{resume.summary}</div>}
            {resume.nextUp.length > 0 && (
              <div className="hero-next">
                {resume.nextUp.slice(0, 2).map((t, i) => (
                  <div className="hero-step" key={i}><span className="mk arrow">→</span><span>{t}</span></div>
                ))}
              </div>
            )}
          </div>
          <div className="hero-side">
            <button className="btn-accent hero-continue" onClick={() => go.detail(resume.slug)}>
              Continue <span className="arr">→</span>
            </button>
            <button className="hero-export" onClick={() => setExportOpen(true)}
              title="Download a markdown brief for starting back into this project">
              Export brief ↓
            </button>
          </div>
        </div>
      ) : (
        <div className="deck-hero empty">
          <div className="hero-main">
            <div className="hero-eyebrow"><span className="resume-ico">↩</span> Pick up where you left off</div>
            <div className="hero-summary">
              Nothing on the go yet. Start a project or fire a push, and your resume point lands here.
            </div>
          </div>
        </div>
      )}

      {/* live now — projects with a Claude session open; gone when quiet */}
      {presence.length > 0 && (
        <div className="deck-live">
          <span className="live-pulse" aria-hidden="true" />
          <span className="live-label">Live now</span>
          {presence.map((p) => (
            <button className="live-chip" key={p.slug} onClick={() => go.detail(p.slug)}
              title={`Last ping ${p.seen}`}>
              <span className="live-name">{p.name}</span>
              <span className="live-branch">{p.branches.join(' · ')}</span>
              {p.count > 1 && <span className="live-count">×{p.count}</span>}
            </button>
          ))}
        </div>
      )}

      {/* lane claims — who holds what, across everything; gone when nothing's claimed */}
      {claims.length > 0 && (
        <div className="deck-lanes">
          <span className="lanes-label">⚑ Lanes</span>
          {claims.map((c) => (
            <button className="lane-chip" key={`${c.slug}:${c.id}`}
              onClick={() => go.detail(c.slug, 'roadmap', c.id)}
              title={`${c.name} — open in the roadmap`}>
              <span className="lane-name">{c.lane}</span>
              <span className="lane-arrow">→</span>
              <span className="lane-title">{c.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* last night's autopilot — the morning digest; gone on quiet nights */}
      {(data.autopilotRuns || []).length > 0 && (
        <div className="deck-runs">
          <div className="deck-section-head">While you were away</div>
          {(data.autopilotRuns || []).map((r, i) => (
            <button className="run-row" key={i}
              onClick={() => go.detail(r.slug, 'roadmap', r.itemId != null ? String(r.itemId) : undefined)}
              title={r.summary || r.itemTitle}>
              <span className={`run-outcome ${r.outcome}`}>
                {r.outcome === 'landed' ? '✓' : r.outcome === 'limit' ? '◐' : r.outcome === 'failed' ? '✗' : '—'}
              </span>
              <span className="run-proj">{r.name}</span>
              <span className="run-title">
                {r.itemId != null ? `#${r.itemId} ` : ''}{r.itemTitle}
                <span className="run-meta">
                  {r.outcome === 'landed' ? `${r.branch} · ${r.commits} commit${r.commits === 1 ? '' : 's'}`
                    : r.outcome === 'limit' ? 'paused on the usage limit'
                    : r.outcome === 'failed' ? 'failed — see the log'
                    : 'no commits — lane released'}
                </span>
              </span>
              <span className="run-when">{r.when}</span>
            </button>
          ))}
        </div>
      )}

      {/* review inbox — auto-extracted items awaiting a look; gone at zero */}
      <ReviewQueue initial={data.review} />

      {/* attention row — quiet at zero, loud only where it matters */}
      <div className="deck-attention">
        <AttentionCard kind="blocked" title="Blocked" count={blockers.length} clearText="Nothing blocked">
          {blockers.slice(0, 4).map((b, i) => (
            <button className="att-row" key={i} onClick={() => go.detail(b.slug)}>
              <span className="att-text">{b.text}</span>
              <span className="att-proj">{b.name}</span>
            </button>
          ))}
          {blockers.length > 4 && <div className="att-more">+{blockers.length - 4} more</div>}
        </AttentionCard>

        <AttentionCard kind="stale" title="Stale" count={stale.length} clearText="All current">
          {stale.slice(0, 4).map((s, i) => (
            <button className="att-row" key={i} onClick={() => go.detail(s.slug)}>
              <span className="att-text">{s.name}</span>
              <span className="att-proj mono">{s.since}</span>
            </button>
          ))}
          {stale.length > 4 && <div className="att-more">+{stale.length - 4} more</div>}
        </AttentionCard>

        <AttentionCard kind="bugs" title="Critical & high bugs" count={bugs.total} clearText="No serious bugs"
          onCount={worstBug ? () => go.detail(worstBug.slug, 'bugs') : undefined}>
          {bugs.projects.slice(0, 4).map((p, i) => (
            <button className="att-row" key={i} onClick={() => go.detail(p.slug, 'bugs')}>
              <span className="att-text">{p.name}</span>
              <span className="att-proj">{p.count}</span>
            </button>
          ))}
        </AttentionCard>
      </div>

      {/* merged activity stream */}
      <div className="deck-activity">
        <div className="deck-section-head">
          Across everything
          <button className="deck-timeline-link" onClick={go.timeline}>Full timeline →</button>
        </div>
        {yearTotal > 0 && (
          // The year in pushes, GitHub-history style but ours — click for the timeline.
          <button className="ctb compact" onClick={go.timeline}
            title={`${yearTotal} pushes in the last 12 months — open the timeline`}
            aria-label={`${yearTotal} pushes in the last 12 months — open the timeline`}>
            <span className="ctb-grid">
              {weeks.map((week, wi) => (
                <span className="ctb-col" key={wi}>
                  {week.map((day) => (
                    <span key={day.date}
                      className={`ctb-cell ${day.future ? 'future' : `l${contribLevel(day.count)}`}`} />
                  ))}
                </span>
              ))}
            </span>
          </button>
        )}
        {activity.length ? (
          <div className="deck-feed">
            {activity.map((a, i) => (
              <button className="feed-row" key={i} disabled={!a.slug}
                onClick={() => a.slug && go.detail(a.slug, 'activity')}>
                <span className="feed-hash">{a.hash}</span>
                <span className="feed-proj">{a.name}</span>
                <span className="feed-summary">{a.summary || '—'}</span>
                <span className="feed-when">{a.when}</span>
                {a.geminiNote && <span className="feed-gem">✦ {a.geminiNote}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="deck-empty">No pushes yet across any project.</div>
        )}
      </div>

      {exportOpen && resume && (
        <ExportBriefModal projectName={resume.name} loadInput={loadHeroInput}
          onClose={() => setExportOpen(false)} />
      )}
    </section>
  );
}

// The needs-review queue: everything the hooks extracted that no human has
// looked at yet. Keep marks it reviewed (it's already in the trackers); Dismiss
// deletes it (tombstoning the fingerprint so the next push won't re-create it).
// Rows settle optimistically; the whole block disappears at zero.
function ReviewQueue({ initial }: { initial: Overview['review'] }) {
  const [items, setItems] = useState(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setItems(initial.items); setTotal(initial.total); }, [initial]);

  if (total === 0) return null;
  const rowKey = (it: ReviewItem) => `${it.slug}:${it.kind}:${it.id}`;

  const act = async (it: ReviewItem, action: 'keep' | 'dismiss') => {
    if (busyKey) return;
    setBusyKey(rowKey(it));
    setError('');
    try {
      if (it.kind === 'bug') {
        if (action === 'keep') await patchBug(it.slug, it.id, { reviewed: true });
        else await deleteBug(it.slug, it.id);
      } else if (it.kind === 'roadmap') {
        if (action === 'keep') await patchRoadmapItem(it.slug, Number(it.id), { reviewed: true });
        else await deleteRoadmapItem(it.slug, Number(it.id));
      } else {
        if (action === 'keep') await patchFuture(it.slug, Number(it.id), { reviewed: true });
        else await deleteFuture(it.slug, Number(it.id));
      }
      setItems((prev) => prev.filter((x) => rowKey(x) !== rowKey(it)));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      if (e instanceof AuthError) return; // global handler routes to the gate
      setError((e as Error)?.message || "Couldn't update that item.");
    }
    setBusyKey(null);
  };

  return (
    <div className="deck-review">
      <div className="deck-section-head review-head">
        <span>Needs review</span>
        <span className="review-count">{total}</span>
        <span className="auto-badge">✦ auto-extracted</span>
      </div>
      <div className="review-rows">
        {items.map((it) => (
          <div className={`review-row ${busyKey === rowKey(it) ? 'busy' : ''}`} key={rowKey(it)}>
            <span className={`review-kind ${it.kind}`}>{it.kind === 'bug' ? it.id : it.kind === 'roadmap' ? 'roadmap' : 'idea'}</span>
            <button className="review-title" title="Open in its tracker"
              onClick={() => go.detail(it.slug, it.kind === 'bug' ? 'bugs' : it.kind === 'roadmap' ? 'roadmap' : 'futures', it.id)}>
              {it.title}
            </button>
            <span className="review-meta">{it.meta}</span>
            <span className="review-proj">{it.name}</span>
            <span className="review-when">{it.when}</span>
            <span className="review-actions">
              <button className="review-keep" onClick={() => act(it, 'keep')} title="Keep — mark reviewed">✓ Keep</button>
              <button className="review-dismiss" onClick={() => act(it, 'dismiss')} title="Dismiss — delete and don't re-extract">✕ Dismiss</button>
            </span>
          </div>
        ))}
      </div>
      {total > items.length && <div className="review-more">+{total - items.length} more after these</div>}
      {error && <div className="review-error">{error}</div>}
    </div>
  );
}

function AttentionCard({
  kind, title, count, clearText, onCount, children,
}: {
  kind: string; title: string; count: number; clearText: string;
  onCount?: () => void; children?: ReactNode;
}) {
  const calm = count === 0;
  return (
    <div className={`att-card ${kind} ${calm ? 'calm' : 'flag'}`}>
      <div className="att-head">
        <span className="att-title">{title}</span>
        {calm ? (
          <span className="att-count">✓</span>
        ) : onCount ? (
          <button className="att-count link" onClick={onCount}>{count}</button>
        ) : (
          <span className="att-count">{count}</span>
        )}
      </div>
      {calm ? <div className="att-clear">{clearText}</div> : <div className="att-body">{children}</div>}
    </div>
  );
}
