import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  Overview, OverviewRoadmapBucket, Priority, Project,
} from '../types';
import { go, hrefTo } from '../lib/route';
import { getLastViewedProject, getTimeline, type TimelineData, type TimelineEntry } from '../store';
import { buildWeeks, contribLevel } from '../lib/contrib';
import { roadmapTarget } from '../lib/roadmapLink';
import { PRIORITY_META } from '../lib/ui';
import { AutopilotDigest, LiveNowStrip } from './CommandDeck';
import { NavIcons } from '../detail/ConsoleNav';
import { KitIcon } from '../detail/kit/KitIcon';

// The sectioned dashboard's own pieces: the sticky section nav, the day-grouped
// push feed with its sidebar, the cross-project roadmap rollup and the audit
// lists. Everything here reads what the API actually stores — where the design
// asked for a number Stack doesn't keep (per-commit diffstats, a health score),
// the panel says what it does know rather than inventing the rest.

const SECTIONS = [
  { id: 'projects', label: 'Projects' },
  { id: 'continue', label: 'Continue' },
  { id: 'activity', label: 'Activity' },
  { id: 'roadmap', label: 'Priorities' },
  { id: 'audit', label: 'Audit' },
  { id: 'inside', label: 'Inside' },
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

// ---------- roadmap: the cross-project priority rollup ----------

// #469 — the labels and dots come off PRIORITY_META, which is the one client
// definition of a priority. The dot was a hand-rolled second palette here.
const BUCKET_LABEL = Object.fromEntries(
  PRIORITY_META.map((p) => [p.key, p.label])) as Record<Priority, string>;
const BUCKET_DOT = Object.fromEntries(
  PRIORITY_META.map((p) => [p.key, p.color])) as Record<Priority, string>;

// Read-only on purpose: a tick here would close an item in another project
// without its plan, claim or built_note in view, so the card opens the board
// instead of changing it.
export function RoadmapRollup({ roadmap, projects, fallback }: {
  roadmap: Overview['roadmap']; projects: Project[]; fallback?: string;
}) {
  const open = roadmap.buckets.reduce((n, b) => n + b.open, 0);
  // #297 — the Dashboard is the whole-house view: no app is "selected" here,
  // so the link falls through to the last-viewed project and, failing that,
  // the overview's own resume slug.
  const lastViewed = useMemo(getLastViewedProject, []);
  const target = roadmapTarget({ lastViewed, fallback, known: projects.map((p) => p.id) });
  const href = target ? hrefTo.detail(target, 'roadmap') : null;
  const hrefProject = target ? projects.find((p) => p.id === target) : null;
  return (
    <section id="roadmap" className="dash-section">
      <div className="section-bar">
        <div className="titles">
          {/* NOT "Roadmap across apps" any more (#472): Roadmap is the IDEA
              tab now and this rollup draws the BOARDS — committed work, in the
              five buckets #469 gave `bucket`. The `roadmap` id and tab key are
              unchanged, so every anchor and deep link still resolves. */}
          <div className="h">Priorities across apps</div>
          <div className="subtitle">
            Every board's committed work · {open} open · {roadmap.closedThisWeek} closed this week
          </div>
        </div>
        {href && (
          <div className="bar-actions">
            <a className="viewall" href={href}
              title={hrefProject ? `Open the board for ${hrefProject.name}` : 'Open the board'}>
              Open the board →
            </a>
          </div>
        )}
      </div>
      {open === 0 && !roadmap.buckets.some((b) => b.items.length) ? (
        <div className="empty-state">
          <div className="big">Nothing on any board</div>
          <div>
            Committed work lands here from every project, in the same five buckets. Ideas nobody has
            signed off sit on each project's Roadmap tab instead.
          </div>
        </div>
      ) : (
        <>
          <div className="road-grid">
            {roadmap.buckets.map((b) => <RollupColumn key={b.bucket} col={b} />)}
          </div>
          {/* #477 — the server already sorts the active sprint's rows to the
              top of each column, so this says what the order MEANS rather
              than leaving it as an unexplained shuffle. */}
          <div className="push-note">
            Within a bucket, whatever sits in the sprint in progress comes first, in its sprint
            order — that box is the run queue, and it is the only thing the overnight runner reads.
          </div>
        </>
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
          The bar is Stack's computed progress — done Highest/High work, capped at 90% while a
          critical or high bug is open, and 0% for a project with no Highest/High items at all.
          It is not a separate health score.
        </div>
      </div>
    </div>
  );
}

// ---------- inside: what a project's rail actually holds ----------

// THE MAP OF THE APP, on the screen you land on. The dashboard is the whole
// house and every other surface is one click into a project, so the one thing
// it could never say was what those clicks OPEN — six rail rows, four of them
// renamed or rebuilt in the last dozen changes, and nothing between the project
// grid and the rail to say which is which.
//
// IT IS DESCRIPTIVE AND INERT, and both halves are deliberate. Inert because
// these rows are not a second navigation: the project you want decides which
// board you open, so a row here would have to guess one, and a control that
// guesses is worse than a sentence that explains. Descriptive because the
// honest chip is the point —
//
// A MOCK CHIP HERE OBEYS THE SAME RULE AS THE RAIL'S (#472, ConsoleNav's
// header): the screen behind a `mock` row really opens and really draws the
// console kit's sample rows, so saying so on its face is the only thing that
// stops a mockup being read as data. `soon` is the opposite case — announced
// and not built. And the chip's GRAIN follows the surface: Plans is part wired,
// so it says which of its six sub-views are real rather than wearing one label
// that would be wrong about four of them.
//
// KEEP THIS IN STEP WITH `navSections` IN ProjectDetail.tsx. There is no shared
// definition to import — the rail's rows carry live counts, per-project hrefs
// and a ⋯ menu, none of which this has — so the two are kept in step by
// discipline, exactly like the branch namer and its client twin.
type Standing = 'wired' | 'mock' | 'soon' | string;

const INSIDE: { label: string; group: string; icon: ReactNode; standing: Standing; body: string }[] = [
  {
    group: 'A project', label: 'For you', icon: NavIcons.inbox, standing: 'mock',
    body: 'Where you left off, the push feed and the queue of ideas a push extracted — three panes '
      + 'on one screen, each keeping its own route key so a deep link still lands on the right one.',
  },
  {
    group: 'A project', label: 'The board', icon: NavIcons.board, standing: 'wired',
    body: 'The committed work, and it writes: a kanban whose every control patches a row, and a '
      + 'Backlog tab where sprints are ordered. The sprint in progress IS the run queue — top row '
      + 'first — and it is the only box the overnight runner reads.',
  },
  {
    group: 'A project', label: 'Roadmap', icon: NavIcons.map, standing: 'wired',
    body: 'The rows the board deliberately does not draw: ideas read off a push that nobody has '
      + 'signed off, and children filed under something already on the board. Promote moves one '
      + 'across, and that one write is the whole boundary.',
  },
  {
    group: 'A project', label: 'Plans', icon: NavIcons.route, standing: 'Timeline + Calendar wired',
    body: 'The stored schedule, read back. Timeline is the order the night works in, grouped by '
      + 'sprint; Calendar is when each one runs. Summary, Progress, Releases and Dependencies still '
      + 'draw the kit’s sample rows and each says so on its own sub-tab.',
  },
  {
    group: 'A project', label: 'Quality', icon: NavIcons.check, standing: 'mock',
    body: 'Checks and bugs in one loop — run, see red, file it, fix it, re-run. The route, the '
      + 'tables and the suite ledger are all live; this screen is not reading them yet.',
  },
  {
    group: 'A project', label: 'Starred', icon: NavIcons.star, standing: 'soon',
    body: 'Announced and not built. It is a row rather than a promise elsewhere so the rail’s '
      + 'shape stops moving under you.',
  },
  {
    group: 'A project', label: 'Terminal', icon: NavIcons.terminal, standing: 'wired',
    body: 'The host’s tmux sessions, in the browser, in five layouts you drag sessions into. The '
      + 'rail counts how many are blocked on a permission prompt — and you can answer one from a '
      + 'phone, switch a session’s model, or start one on a different runtime. The daemon dials '
      + 'out, so nothing here needs a port open on your machine.',
  },
  {
    group: 'The house', label: 'Mission Control', icon: NavIcons.layers, standing: 'mock',
    body: 'The fleet from one point — seven kit tabs standing in for the rooms that were culled. '
      + 'It reads nothing and writes nothing, and the button that opens it says so too.',
  },
  {
    group: 'The house', label: 'Timeline', icon: NavIcons.clock, standing: 'wired',
    body: 'Every push, every app, day by day. A push is one checkpoint rather than one commit, so '
      + 'this is the record of sessions — not a git log with the names changed.',
  },
  {
    group: 'The house', label: 'Skills', icon: NavIcons.grid, standing: 'wired',
    body: 'The managed Claude skill library beside what the host actually has on disk. Stack only '
      + 'ever writes or removes the skills it planted; anything else is reported and left alone.',
  },
  {
    group: 'The house', label: 'Settings', icon: <KitIcon name="settings" size={14} />, standing: 'wired',
    body: 'The arm switch for the overnight runner, the fleet-wide worker cap, the executor and '
      + 'advisor models, the session defaults injected into every project, and the access PIN.',
  },
];

const INSIDE_GROUPS = ['A project', 'The house'];

export function InsideSection() {
  return (
    <section id="inside" className="dash-section last">
      <div className="section-bar">
        <div className="titles">
          <div className="h">What’s inside</div>
          <div className="subtitle">Every surface, and which of them are still mockups</div>
        </div>
      </div>
      <div className="inside-groups">
        {INSIDE_GROUPS.map((g) => (
          <div className="inside-group" key={g}>
            <div className="inside-glabel">{g}</div>
            <div className="inside-grid">
              {INSIDE.filter((r) => r.group === g).map((r) => (
                <div className="inside-card" key={r.label}>
                  <div className="inside-head">
                    <span className="con-navico">{r.icon}</span>
                    <span className="inside-name">{r.label}</span>
                    {r.standing !== 'wired' && (
                      <span className={`con-navsoon${r.standing === 'mock' ? ' mock' : ''}`}>
                        {r.standing === 'mock' ? 'Mock' : r.standing === 'soon' ? 'Soon' : r.standing}
                      </span>
                    )}
                  </div>
                  <div className="inside-body">{r.body}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
