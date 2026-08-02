import { useEffect, useState, type ReactNode } from 'react';
import type {
  ClaimItem, Overview, OverviewBlocker, OverviewRun, OverviewStale, PresenceItem, ReviewItem,
} from '../types';
import { go } from '../lib/route';
import {
  getProjectDetail, patchBug, deleteBug, patchRoadmapItem, deleteRoadmapItem,
  patchFuture, deleteFuture, triageInbox, AuthError,
  type TriageAnnotation, type TriageResult,
} from '../store';
import { ExportBriefModal } from './ExportBriefModal';
import { ResumeSinceStrip } from './ResumeSinceStrip';

// The command deck's parts. They used to render as one block at the top of the
// dashboard; the dashboard is now sectioned (projects · continue · activity ·
// roadmap · audit), so each part is exported on its own and the screen places
// it in the section it belongs to. The behaviour of each is unchanged.

// "Pick up where you left off" — the signature cream card, with the full three
// resume columns the project detail has always shown. The overview payload only
// carries a slice of the project, so the export modal pulls the detail on demand.
export function ResumeHero({ resume, keepResumeCard }: {
  resume: Overview['resume']; keepResumeCard: boolean;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  if (!keepResumeCard) return null;

  const loadHeroInput = async () => {
    const d = await getProjectDetail(resume!.slug);
    return { project: d.project, currentPhase: d.currentPhase, blockers: d.blockers,
      directives: d.directives, activity: d.activity, bugs: d.bugs, roadmap: d.roadmap };
  };

  if (!resume) {
    return (
      <div className="resume empty">
        <div className="resume-head">
          <div className="left">
            <div className="resume-ico">↩</div>
            <div className="resume-title">Pick up where you left off</div>
          </div>
        </div>
        <div className="resume-summary">
          Nothing on the go yet. Start a project or fire a push, and your resume point lands here.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="resume">
        <div className="resume-head">
          <div className="left">
            <div className="resume-ico">↩</div>
            <div className="resume-title">{resume.name}</div>
            {resume.currentPhase && <span className="hero-phase">{resume.currentPhase}</span>}
          </div>
          <div className="resume-meta">
            {/* the time the card's CONTENT was written, not the last push — see
                ResumeSinceStrip for why those are different */}
            {(resume.since?.authoredWhen || resume.when) && (
              <div className="resume-when">
                {resume.since?.authoredWhen
                  ? `checkpoint ${resume.since.authoredWhen}`
                  : resume.when}
              </div>
            )}
            <button className="btn-export" onClick={() => setExportOpen(true)}
              title="Download a markdown brief for starting back into this project">
              Export session brief <span className="arr">↗</span>
            </button>
            <button className="btn-export" onClick={() => go.terminal(resume.slug, undefined, true)}
              title="Open a Claude session in this project with a debrief of where things stand">
              Jump back in <span className="arr">↗</span>
            </button>
            <button className="btn-accent" onClick={() => go.detail(resume.slug)}>
              Continue <span className="arr">→</span>
            </button>
          </div>
        </div>
        <ResumeSinceStrip since={resume.since} slug={resume.slug} />
        {resume.summary && <div className="resume-summary">{resume.summary}</div>}
        <div className="resume-cols">
          <ResumeCol kind="progress" label="Currently in progress" mark="dot"
            items={resume.inProgress} empty="Nothing mid-flight." />
          <ResumeCol kind="next" label="Suggested next" mark="arrow"
            items={resume.nextUp} empty="Open road." />
          <ResumeCol kind="keep" label="Working well — keep" mark="tick"
            items={resume.workingWell} empty="—" />
        </div>
      </div>
      {exportOpen && (
        <ExportBriefModal projectName={resume.name} loadInput={loadHeroInput}
          onClose={() => setExportOpen(false)} />
      )}
    </>
  );
}

function ResumeCol({ kind, label, mark, items, empty }: {
  kind: string; label: string; mark: 'dot' | 'arrow' | 'tick'; items: string[]; empty: string;
}) {
  return (
    <div className={`resume-col col-${kind}`}>
      <div className="lbl">{label}</div>
      <div className="itemlist">
        {items.length ? items.map((t, i) => (
          <div className="item" key={i}>
            <span className={`mk ${mark}`}>{mark === 'arrow' ? '→' : mark === 'tick' ? '✓' : ''}</span>
            <span>{t}</span>
          </div>
        )) : <div className="empty-soft">{empty}</div>}
      </div>
    </div>
  );
}

// Live now — projects with a Claude session open; renders nothing when quiet.
export function LiveNowStrip({ presence }: { presence: PresenceItem[] }) {
  if (!presence.length) return null;
  return (
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
  );
}

// Branch claims — who holds what, across everything; gone when nothing's claimed.
export function BranchClaims({ claims }: { claims: ClaimItem[] }) {
  if (!claims.length) return null;
  return (
    <div className="deck-branches">
      <span className="branches-label">⚑ Branches</span>
      {claims.map((c) => (
        <button className="branch-chip" key={`${c.slug}:${c.id}`}
          onClick={() => go.detail(c.slug, 'roadmap', c.id)}
          title={`${c.name} — open in the roadmap`}>
          <span className="branch-name">{c.branch}</span>
          <span className="branch-arrow">→</span>
          <span className="branch-title">{c.title}</span>
        </button>
      ))}
    </div>
  );
}

// Last night's autopilot — the morning digest; gone on quiet nights.
export function AutopilotDigest({ runs }: { runs: OverviewRun[] }) {
  if (!runs.length) return null;
  return (
    <div className="deck-runs">
      <div className="deck-section-head">While you were away</div>
      {runs.map((r, i) => (
        <button className="run-row" key={i}
          onClick={() => go.detail(r.slug, 'roadmap', r.itemId != null ? String(r.itemId) : undefined)}
          title={r.summary || r.itemTitle}>
          <span className={`run-outcome ${r.outcome}`}>
            {r.outcome === 'landed' ? '✓' : r.outcome === 'planned' ? '✎' : r.outcome === 'limit' ? '◐' : r.outcome === 'failed' ? '✗' : '—'}
          </span>
          <span className="run-proj">{r.name}</span>
          <span className="run-title">
            {r.itemId != null ? `#${r.itemId} ` : ''}{r.itemTitle}
            <span className="run-meta">
              {r.outcome === 'landed' ? `${r.branch} · ${r.commits} commit${r.commits === 1 ? '' : 's'}`
                : r.outcome === 'planned' ? 'design saved — review the plan'
                : r.outcome === 'limit' ? 'paused on the usage limit'
                : r.outcome === 'failed' ? 'failed — see the log'
                : 'no commits — branch released'}
            </span>
          </span>
          <span className="run-when">{r.when}</span>
        </button>
      ))}
    </div>
  );
}

// The attention row — quiet at zero, loud only where it matters.
export function AttentionRow({ blockers, stale, bugs }: {
  blockers: OverviewBlocker[]; stale: OverviewStale[]; bugs: Overview['bugs'];
}) {
  const worstBug = bugs.projects[0] || null;
  return (
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
        onCount={worstBug ? () => go.detail(worstBug.slug, 'quality') : undefined}>
        {bugs.projects.slice(0, 4).map((p, i) => (
          <button className="att-row" key={i} onClick={() => go.detail(p.slug, 'quality')}>
            <span className="att-text">{p.name}</span>
            <span className="att-proj">{p.count}</span>
          </button>
        ))}
      </AttentionCard>
    </div>
  );
}

// Build the ref string the triage server uses, matching kind:slug:id.
function triageRef(it: ReviewItem): string {
  return `${it.kind}:${it.slug}:${it.id}`;
}

// The needs-review queue: everything the hooks extracted that no human has
// looked at yet. Keep marks it reviewed (it's already in the trackers); Dismiss
// deletes it (tombstoning the fingerprint so the next push won't re-create it).
// Rows settle optimistically; the whole block disappears at zero.
// ✧ Triage (≥4 items): Gemini annotates clusters, severity flags and keep/dismiss
// suggestions in-memory — the human applies them through the same existing handlers.
export function ReviewQueue({ initial }: { initial: Overview['review'] }) {
  const [items, setItems] = useState(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Session groups (#140): one ingest's extractions arrive together, so they
  // share a batch stamp. Groups collapse vertically; the newest starts open.
  const [openGroups, setOpenGroups] = useState<Set<string> | null>(null);
  // #76 — triage state (in-memory only; cleared on reload)
  const [triaging, setTriaging] = useState(false);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [triageError, setTriageError] = useState('');
  useEffect(() => { setItems(initial.items); setTotal(initial.total); }, [initial]);

  if (total === 0) return null;
  const rowKey = (it: ReviewItem) => `${it.slug}:${it.kind}:${it.id}`;
  const groupKey = (it: ReviewItem) => `${it.slug}|${it.batch || it.when}`;

  const groups: { key: string; name: string; when: string; items: ReviewItem[] }[] = [];
  for (const it of items) {
    const key = groupKey(it);
    const g = groups.find((x) => x.key === key);
    if (g) g.items.push(it);
    else groups.push({ key, name: it.name, when: it.when, items: [it] });
  }
  const opened = openGroups ?? new Set(groups.length ? [groups[0].key] : []);
  const toggleGroup = (key: string) =>
    setOpenGroups(() => {
      const next = new Set(opened);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const keepOne = async (it: ReviewItem) => {
    if (it.kind === 'bug') await patchBug(it.slug, it.id, { reviewed: true });
    else if (it.kind === 'roadmap') await patchRoadmapItem(it.slug, Number(it.id), { reviewed: true });
    else await patchFuture(it.slug, Number(it.id), { reviewed: true });
  };

  const act = async (it: ReviewItem, action: 'keep' | 'dismiss') => {
    if (busyKey) return;
    setBusyKey(rowKey(it));
    setError('');
    try {
      if (action === 'keep') {
        await keepOne(it);
      } else if (it.kind === 'bug') {
        await deleteBug(it.slug, it.id);
      } else if (it.kind === 'roadmap') {
        await deleteRoadmapItem(it.slug, Number(it.id));
      } else {
        await deleteFuture(it.slug, Number(it.id));
      }
      setItems((prev) => prev.filter((x) => rowKey(x) !== rowKey(it)));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      if (e instanceof AuthError) return; // global handler routes to the gate
      setError((e as Error)?.message || "Couldn't update that item.");
    }
    setBusyKey(null);
  };

  // Bulk approve one session group (#140) — every item marked reviewed, rows
  // settling as each lands so a mid-list failure leaves the truth visible.
  const keepAll = async (g: { key: string; items: ReviewItem[] }) => {
    if (busyKey) return;
    setBusyKey(g.key);
    setError('');
    for (const it of g.items) {
      try {
        await keepOne(it);
        setItems((prev) => prev.filter((x) => rowKey(x) !== rowKey(it)));
        setTotal((t) => Math.max(0, t - 1));
      } catch (e) {
        if (e instanceof AuthError) return;
        setError((e as Error)?.message || "Couldn't approve the whole session.");
        break;
      }
    }
    setBusyKey(null);
  };

  // #76 — ✧ Triage: ask Gemini for clusters, severity flags and suggestions.
  const runTriage = async () => {
    if (triaging) return;
    setTriaging(true);
    setTriageError('');
    setTriageResult(null);
    try {
      const result = await triageInbox();
      setTriageResult(result);
    } catch (e) {
      if (e instanceof AuthError) return;
      setTriageError((e as Error)?.message || 'Triage call failed.');
    }
    setTriaging(false);
  };

  // Convenience: apply the suggested action for one item (the human still
  // triggers it — no auto-application without a click).
  const applySuggestion = async (it: ReviewItem, ann: TriageAnnotation) => {
    if (!ann.action || busyKey) return;
    await act(it, ann.action);
  };

  const annotations = triageResult?.annotations ?? {};

  return (
    <div className="deck-review">
      <div className="deck-section-head review-head">
        <span>Needs review</span>
        <span className="review-count">{total}</span>
        <span className="auto-badge">✦ auto-extracted</span>
        {total >= 4 && (
          <button
            className={`triage-btn${triaging ? ' busy' : ''}${triageResult ? ' done' : ''}`}
            onClick={runTriage}
            disabled={triaging || busyKey !== null}
            title="Ask Gemini to cluster near-duplicates, flag suspicious severities and suggest keep/dismiss for each item">
            {triaging ? '✦ Triaging…' : triageResult ? '✦ Triaged' : '✧ Triage'}
          </button>
        )}
      </div>

      {/* cluster summary: when Gemini found near-duplicate groups, surface them
          as a quick read so the human knows what to look for below */}
      {triageResult && triageResult.clusters.length > 0 && (
        <div className="triage-clusters">
          <span className="triage-clusters-label">Near-duplicates found</span>
          {triageResult.clusters.map((c, i) => (
            <div className="triage-cluster" key={i}>
              <span className="triage-cluster-label">{c.label}</span>
              <span className="triage-cluster-refs">{c.refs.join(' · ')}</span>
            </div>
          ))}
        </div>
      )}

      {triageError && <div className="review-error">{triageError}</div>}

      {groups.map((g) => (
        <div className="review-group" key={g.key}>
          <div className="review-group-head">
            <button className="review-group-toggle" onClick={() => toggleGroup(g.key)}
              aria-expanded={opened.has(g.key)}>
              <span className="chev">{opened.has(g.key) ? '▾' : '▸'}</span>
              <span className="review-proj">{g.name}</span>
              <span className="review-when">{g.when}</span>
              <span className="review-count sm">{g.items.length}</span>
            </button>
            <button className="review-keep" disabled={busyKey !== null}
              onClick={() => keepAll(g)} title="Approve every item this session extracted">
              ✓ Keep all
            </button>
          </div>
          {opened.has(g.key) && (
            <div className="review-rows">
              {g.items.map((it) => {
                const ref = triageRef(it);
                const ann: TriageAnnotation = annotations[ref] ?? {};
                const hasAnn = ann.action || ann.clusterLabel || ann.suggestedSeverity;
                return (
                  <div className={`review-row${busyKey === rowKey(it) || busyKey === g.key ? ' busy' : ''}${hasAnn ? ' has-triage' : ''}`} key={rowKey(it)}>
                    <span className={`review-kind ${it.kind}`}>{it.kind === 'bug' ? it.id : it.kind === 'roadmap' ? 'roadmap' : 'idea'}</span>
                    <span className="review-row-body">
                      <button className="review-title" title="Open in its tracker"
                        onClick={() => go.detail(it.slug, it.kind === 'bug' ? 'quality' : it.kind === 'roadmap' ? 'roadmap' : 'futures', it.id)}>
                        {it.title}
                      </button>
                      {/* #76 — triage annotations */}
                      {ann.clusterLabel && (
                        <span className="triage-ann cluster" title={`Near-duplicate: ${ann.clusterLabel}`}>
                          ≈ {ann.clusterLabel}
                        </span>
                      )}
                      {ann.suggestedSeverity && (
                        <span className="triage-ann severity" title={ann.severityReason || ''}>
                          severity: {ann.currentSeverity} → {ann.suggestedSeverity}
                        </span>
                      )}
                      {ann.action && (
                        <span className={`triage-ann suggest ${ann.action}`} title={ann.reason || ''}>
                          {ann.action === 'keep' ? '✓ keep' : '✕ dismiss'}{ann.reason ? ` — ${ann.reason}` : ''}
                        </span>
                      )}
                    </span>
                    <span className="review-meta">{it.meta}</span>
                    <span className="review-actions">
                      {ann.action && (
                        <button
                          className={`triage-apply ${ann.action}`}
                          onClick={() => applySuggestion(it, ann)}
                          title={`Apply suggestion: ${ann.action}`}>
                          Apply
                        </button>
                      )}
                      <button className="review-keep" onClick={() => act(it, 'keep')} title="Keep — mark reviewed">✓ Keep</button>
                      <button className="review-dismiss" onClick={() => act(it, 'dismiss')} title="Dismiss — delete and don't re-extract">✕ Dismiss</button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
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
