import { useEffect, useMemo, useState } from 'react';
import type {
  Overview, OverviewRoadmapBucket, Priority, Project,
} from '../types';
import { go } from '../lib/route';
import { getTimeline, type TimelineData, type TimelineEntry } from '../store';
import { buildWeeks, contribLevel } from '../lib/contrib';
import { AutopilotDigest, LiveNowStrip } from './CommandDeck';

// The sectioned dashboard's own pieces: the sticky section nav, the day-grouped
// push feed with its sidebar, the cross-project roadmap rollup and the audit
// lists. Everything here reads what the API actually stores — where the design
// asked for a number Stack doesn't keep (per-commit diffstats, a health score),
// the panel says what it does know rather than inventing the rest.

const SECTIONS = [
  { id: 'projects', label: 'Projects' },
  { id: 'continue', label: 'Continue' },
  { id: 'activity', label: 'Activity' },
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'audit', label: 'Audit' },
];

// The sticky section rail under the topbar: jump links on the left, the state
// of the whole workshop on the right. Each counter goes quiet at zero rather
// than sitting there as a permanent 0.
export function SubNav({ totals, bugs }: { totals: Overview['totals']; bugs: number }) {
  const [active, setActive] = useState('projects');
  // The topbar is sticky at top:0 too, so this rail has to stack directly
  // under it. Its height is not a constant — the topbar's buttons wrap on a
  // narrow window and it grows — so measure it rather than hardcode 71px.
  const [topbarH, setTopbarH] = useState(71);

  useEffect(() => {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const measure = () => setTopbarH(Math.round(bar.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // Scroll spy: the last section whose top has passed under the sticky rail.
  useEffect(() => {
    const onScroll = () => {
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= topbarH + 70) current = s.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [topbarH]);

  return (
    <div className="subnav" style={{ top: topbarH }}>
      <div className="subnav-inner">
        <nav className="subnav-links">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={active === s.id ? 'on' : ''}
              onClick={(e) => {
                // Plain anchors would rewrite the hash route out from under the
                // app (#/ is the dashboard), so scroll by hand instead.
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}>
              {s.label}
            </a>
          ))}
        </nav>
        <div className="subnav-stats">
          {totals.byStatus.live > 0 && <span><span className="d live">●</span> {totals.byStatus.live} live</span>}
          {totals.byStatus.building > 0 && <span><span className="d building">●</span> {totals.byStatus.building} building</span>}
          {bugs > 0 && <span><span className="d critical">●</span> {bugs} serious</span>}
          <span>{totals.pushesToday} push{totals.pushesToday === 1 ? '' : 'es'} today</span>
        </div>
      </div>
    </div>
  );
}

// ---------- activity: the day-grouped push feed ----------

// One push group: the sessions one project landed on one branch, in one day.
interface PushGroup { slug: string; name: string; tint: string | null; branch: string; entries: TimelineEntry[] }

function groupPushes(entries: TimelineEntry[]): PushGroup[] {
  const out: PushGroup[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    // Consecutive runs only, so a day that alternates between projects reads
    // in the order it happened rather than being re-sorted into buckets.
    if (last && last.slug === e.slug && last.branch === e.branch) last.entries.push(e);
    else out.push({ slug: e.slug, name: e.name, tint: e.tint, branch: e.branch, entries: [e] });
  }
  return out;
}

export function PushesSection({ overview, projects }: { overview: Overview; projects: Project[] }) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState('all');

  // Its own fetch, like the deck's: a timeline hiccup must not blank the page.
  useEffect(() => {
    let live = true;
    getTimeline()
      .then((d) => { if (live) { setData(d); setError(''); } })
      .catch((e) => { if (live) setError((e as Error)?.message || 'Failed to load pushes.'); });
    return () => { live = false; };
  }, []);

  const days = useMemo(() => {
    const all = data?.days || [];
    if (scope === 'all') return all;
    return all
      .map((d) => ({ ...d, entries: d.entries.filter((e) => e.slug === scope) }))
      .filter((d) => d.entries.length);
  }, [data, scope]);

  const scopes = [{ key: 'all', label: 'All apps' }, ...projects.map((p) => ({ key: p.id, label: p.name }))];
  const shown = days.reduce((n, d) => n + d.entries.length, 0);

  return (
    <section id="activity" className="dash-section">
      <div className="section-bar">
        <div className="titles">
          <div className="h">Pushes</div>
          <div className="subtitle">
            {overview.totals.pushesThisWeek} push{overview.totals.pushesThisWeek === 1 ? '' : 'es'} this week
            {' '}across {overview.totals.projectsTouchedThisWeek} app{overview.totals.projectsTouchedThisWeek === 1 ? '' : 's'}
          </div>
        </div>
        <div className="bar-actions">
          <div className="seg-control sm" role="tablist">
            {scopes.map((s) => (
              <button key={s.key} role="tab" aria-selected={scope === s.key}
                className={`seg-opt ${scope === s.key ? 'on' : ''}`} onClick={() => setScope(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="push-layout">
        <div className="push-main">
          <AutopilotDigest runs={overview.autopilotRuns} />
          {error ? (
            <div className="empty-state"><div className="big">Couldn't load pushes</div><div>{error}</div></div>
          ) : !data ? (
            <div className="empty-soft">Loading pushes…</div>
          ) : !days.length ? (
            <div className="empty-state">
              <div className="big">No pushes in the last 30 days</div>
              <div>Land a checkpoint and it appears here, grouped by the day it happened.</div>
            </div>
          ) : (
            <>
              {days.map((day) => (
                <div className="push-day" key={day.date}>
                  <div className="push-rail"><span className="push-dot" /><span className="push-line" /></div>
                  <div className="push-body">
                    <div className="push-day-head">
                      <span className="push-day-label">{day.label}</span>
                      <span className="push-day-meta">
                        {day.entries.length} push{day.entries.length === 1 ? '' : 'es'}
                      </span>
                    </div>
                    <div className="push-card">
                      {groupPushes(day.entries).map((g, gi) => (
                        <div className="push-group" key={gi}>
                          <div className="push-group-head">
                            <span className="push-initial" style={{ background: g.tint || 'var(--muted)' }}>
                              {g.name.slice(0, 1).toLowerCase()}
                            </span>
                            <span className="push-proj">{g.name}</span>
                            <span className="push-verb">
                              pushed {g.entries.length} time{g.entries.length === 1 ? '' : 's'} to
                            </span>
                            <span className="push-branch">{g.branch}</span>
                            <span className="push-when">{g.entries[0].time}</span>
                          </div>
                          {g.entries.map((e, ei) => (
                            <button className="push-row" key={ei}
                              onClick={() => go.detail(e.slug, 'activity', e.hash)}
                              title={e.summary || 'No summary on this push'}>
                              <span className={`push-mark${e.authored ? ' authored' : ''}`}
                                aria-hidden="true" />
                              <span className="push-msg">
                                {e.summary || 'No summary — metadata backstop'}
                                {e.geminiNote && <span className="push-gem">✦ {e.geminiNote}</span>}
                              </span>
                              {e.tags.slice(0, 1).map((t) => <span className="tag" key={t}>{t}</span>)}
                              <span className="push-hash">{e.hash}</span>
                              <span className="push-time">{e.time}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
              <button className="btn-repo btn-muted push-more" onClick={go.timeline}>
                Open the full timeline →
              </button>
            </>
          )}
          {data && shown > 0 && (
            <div className="push-note">
              A push is one checkpoint, not one commit — Stack records the session, so there are no
              per-commit line counts to show here.
            </div>
          )}
        </div>

        <div className="push-side">
          <HeatmapPanel graph={overview.graph} />
          <LiveNowStrip presence={overview.presence} />
          <div className="panel">
            <div className="lbl">This week</div>
            <div className="snap">
              <div className="snap-row"><span>Pushes</span><b>{overview.totals.pushesThisWeek}</b></div>
              <div className="snap-row"><span>Projects touched</span><b>{overview.totals.projectsTouchedThisWeek}</b></div>
              <div className="snap-row"><span>Roadmap items closed</span><b>{overview.totals.roadmapClosedThisWeek}</b></div>
              <div className="snap-row"><span>Bugs fixed</span><b className="fixing">{overview.totals.bugsFixedThisWeek}</b></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- activity sidebar: the push heatmap ----------

const HEAT_WEEKS = 26;

function HeatmapPanel({ graph }: { graph: Overview['graph'] }) {
  const counts = new Map(graph.map((g) => [g.date, g.count]));
  const weeks = buildWeeks(counts).slice(-HEAT_WEEKS);
  const total = weeks.flat().reduce((n, d) => n + d.count, 0);
  if (!graph.length) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="lbl">Push history</div>
        <div className="heat-total">{total} in {HEAT_WEEKS} weeks</div>
      </div>
      <button className="heat-grid" onClick={go.timeline}
        title={`${total} pushes in the last ${HEAT_WEEKS} weeks — open the timeline`}
        aria-label={`${total} pushes in the last ${HEAT_WEEKS} weeks — open the timeline`}>
        {weeks.map((week, wi) => (
          <span className="ctb-col" key={wi}>
            {week.map((day) => (
              <span key={day.date} title={`${day.count} on ${day.date}`}
                className={`ctb-cell ${day.future ? 'future' : `l${contribLevel(day.count)}`}`} />
            ))}
          </span>
        ))}
      </button>
      <div className="ctb-legend">
        <span>Less</span>
        {[0, 1, 2, 3].map((l) => <span className={`ctb-cell l${l}`} key={l} />)}
        <span>More</span>
      </div>
    </div>
  );
}

// ---------- roadmap: the cross-project MoSCoW rollup ----------

const BUCKET_LABEL: Record<Priority, string> = {
  must: 'Must', should: 'Should', could: 'Could', wont: "Won't (now)",
};
const BUCKET_DOT: Record<Priority, string> = {
  must: 'var(--accent)', should: 'var(--building)', could: 'var(--sage)', wont: 'var(--paused)',
};

// Read-only on purpose: a tick here would close an item in another project
// without its plan, claim or built_note in view, so the card opens the board
// instead of changing it.
export function RoadmapRollup({ roadmap }: { roadmap: Overview['roadmap'] }) {
  const open = roadmap.buckets.reduce((n, b) => n + b.open, 0);
  return (
    <section id="roadmap" className="dash-section">
      <div className="section-bar">
        <div className="titles">
          <div className="h">Roadmap across apps</div>
          <div className="subtitle">
            MoSCoW rollup · {open} open · {roadmap.closedThisWeek} closed this week
          </div>
        </div>
      </div>
      {open === 0 && !roadmap.buckets.some((b) => b.items.length) ? (
        <div className="empty-state">
          <div className="big">Nothing on any board</div>
          <div>Roadmap items land here from every project, bucketed the same way.</div>
        </div>
      ) : (
        <div className="road-grid">
          {roadmap.buckets.map((b) => <RollupColumn key={b.bucket} col={b} />)}
        </div>
      )}
    </section>
  );
}

function RollupColumn({ col }: { col: OverviewRoadmapBucket }) {
  return (
    <div className="road-col">
      <div className="road-col-head">
        <span className="dot" style={{ background: BUCKET_DOT[col.bucket] }} />
        <span className="name">{BUCKET_LABEL[col.bucket]}</span>
        <span className="count">{col.open}</span>
      </div>
      <div className="road-items">
        {col.items.length ? col.items.map((it) => (
          <button className={`road-item rollup ${it.done ? 'done' : ''}`} key={`${it.slug}:${it.id}`}
            onClick={() => go.detail(it.slug, 'roadmap', it.id)}
            title={`${it.name} — open on the board`}>
            <span className={`road-check ${it.done ? 'on' : ''}`} aria-hidden="true">✓</span>
            <span className="road-body">
              <span className="t">
                {it.title}
                {it.auto && <span className="auto-cue">auto</span>}
              </span>
              {/* Deliberately just the reference, never the note: this is a
                  glance across every board, and one long note turns the column
                  into a wall. The full note is one click away on the board. */}
              <span className="rollup-note">
                {it.name} · #{it.id}
                {it.claimedBy && <span className="rollup-claim">⚑ {it.claimedBy}</span>}
              </span>
            </span>
          </button>
        )) : <div className="empty-soft">Nothing here.</div>}
      </div>
    </div>
  );
}

// ---------- audit: the cross-project bug list + per-app standing ----------

export function AuditLists({ overview, projects }: { overview: Overview; projects: Project[] }) {
  const bugsBySlug = new Map(overview.bugs.byProject.map((b) => [b.slug, b]));
  // Every project that's still in play, worst standing first: serious bugs
  // outrank a low progress bar, which outranks a healthy one.
  const rows = projects
    .filter((p) => p.status !== 'archived')
    .map((p) => ({ p, bugs: bugsBySlug.get(p.id) || { serious: 0, open: 0 } }))
    .sort((a, b) => b.bugs.serious - a.bugs.serious || a.p.progress - b.p.progress);

  return (
    <div className="audit-layout">
      <div className="buglist">
        {overview.bugs.open.length ? overview.bugs.open.map((b) => (
          <button className="bug" key={`${b.slug}:${b.key}`}
            onClick={() => go.detail(b.slug, 'quality', b.key)}>
            <span className={`sev-bar ${b.severity}`} />
            <span className="bug-body">
              <span className="bug-main">
                <span className="bug-title">{b.title}</span>
                <span className="bug-meta">
                  <span className="mono">{b.name} · {b.key}</span>
                  <span className="mono">{b.when}</span>
                  {b.linkRef && <span className="link-chip">{b.linkRef}</span>}
                </span>
              </span>
              <span className={`sev-pill ${b.severity}`}>{b.severity}</span>
              <span className={`status-pill ${b.status}`}>{b.status}</span>
            </span>
          </button>
        )) : (
          <div className="empty-state">
            <div className="big">No open bugs anywhere</div>
            <div>Every tracker is clear. Bugs filed by hand or extracted from a push land here.</div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="lbl">Progress by app</div>
        <div className="health-list">
          {rows.map(({ p, bugs }) => (
            <button className="health-row" key={p.id} onClick={() => go.detail(p.id)}>
              <span className="health-head">
                <span className="health-name">{p.name}</span>
                <span className="health-score">{p.progress}%</span>
              </span>
              <span className="health-track">
                <span className="health-fill"
                  style={{ width: `${p.progress}%`, background: bugs.serious > 0 ? 'var(--critical)' : p.status === 'building' ? 'var(--building)' : 'var(--live)' }} />
              </span>
              <span className="health-meta">
                <span>{bugs.serious > 0 ? `${bugs.serious} serious · ` : ''}{bugs.open} open bug{bugs.open === 1 ? '' : 's'}</span>
                <span>{p.metaLine}</span>
              </span>
            </button>
          ))}
          {!rows.length && <div className="empty-soft">No live projects.</div>}
        </div>
        <div className="health-note">
          The bar is Stack's computed progress — done Must/Should work, capped at 90% while a
          serious bug is open. It is not a separate health score.
        </div>
      </div>
    </div>
  );
}
