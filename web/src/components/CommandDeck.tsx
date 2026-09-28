import { useState } from 'react';
import type { Overview, Project } from '../types';
import { go, hrefTo } from '../lib/route';
import { getProjectDetail } from '../store';
import { ExportBriefModal } from './ExportBriefModal';
import { KitIcon } from '../detail/kit/KitIcon';

// "Where you left off" — the Projects page's resume card. DENSE ON PURPOSE:
// one head row (what, where, when, and the three ways back in), then a row of
// numbers that say how the project stands right now, then at most three
// one-line "in progress" items. The checkpoint's paragraph, "suggested next"
// and "working well" are gone from here; they still live on the project's own
// Overview and in the Brief.
//
// Every number is read off the one /api/overview payload the page already
// loads, so a tile never disagrees with the screen it links to. A tile with
// nothing to say (no live session, no bugs) drops out rather than reading 0.

const IN_PROGRESS_MAX = 3;

export function ResumeHero({ overview, project }: {
  overview: Overview;
  /** The resumed project's list row, for its progress. Absent while loading. */
  project?: Project;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const resume = overview.resume;
  if (!overview.keepResumeCard) return null;

  if (!resume) {
    return (
      <section className="rh rh-empty">
        <span className="rh-eyebrow">Where you left off</span>
        <span className="rh-dim">Nothing yet. Land a push or run /checkpoint and it shows up here.</span>
      </section>
    );
  }

  const slug = resume.slug;
  const loadHeroInput = async () => {
    const d = await getProjectDetail(slug);
    return { project: d.project, currentPhase: d.currentPhase, blockers: d.blockers,
      directives: d.directives, activity: d.activity, bugs: d.bugs, roadmap: d.roadmap };
  };

  const since = resume.since;
  const bugs = overview.bugs.byProject.find((b) => b.slug === slug);
  const review = overview.review.items.filter((r) => r.slug === slug).length;
  const live = overview.presence.find((p) => p.slug === slug);
  const blocker = overview.blockers.find((b) => b.slug === slug);
  const runs = overview.autopilotRuns.filter((r) => r.slug === slug);
  const landed = runs.filter((r) => r.outcome === 'landed').length;

  const tiles: { k: string; v: string; sub?: string; tone?: 'bad' | 'warn' | 'good'; href?: string }[] = [];
  if (project) tiles.push({ k: 'Progress', v: `${project.progress}%`, href: hrefTo.detail(slug) });
  tiles.push({ k: 'In progress', v: String(resume.inProgress.length), href: hrefTo.detail(slug, 'roadmap') });
  if (bugs?.open) tiles.push({
    k: 'Open bugs', v: String(bugs.open), sub: bugs.serious ? `${bugs.serious} serious` : undefined,
    tone: bugs.serious ? 'bad' : undefined, href: hrefTo.detail(slug, 'quality'),
  });
  if (review) tiles.push({ k: 'To review', v: String(review), tone: 'warn', href: hrefTo.detail(slug, 'auto') });
  if (live) tiles.push({ k: 'Live now', v: String(live.count), sub: live.branches.join(', '), tone: 'good' });
  if (runs.length) tiles.push({ k: 'Last night', v: `${landed}/${runs.length}`, sub: 'landed', tone: landed ? 'good' : undefined });
  if (since?.authoredWhen && since.count) tiles.push({ k: 'Since checkpoint', v: String(since.count), sub: `push${since.count === 1 ? '' : 'es'} · ${since.authoredWhen}`, tone: 'warn' });

  return (
    <>
      <section className="rh">
        <div className="rh-head">
          <div className="rh-titles">
            <span className="rh-eyebrow">Where you left off</span>
            <div className="rh-name">
              <span className="dot" style={{ background: resume.tint || undefined }} />
              <a href={hrefTo.detail(slug)}>{resume.name}</a>
              {resume.currentPhase && <span className="rh-phase">{resume.currentPhase}</span>}
            </div>
            {since?.hash ? (
              <a className="rh-meta" href={hrefTo.detail(slug, 'activity', since.hash)} title="Open the latest push">
                <KitIcon name="git-branch" size={12} />{since.branch} · {since.hash} · {since.when}
              </a>
            ) : resume.when ? <span className="rh-meta">last session {resume.when}</span> : null}
          </div>
          <div className="rh-actions">
            <button className="k-btn ghost sm" onClick={() => setExportOpen(true)}
              title="Download a markdown brief for starting back into this project">
              <KitIcon name="file-text" size={14} />Brief
            </button>
            <button className="k-btn secondary sm" onClick={() => go.terminal(slug, undefined, true)}
              title="Open a Claude session in this project with a debrief of where things stand">
              <KitIcon name="terminal" size={14} />Jump back in
            </button>
            <button className="k-btn accent sm" onClick={() => go.detail(slug)}>
              <KitIcon name="code" size={14} />Continue
            </button>
          </div>
        </div>

        <div className="rh-tiles">
          {tiles.map((t) => {
            const body = (
              <>
                <span className="k">{t.k}</span>
                <span className="v">{t.v}{t.sub && <span className="sub">{t.sub}</span>}</span>
                {t.k === 'Progress' && project && (
                  <span className="bar"><span style={{ width: `${project.progress}%` }} /></span>
                )}
              </>
            );
            const cls = `rh-tile${t.tone ? ` ${t.tone}` : ''}`;
            return t.href
              ? <a key={t.k} className={cls} href={t.href}>{body}</a>
              : <div key={t.k} className={cls}>{body}</div>;
          })}
        </div>

        {blocker && <div className="rh-blocker"><span className="k">Blocked</span>{blocker.text}</div>}

        {resume.inProgress.length > 0 && (
          <ul className="rh-list">
            {resume.inProgress.slice(0, IN_PROGRESS_MAX).map((t, i) => <li key={i} title={t}><span>{t}</span></li>)}
            {resume.inProgress.length > IN_PROGRESS_MAX && (
              <li className="more"><a href={hrefTo.detail(slug)}>+{resume.inProgress.length - IN_PROGRESS_MAX} more</a></li>
            )}
          </ul>
        )}
      </section>
      {exportOpen && (
        <ExportBriefModal projectName={resume.name} loadInput={loadHeroInput}
          onClose={() => setExportOpen(false)} />
      )}
    </>
  );
}
