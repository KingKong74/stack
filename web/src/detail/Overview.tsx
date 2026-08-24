// The Overview tab — the project's progression spine, and the three measured
// bands under it.
//
// The tab answers one question in one screen: which way is this project moving,
// and what is standing in the way. It opens with the SPINE — the five stages a
// change passes through, each drawn as the queue standing in it, each a doorway
// into the tab or room that owns that stage — and everything below either
// explains a headline number or is somewhere the spine sends you.
//
// FIVE RULES THIS FILE EXISTS TO HOLD:
//
//  1. NO STAGE, QUEUE OR TILE IS COMPUTED HERE. Every predicate lives in
//     `lib/spine.ts`, pure and tested (`scripts/spine.test.mjs`), because the
//     Built stage's predicate must stay identical to the Review room's own
//     (#374) — a copy in a component is how the two silently stop agreeing.
//     The verdict queue below is that same predicate, rendered as rows.
//  2. NO INVENTED THROUGHPUT, AND NO FORECAST. The design draws a flow rate
//     between stages and a "1.0 forecast" date; Stack has no stage-transition
//     stamp to compute either from (rows carry `updatedAt`, which is MOVEMENT,
//     not a ledger). What IS honest — how long a queue has sat still — is shown
//     on the stage itself. Absent is not zero.
//  3. A MEASURED BAND IS ABSENT, NEVER EMPTY, when nothing measured it. The
//     usage, suite and runs bands each read their own `measured` flag and say
//     WHICH of "nothing ran" and "this was never measured" they mean. Twelve
//     empty columns read as a dead project; that is a different claim.
//  4. SPEND IS COST WHERE THERE IS COST AND TOKENS EVERYWHERE ELSE. An
//     interactive session's transcript carries no price, so the by-model band
//     shares on TOKENS and prints a cost only beside how many runs priced
//     themselves. A dollar figure that looks like the whole bill is worse than
//     no dollar figure.
//  5. THE PULSE IS A SECOND TRIP, AND ITS FAILURE IS LOUD. If the fetch fails
//     the bands say so; they never render as a project that spent nothing, ran
//     nothing and tested nothing.
//
// Deployment and Tech stack are twice-a-year config and sit collapsed at the
// foot; their editors are unchanged, just no longer at the weight of live state.

import { useState } from 'react';
import type {
  Activity, Bug, Project, ProjectPulse, ProjectStatus, PulseUsage,
  Roadmap as RoadmapData,
} from '../types';
import { PRODUCT_NAME } from '../lib/ui';
import { ResumeSinceStrip } from '../components/ResumeSinceStrip';
import {
  buildSpine, progressLedger, nextUp, bugSpread, readCadence, PROGRESS_CAP,
  verdictQueue, shippedRecently, overviewStats, compactTokens, usageBars, recentForModel,
  scheduleStrip, inFlightScope, planVsReality,
  type Stage, type VerdictRow, type ScheduleStrip, type InFlightFeature, type PlanVsReality,
} from '../lib/spine';
import { KIND_TONE, type LaneKind } from '../lib/branch';
import { MIN_PER_WEEK, fmtDur } from '../lib/plan';
import { go } from '../lib/route';

// One row of the project-scoped review queue (hook-created, not yet reviewed).
export interface ReviewEntry {
  kind: 'bug' | 'roadmap';
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

const pct1 = (n: number) => `${Math.round(n * 10) / 10}%`;
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;
const duration = (ms: number) => (ms >= 60000
  ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
  : `${Math.round(ms / 1000)}s`);
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// the spine
// ---------------------------------------------------------------------------

// Bar height is the queue's depth on a SQUARE-ROOT scale, not a linear one: a
// 230-deep archive beside a 1-deep lane renders every working stage as a
// hairline under a linear scale, and the comparison the band exists to make —
// which queue is deepest — disappears. Landed is excluded from the scale and
// drawn as a fixed plinth, because it is where work is meant to pile up.
// (The usage strip below is linear, and its header says why the rule flips.)
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
          {/* `hint`, not `note` — `.note` is the Workbench sticky and would
              paint this line on yellow paper. */}
          <span className="lbl">Progression</span>
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
            }{still !== null && `, and none has moved in ${days(still)}`} — clearing
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
            {c.quietFor === 0 ? 'pushed today' : `quiet for ${days(c.quietFor)}`}
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
// the plan: its shape, what is in flight, and what it cost against the baseline
// ---------------------------------------------------------------------------

/** One stacked row inside a lane, in px — bar, ghost and the gap under them. */
const ROW_H = 16;

// AN OFFSET IS NOT A DATE (lib/plan.ts's first rule). The axis is therefore
// labelled in weeks and carries no month names and no "now" marker: this strip
// is drawn without a week zero to hand, so any calendar here would be invented.
// The offsets themselves are minutes (#401); weeks are what the axis SAYS,
// because the whole horizon is what it draws and a minute is not a legible unit
// for six months of plan.
function ScheduleBand({ strip, slug }: { strip: ScheduleStrip; slug: string }) {
  return (
    <div className="band">
      <div className="band-head">
        <span className="h">The plan</span>
        <span className="sub">
          {strip.scheduled} scheduled{strip.unscheduled > 0 && ` · ${strip.unscheduled} still in the tray`}
        </span>
        <button className="band-link" onClick={() => go.detail(slug, 'roadmap')}>Open Timeline →</button>
      </div>
      {strip.scheduled === 0 ? (
        <div className="band-empty">
          Nothing on the board is scheduled yet. That is an unplanned project, not a late one —
          the Timeline is where a bar gets placed.
        </div>
      ) : (
        <>
          <div className="strip">
            {strip.lanes.map((lane) => (
              <div className="strip-lane" key={lane.area}>
                <span className={`name${lane.area === 'Untagged' ? ' untagged' : ''}`}>{lane.area}</span>
                {/* The lane grows with the rows it needs. Two bars sharing a row
                    read as one longer bar — see scheduleStrip(). */}
                <span className="track" style={{ height: lane.rows * ROW_H }}>
                  {lane.bars.map((b) => (
                    <span key={b.id}>
                      {/* The baseline, drawn only where the bar has actually
                          moved off it. */}
                      {b.ghost && (
                        <span className="ghost"
                          style={{ left: `${b.ghost.left}%`, width: `${b.ghost.width}%`, top: b.row * ROW_H + 1 }} />
                      )}
                      <span className={`bar ${b.state}`}
                        style={{ left: `${b.left}%`, width: `${b.width}%`, top: b.row * ROW_H + 3 }}
                        title={`${b.title}${b.ghost ? ' — moved off its baseline' : ''}`} />
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <div className="strip-axis">
            <span>week 1</span>
            <span className="mid">week index, not a date — a slipping project moves its bars</span>
            <span>week {Math.round(strip.span / MIN_PER_WEEK)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function InFlightBand({ features, plan, slug }: {
  features: InFlightFeature[]; plan: PlanVsReality; slug: string;
}) {
  return (
    <div className="ov-split">
      <div className="band">
        <div className="band-head">
          <span className="h">In flight</span>
          <span className="sub">what each of these is actually made of</span>
        </div>
        {features.length === 0 ? (
          <div className="band-empty">
            Nothing is claimed or built right now. The board is queued, not busy.
          </div>
        ) : (
          <div className="flights">
            {features.map((f) => (
              <div className="flight" key={f.id}>
                <div className="flight-top">
                  <button className="title" onClick={() => go.detail(slug, 'roadmap', String(f.id))}>
                    {f.title}
                  </button>
                  {/* `waiting`, not `built` — `.built` is the Review room's
                      built-note block and would draw this chip as a panel. The
                      third time a bare class name has collided on this tab. */}
                  <span className={`state ${f.state === 'built' ? 'waiting' : 'working'}`}>
                    {f.state === 'built' ? 'awaiting your verdict' : 'in progress'}
                  </span>
                  {f.area && <span className="area">{f.area}</span>}
                  <span className="wks">
                    {f.unscoped ? 'not broken down' : `${f.totals.committed} wks committed`}
                  </span>
                </div>
                {f.unscoped ? (
                  <div className="flight-none">
                    No scope lines under this one, so there is nothing to say about what it contains.
                  </div>
                ) : (
                  <>
                    <div className="flight-bar">
                      {f.segs.map((s) => (
                        <span className={`seg ${s.bucket}`} key={s.bucket} style={{ width: `${s.width}%` }}
                          title={`${s.label} — ${s.weeks} wks`}>{s.label}</span>
                      ))}
                    </div>
                    <div className="flight-read">
                      {/* An UNSIZED line is not a free one — plan.ts's third
                          rule, and the only honest way to read a bar built
                          from the sized lines alone. */}
                      {f.totals.unsized > 0 && (
                        <>{f.totals.unsized} line{f.totals.unsized === 1 ? ' is' : 's are'} unsized and
                          not in that bar. </>
                      )}
                      {f.totals.deferred > 0 && <>{f.totals.deferred} wks parked. </>}
                      {f.totals.fits
                        ? 'Fits the cycle.'
                        : `${f.totals.over} wks past the cycle.`}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="band">
        <div className="band-head">
          <span className="h">Plan vs. reality</span>
          <span className="sub">against the baseline, not against today</span>
        </div>
        {plan.measured === 0 ? (
          <div className="band-empty">
            No scheduled feature carries a baseline, so there is nothing to measure a slip against.
            That is not a project on plan — it is one that never committed to a plan.
          </div>
        ) : plan.rows.length === 0 ? (
          <div className="band-empty">
            Every one of the {plan.measured} baselined features is sitting exactly where it was
            committed to. Nothing has slipped.
          </div>
        ) : (
          <div className="slips">
            {plan.rows.map((r) => (
              <div className="slip" key={r.id}>
                <span className="title">{r.title}</span>
                {/* Said in the units the slip actually is (#401): a bar three
                    days late reads as 3d, not as a rounded "0 wks". */}
                <span className={`delta${r.min > 0 || r.longer > 0 ? ' late' : ' early'}`}>
                  {r.min !== 0 && `${r.min > 0 ? '+' : '−'}${fmtDur(Math.abs(r.min))} ${r.min > 0 ? 'later' : 'earlier'}`}
                  {r.min !== 0 && r.longer !== 0 && ' · '}
                  {r.longer !== 0 && `${r.longer > 0 ? '+' : '−'}${fmtDur(Math.abs(r.longer))} ${r.longer > 0 ? 'longer' : 'shorter'}`}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="eg-read">
          {plan.totalSlip > 0 && <>{fmtDur(plan.totalSlip)} of slip across the board. </>}
          {/* NOT counted as "on plan" — the same NULL-verdict rule. */}
          {plan.unmeasured > 0
            ? <>{plan.unmeasured} scheduled feature{plan.unmeasured === 1 ? '' : 's'} carr{plan.unmeasured === 1 ? 'ies' : 'y'} no
              baseline and {plan.unmeasured === 1 ? 'is' : 'are'} not measured here — which is not the same as being on plan.</>
            : <>Every scheduled feature carries a baseline, so this is the whole picture.</>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the usage band — what the models spent here
// ---------------------------------------------------------------------------

function UsageBand({ usage, windowDays }: { usage: PulseUsage; windowDays: number }) {
  const [open, setOpen] = useState('');
  const bars = usageBars(usage);
  const detail = usage.models.find((m) => m.model === open) || null;
  const del = usage.delegations;

  return (
    <div className="band">
      <div className="band-head">
        <span className="h">Model usage</span>
        <span className="sub">this project · last {Math.round(windowDays / 7)} weeks</span>
      </div>

      <div className="usage-stats">
        <div className="ustat accent">
          <span className="lbl">Sessions</span>
          <span className="v">{usage.sessions}</span>
          {/* The two populations are named, never blended: they answer to
              different policies (CLAUDE.md, the Roles room). */}
          <span className="sub">{usage.runs} autopilot run{usage.runs === 1 ? '' : 's'} beside them</span>
        </div>
        <div className="ustat">
          <span className="lbl">Tokens</span>
          <span className="v">{compactTokens(usage.tokens)}</span>
          <span className="sub">
            {compactTokens(usage.interactiveTokens)} by hand · {compactTokens(usage.autoTokens)} unattended
          </span>
        </div>
        <div className="ustat">
          <span className="lbl">Median session</span>
          <span className="v">
            {usage.medianSessionTokens === null ? '—' : compactTokens(usage.medianSessionTokens)}
          </span>
          <span className="sub">
            {/* A delegation whose transcript was lost is UNPRICED, not free. */}
            {del.calls === 0 ? 'no subagents delegated'
              : `${del.calls} delegation${del.calls === 1 ? '' : 's'}, ${del.recorded} recorded`}
          </span>
        </div>
        <div className="ustat live">
          <span className="lbl">Spend</span>
          <span className="v">{usage.pricedRuns === 0 ? '—' : usd(usage.costUsd)}</span>
          {/* Never let a partial figure read as the whole bill. */}
          <span className="sub">
            {usage.pricedRuns === 0
              ? 'nothing here priced itself — sessions bill to the subscription'
              : `${usage.pricedRuns} of ${usage.runs} runs priced · sessions carry no cost`}
          </span>
        </div>
      </div>

      <div className="usage-body">
        <div className="usage-chart">
          <div className="usage-bars">
            {bars.map((b) => (
              <div className="ubar" key={b.week}
                title={`${b.last ? 'This week' : `Week of ${b.week}`} — ${compactTokens(b.total)} tokens`}>
                <span className="auto" style={{ height: b.autoH }} />
                <span className="inter" style={{ height: b.interactiveH }} />
              </div>
            ))}
          </div>
          <div className="usage-axis">
            <span>{Math.round(windowDays / 7)} weeks ago</span>
            <span className="mid">tokens per week · unattended above, by hand below</span>
            <span className="now">this week</span>
          </div>
        </div>

        <div className="usage-models">
          <div className="lbl">By model · open one</div>
          {usage.models.length === 0 ? (
            // Tokens with no model named: pre-#167 rows carry a flat total only.
            <div className="band-empty">
              No per-model breakdown recorded. The rows in this window report a total and
              not which model spent it.
            </div>
          ) : (
            <div className="model-list">
              {usage.models.map((m) => (
                <button className={`model-row${open === m.model ? ' on' : ''}`} key={m.model}
                  onClick={() => setOpen(open === m.model ? '' : m.model)}
                  title={`${m.tokens.toLocaleString('en-AU')} tokens — ${m.model}`}>
                  <span className="line">
                    <span className="chev">{open === m.model ? '▾' : '▸'}</span>
                    <span className="name">{m.label}</span>
                    <span className="n">{compactTokens(m.tokens)}</span>
                  </span>
                  <span className="track"><span className="fill" style={{ width: `${m.share}%` }} /></span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {detail && (
        <div className="usage-detail">
          <div className="ud-head">
            <span className="name">{detail.label}</span>
            <span className="where">
              {detail.sessions} session{detail.sessions === 1 ? '' : 's'} · {detail.runs} run{detail.runs === 1 ? '' : 's'}
            </span>
            <button className="ud-close" onClick={() => setOpen('')}>Close</button>
          </div>
          <div className="ud-body">
            <div className="ud-stats">
              <div className="ud-stat"><span className="lbl">Tokens</span><span className="v">{compactTokens(detail.tokens)}</span></div>
              <div className="ud-stat"><span className="lbl">Share</span><span className="v">{pct1(detail.share)}</span></div>
              <div className="ud-stat">
                <span className="lbl">Cost</span>
                {/* null is UNPRICED, and must not render as $0. */}
                <span className="v">{detail.costUsd === null ? 'unpriced' : usd(detail.costUsd)}</span>
              </div>
              <div className="ud-stat"><span className="lbl">Last seen</span><span className="v">{detail.lastAt.slice(0, 10)}</span></div>
            </div>
            <div className="ud-recent">
              <div className="lbl">Where it ran</div>
              {recentForModel(usage, detail.model).map((r, i) => (
                <div className="ud-row" key={`${r.at}:${i}`}>
                  <span className="when">{r.at.slice(5, 10)}</span>
                  <span className="txt">
                    {r.text || (r.kind === 'run' ? 'an unnamed run' : 'a session that wrote no summary')}
                  </span>
                  <span className="n">{compactTokens(r.tokens)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the engineering band — the suite, the verdicts, the runs
// ---------------------------------------------------------------------------

function Metric({ label, value, tone = '', width = null }: {
  label: string; value: string; tone?: string; width?: number | null;
}) {
  return (
    <div className="metric">
      <div className="line">
        <span className="name">{label}</span>
        <span className={`v ${tone}`}>{value}</span>
      </div>
      {width !== null && (
        <span className="track"><span className={`fill ${tone}`} style={{ width: `${width}%` }} /></span>
      )}
    </div>
  );
}

function EngBand({ pulse, slug, built }: {
  pulse: ProjectPulse; slug: string; built: Stage | undefined;
}) {
  const t = pulse.tests;
  const r = pulse.runs;
  const v = r.verdicts;
  const suite = t.suite;

  // The suite's state as a word. NEVER RUN is its own answer — the same rule as
  // a NULL review_verdict — because "0 failing" out of a suite nobody ran is
  // the most confident wrong thing this band could say.
  const suiteState = !t.measured ? { txt: 'no suite', tone: 'muted' }
    : t.failing > 0 ? { txt: `${t.failing} failing`, tone: 'bad' }
      : suite.passRate === null ? { txt: 'never run', tone: 'muted' }
        : { txt: 'holding', tone: 'good' };

  const oldest = built?.lastMovedDays ?? null;
  const reviewState = (built?.count ?? 0) === 0 ? { txt: 'clear', tone: 'good' }
    : built?.blocked ? { txt: 'backed up', tone: 'warn' } : { txt: 'moving', tone: 'muted' };

  return (
    <div className="band">
      <div className="band-head">
        <span className="h">Tests, verdicts and runs</span>
        <span className="sub">last {Math.round(pulse.windowDays / 7)} weeks</span>
      </div>
      <div className="eng-groups">
        {/* --- the suite --- */}
        <div className="eng-group">
          <div className="eg-head">
            <span className="name">Tests</span>
            <span className={`state ${suiteState.tone}`}>{suiteState.txt}</span>
          </div>
          {!t.measured ? (
            <div className="band-empty">
              This project has no checks, so it has no suite — which is not the same as a green
              one. Checks are {PRODUCT_NAME}'s only automated regression net, and the evidence
              auto-merge and auto-verdict spend.
            </div>
          ) : (
            <>
              <div className="metrics">
                <Metric label="Suite pass rate"
                  value={suite.passRate === null ? 'no run' : pct1(suite.passRate)}
                  tone={suite.passRate === null ? 'muted' : suite.passRate >= 99 ? 'good' : 'warn'}
                  width={suite.passRate} />
                <Metric label="Checks failing now" value={String(t.failing)}
                  tone={t.failing > 0 ? 'bad' : 'good'} />
                {/* Never-run is reported apart from passing, always. */}
                {t.never > 0 && <Metric label="Never run" value={String(t.never)} tone="muted" />}
                <Metric label="Median suite run"
                  value={suite.medianMs === null ? 'no run' : duration(suite.medianMs)} />
                <Metric label="Flaky" value={t.flaky.length ? String(t.flaky.length) : 'none seen'}
                  tone={t.flaky.length ? 'warn' : ''} />
              </div>
              <div className="eg-read">
                {suite.lastAt
                  ? <>Last suite: {suite.lastPassed} of {suite.lastTotal} passed, {suite.runs} run{suite.runs === 1 ? '' : 's'} in the window.</>
                  : <>No whole-suite run in the window — the per-check results above are the last thing measured.</>}
                {t.flaky.length > 0 && <> {t.flaky[0].name} has flipped {t.flaky[0].flips} times in its last {t.flaky[0].of}.</>}
                {t.external > 0 && <> {t.external} check{t.external === 1 ? ' is' : 's are'} reported from outside {PRODUCT_NAME}.</>}
              </div>
              <button className="band-link" onClick={() => go.detail(slug, 'quality')}>Open Quality →</button>
            </>
          )}
        </div>

        {/* --- the verdict queue's shape --- */}
        <div className="eng-group">
          <div className="eg-head">
            <span className="name">Verdicts</span>
            <span className={`state ${reviewState.tone}`}>{reviewState.txt}</span>
          </div>
          <div className="metrics">
            <Metric label="Awaiting your verdict" value={String(built?.count ?? 0)}
              tone={(built?.count ?? 0) > 0 ? 'warn' : 'good'} />
            <Metric label="Oldest moved" value={oldest === null ? 'unstamped' : days(oldest)}
              tone={oldest !== null && oldest >= 3 ? 'warn' : ''} />
            {/* The second model's read on each run. `none` is NO PASS RAN and is
                deliberately not green — same rule as a NULL review_verdict. */}
            <Metric label="Reviewed clean" value={String(v.clean)} tone={v.clean ? 'good' : ''} />
            <Metric label="Concerns / blocked" value={String(v.concerns + v.blocked)}
              tone={v.concerns + v.blocked > 0 ? 'bad' : ''} />
            <Metric label="No review ran" value={String(v.none)} tone="muted" />
          </div>
          <div className="eg-read">
            {r.autoVerdictRuns > 0
              ? <>{r.autoVerdictRuns} run{r.autoVerdictRuns === 1 ? '' : 's'} verdicted themselves under the low-risk gate, with the evidence kept and an undo.</>
              : <>Every verdict here was given by a human. A NULL review is a pass that never ran, not a clean one.</>}
          </div>
        </div>

        {/* --- the autopilot's runs --- */}
        <div className="eng-group">
          <div className="eg-head">
            <span className="name">Runs</span>
            <span className={`state ${r.measured ? (r.landRate !== null && r.landRate >= 60 ? 'good' : 'muted') : 'muted'}`}>
              {r.measured ? `${r.total} run${r.total === 1 ? '' : 's'}` : 'none'}
            </span>
          </div>
          {!r.measured ? (
            <div className="band-empty">
              The autopilot has not run on this project in the window. That is a project nobody
              queued, not a project that failed.
            </div>
          ) : (
            <>
              <div className="metrics">
                <Metric label="Landed" value={String(r.landed)} tone="good"
                  width={r.total ? (r.landed / r.total) * 100 : 0} />
                <Metric label="Failed or hit a limit" value={String(r.failed)}
                  tone={r.failed > 0 ? 'bad' : ''} />
                <Metric label="Ran, committed nothing" value={String(r.noCommits)} tone="muted" />
                {/* A plan night commits nothing BY DESIGN and can never land, so
                    it is counted apart and sits out the rate below. */}
                <Metric label="Plan nights" value={String(r.planned)} tone="muted" />
                <Metric label="Land rate"
                  value={r.landRate === null ? 'nothing landable' : pct1(r.landRate)}
                  tone={r.landRate !== null && r.landRate >= 60 ? 'good' : 'warn'} />
              </div>
              <div className="eg-read">
                {r.commits} commit{r.commits === 1 ? '' : 's'} came out of those runs.
                {r.planned > 0 && ' Plan nights are excluded from the rate — they commit nothing by design, so counting them would score the advisor as having failed to land work nobody asked it to land.'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// awaiting your verdict
// ---------------------------------------------------------------------------

function KindTag({ kind }: { kind: LaneKind | '' }) {
  // '' is a legacy `auto/item-N` lane, which records no kind (#363). It shows
  // as unlabelled rather than guessing 'feat'.
  if (!kind) return <span className="kindtag none" title="the branch name records no kind">lane</span>;
  return <span className="kindtag" style={{ color: KIND_TONE[kind], borderColor: KIND_TONE[kind] }}>{kind}</span>;
}

function VerdictBand({ rows, total, slug }: { rows: VerdictRow[]; total: number; slug: string }) {
  return (
    <div className="band verdicts">
      <div className="band-head">
        <span className="h">Awaiting your verdict</span>
        <span className="sub">
          {total} change{total === 1 ? '' : 's'} built and waiting · oldest first
        </span>
        <button className="btn-accent sm" onClick={() => go.detail(slug, 'roadmap')}>Open roadmap →</button>
      </div>
      {rows.map((r) => (
        <div className={`vrow${r.ageDays !== null && r.ageDays >= 3 ? ' hot' : ''}`} key={r.id}>
          <div className="vmain">
            <div className="vtop">
              <span className="title">{r.title}</span>
              <KindTag kind={r.kind} />
              {/* Un-ticking clears claimed_by and keeps built_note, so a ticked
                  row here is one waiting on a verdict rather than on a build. */}
              {r.ticked && <span className="ticked" title="ticked, but no verdict stored yet">ticked</span>}
            </div>
            <div className="vsummary">
              {r.built || 'No built note. The session that finished this never wrote what landed — the verdict has nothing to be made against.'}
            </div>
            {r.branch && <div className="vorigin">{r.branch}</div>}
          </div>
          <div className="vacts">
            <span className={`vage${r.ageDays !== null && r.ageDays >= 3 ? ' hot' : ''}`}>
              {r.ageDays === null ? 'no stamp' : r.ageDays === 0 ? 'today' : days(r.ageDays)}
            </span>
            <button className="vgo" onClick={() => go.detail(slug, 'roadmap', String(r.id))}>Review</button>
          </div>
        </div>
      ))}
      {total > rows.length && (
        <div className="vtail">
          {total - rows.length} more waiting. Clearing the oldest is what unblocks everything behind it.
        </div>
      )}
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
// the panels
// ---------------------------------------------------------------------------

// The north star. Its editor lived on the Polaris tab and came here when that
// tab was culled — the FIELD is not a Polaris artifact: `projects.north_star`
// is read by the autopilot's spec prompt, the roadmap's ✧ ops, the tab
// consoles, the Workbench ops and the SessionStart hook, so leaving it with no
// editor would have made six live surfaces depend on a value nobody could
// change. It sits beside Directives because they are the same kind of thing:
// standing text that shapes every session, edited in one place.
function NorthStarPanel({ text, onSave }: { text: string; onSave: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  const save = () => {
    const t = draft.trim();
    setEditing(false);
    if (t !== text) onSave(t);
  };

  return (
    <div className="rail-panel">
      <div className="rail-head">
        <span className="lbl">★ North star</span>
        {!editing && (
          <button className="rail-link" onClick={() => { setDraft(text); setEditing(true); }}>
            {text ? 'Edit' : '+ Set'}
          </button>
        )}
      </div>
      <div className="rail-note">injected into every session start</div>
      {editing ? (
        <div className="northstar-editor">
          <textarea value={draft} autoFocus rows={3}
            placeholder="One paragraph: what is this project becoming?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }} />
          <div className="row">
            <span className="hint">⏎ to save · esc to cancel</span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button className="btn-cancel sm" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn-submit sm" onClick={save}>Save</button>
            </span>
          </div>
        </div>
      ) : text ? (
        <div className="pns-text">{text}</div>
      ) : (
        <div className="rail-empty">
          Not set. One paragraph on what this project is becoming — it is injected into every
          session, so every agent pulls in the same direction.
        </div>
      )}
    </div>
  );
}

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

// One line per push, not a stack of full cards. The tab's job here is "what has
// this project been doing", which needs REACH — a dozen pushes at a glance —
// where the Activity tab's job is the detail. Summaries are clamped rather than
// truncated server-side, so the full text is still in the DOM for ⌘F and a
// screen reader.
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

// There is no BackToTop here: App.tsx already renders one app-wide (<ToTop/>),
// and a second copy on this tab put two of them in the same corner.

// ---------------------------------------------------------------------------

export function Overview({
  project, phase, activity, directives, reviewQueue, roadmap, bugs, cadence, lastPushAt,
  northStar, onSaveNorthStar,
  pulse, pulseError,
  onViewAll, onChangeDirectives, onReviewKeep, onReviewDismiss, onSaveDeploy, onSaveStack,
  keepResumeCard = true, onJumpBack,
}: {
  project: Project; phase: string;
  activity: Activity[]; directives: string[]; reviewQueue: ReviewEntry[];
  roadmap: RoadmapData; bugs: Bug[];
  northStar: string; onSaveNorthStar: (text: string) => void;
  cadence: { day: string; n: number }[]; lastPushAt: string | null;
  /** null = the second trip has not answered yet; see `pulseError` for a failure. */
  pulse: ProjectPulse | null; pulseError: string;
  onViewAll: () => void; onChangeDirectives: (next: string[]) => void;
  onReviewKeep: (e: ReviewEntry) => void; onReviewDismiss: (e: ReviewEntry) => void;
  onSaveDeploy: (patch: DeployPatch) => void; onSaveStack: (next: string[]) => void;
  keepResumeCard?: boolean;
  onJumpBack?: () => void;
}) {
  // The checkpoint opens expanded and remembers nothing across mounts: it is the
  // page's headline, and a project you have not looked at in a fortnight is
  // exactly the one whose fold you would not remember collapsing.
  const [heroOpen, setHeroOpen] = useState(true);
  const r = project.resume;
  const slug = project.id;
  const stages = buildSpine(roadmap, slug);
  const built = stages.find((s) => s.key === 'built');
  const queue = nextUp(roadmap, 5);
  const spread = bugSpread(bugs);
  const openBugs = spread.reduce((n, s) => n + s.n, 0);
  const serious = spread.filter((s) => s.severity === 'critical' || s.severity === 'high')
    .reduce((n, s) => n + s.n, 0);
  const tiles = overviewStats(roadmap, stages, project.progress, cadence);
  const verdicts = verdictQueue(roadmap, 5);
  const strip = scheduleStrip(roadmap);
  const flights = inFlightScope(roadmap);
  const plan = planVsReality(roadmap);
  const shipped = shippedRecently(roadmap, 5);
  const latest = activity.slice(0, 6);

  return (
    <div className="ov">
      {/* ---- the hero: where this project stands, in its own words ---- */}
      {keepResumeCard && (
        <div className={`ov-hero${heroOpen ? '' : ' shut'}`}>
          {/* One full-width block, not a two-column card: the checkpoint IS the
              headline of this page, and boxing it beside a button column left
              the summary reading in a narrow gutter. */}
          {/* A row, not a button: Jump back in sits at the top right and a
              button cannot be nested inside another. The fold's hit area is the
              toggle below, which spans the title and its chip. */}
          <div className="hero-bar">
            <button className="hero-toggle" onClick={() => setHeroOpen(!heroOpen)}
              aria-expanded={heroOpen}
              title={heroOpen ? 'Collapse the checkpoint' : 'Expand the checkpoint'}>
              <span className="chev">{heroOpen ? '▾' : '▸'}</span>
              <span className="resume-ico">↩</span>
              <span className="hero-name">Where you left off</span>
              {phase && <span className="hero-phase">{phase}</span>}
            </button>
            <span className="hero-when">
              {/* `when` is the LAST PUSH, which is only when this card was
                  updated if that push authored a checkpoint. When it didn't,
                  say when the content was actually written. */}
              {/* A resume with no push behind it renders `when` and `ref` as
                  empty strings, and the plain template then reads
                  "updated  · after push " — a sentence with its facts missing.
                  Say which of the three states it actually is. */}
              {!r ? 'nothing captured yet'
                : r.since?.authoredWhen
                  ? `checkpoint ${r.since.authoredWhen} · ${r.since.count} push${r.since.count === 1 ? '' : 'es'} since`
                  : r.ref ? `updated ${r.when} · after push ${r.ref}`
                    : 'no push recorded against this yet'}
            </span>
            {onJumpBack && (
              <button className="btn-accent hero-jump" onClick={onJumpBack}
                title="Open the Roadmap — what is planned, scheduled and next">
                Jump back in ↗
              </button>
            )}
          </div>

          {heroOpen ? (
            <div className="hero-body">
              {/* What has landed SINCE the checkpoint that wrote the summary
                  below — a stale card has to read as stale, or you act on an
                  account of the project that three pushes have already overtaken. */}
              {r && <ResumeSinceStrip since={r.since} slug={slug} />}
              <div className="hero-summary">
                {r ? r.summary
                  : `Nothing captured yet. After your first push, a summary of where you left off lands here through the ${PRODUCT_NAME} API.`}
              </div>
              {r && r.nextUp.length > 0 && (
                <div className="hero-next">
                  {r.nextUp.slice(0, 3).map((t, i) => (
                    <div className="hero-step" key={i}><span className="mk arrow">→</span><span>{t}</span></div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            // Collapsed still says something: a one-line clamp of the summary,
            // so the fold is a fold and not a blank bar you have to open to
            // learn whether it was worth opening.
            <div className="hero-shut">{r ? r.summary : 'Nothing captured yet.'}</div>
          )}
        </div>
      )}

      {/* ---- the queue cards: what is standing between you and progress ---- */}
      <div className="ov-cards">
        {keepResumeCard && r && (
          <div className="ovc resume-card">
            <div className="lbl">Currently in progress</div>
            {r.inProgress.length ? (
              <div className="ovc-list">
                {r.inProgress.slice(0, 3).map((t, i) => (
                  <div className="item" key={i}><span className="mk dot" /><span>{t}</span></div>
                ))}
              </div>
            ) : <div className="ovc-note">Nothing mid-flight — the last session finished what it started.</div>}
            {r.liked.length > 0 && (
              <div className="ovc-keep">
                <span className="mk tick">✓</span>
                <span>{r.liked[0]}</span>
              </div>
            )}
            <div className="ovc-acts">
              <button className="ovc-go" onClick={() => go.detail(slug, 'roadmap')}>Open roadmap</button>
            </div>
          </div>
        )}

        <div className={`ovc${(built?.count ?? 0) > 0 ? ' flag' : ''}`}>
          <div className="lbl">Awaiting verdict</div>
          <div className="ovc-figure">
            <span className={`v${(built?.count ?? 0) > 0 ? ' accent' : ''}`}>{built?.count ?? 0}</span>
            {built?.blocked && <span className="tag">backed up</span>}
          </div>
          <div className="ovc-note">
            {(built?.count ?? 0) === 0
              ? 'Nothing built is waiting on you.'
              : built?.lastMovedDays !== null && built?.lastMovedDays !== undefined
                ? `Oldest moved ${days(built.lastMovedDays)} ago. Nothing behind it can land.`
                : 'None of these rows carries a stamp, so how long they have waited is unknown.'}
          </div>
          <button className="ovc-go" onClick={() => go.detail(slug, 'roadmap')}>Open roadmap →</button>
        </div>

        <div className={`ovc${serious > 0 ? ' flag' : ''}`}>
          <div className="lbl">Bugs</div>
          <div className="ovc-figure">
            <span className={`v${serious > 0 ? ' bad' : ''}`}>{openBugs}</span>
            {serious > 0 && <span className="tag bad">{serious} serious</span>}
          </div>
          <div className="ovc-note">
            {openBugs === 0 ? 'No open bugs.'
              : serious > 0
                ? `${serious} critical or high, which is what caps progress at ${PROGRESS_CAP}%.`
                : 'None critical or high, so none is holding the progress figure down.'}
          </div>
          <button className="ovc-go" onClick={() => go.detail(slug, 'quality')}>Open Quality →</button>
        </div>

        <div className={`ovc${pulse && pulse.tests.failing > 0 ? ' flag' : ''}`}>
          <div className="lbl">Checks</div>
          {!pulse ? (
            <div className="ovc-note">{pulseError || 'Measuring…'}</div>
          ) : !pulse.tests.measured ? (
            <>
              <div className="ovc-figure"><span className="v muted">none</span></div>
              <div className="ovc-note">
                No checks on this project. That is no regression net, not a green one.
              </div>
            </>
          ) : (
            <>
              <div className="ovc-figure">
                <span className={`v${pulse.tests.failing > 0 ? ' bad' : ' live'}`}>
                  {pulse.tests.failing > 0 ? pulse.tests.failing : pulse.tests.checks}
                </span>
                <span className={`tag${pulse.tests.failing > 0 ? ' bad' : ''}`}>
                  {pulse.tests.failing > 0 ? 'failing' : 'green'}
                </span>
              </div>
              <div className="ovc-note">
                {pulse.tests.never > 0
                  ? `${pulse.tests.never} of ${pulse.tests.checks} have never been run — unprobed, not passing.`
                  : `${pulse.tests.checks} checks, ${pulse.tests.suite.runs} suite run${pulse.tests.suite.runs === 1 ? '' : 's'} in the window.`}
              </div>
            </>
          )}
          <button className="ovc-go" onClick={() => go.detail(slug, 'quality')}>Open Quality →</button>
        </div>
      </div>

      {/* ---- the auto-extract inbox: only when a push actually left something ---- */}
      {reviewQueue.length > 0 && (
        <div className="ov-inbox">
          <div className="inbox-head">
            <span className="lbl">✦ Auto-extracted from your pushes</span>
            <span className="rail-count">{reviewQueue.length}</span>
            <span className="hint">
              a hook-extracted roadmap item is held from the auto runner until you keep it
            </span>
          </div>
          <div className="inbox-rows">
            {reviewQueue.slice(0, 4).map((e) => (
              <div className="inbox-row" key={`${e.kind}:${e.key}`}>
                <span className={`review-kind ${e.kind}`}>
                  {e.kind === 'bug' ? e.key : e.kind === 'roadmap' ? 'roadmap' : 'idea'}
                </span>
                <span className="txt">{e.title}</span>
                <button className="review-keep" onClick={() => onReviewKeep(e)} title="Keep — mark reviewed">✓ Keep</button>
                <button className="review-dismiss" onClick={() => onReviewDismiss(e)}
                  title="Dismiss — delete and don't re-extract">✕ Dismiss</button>
              </div>
            ))}
          </div>
          {reviewQueue.length > 4 && <div className="inbox-tail">{reviewQueue.length - 4} more waiting</div>}
        </div>
      )}

      <Spine stages={stages} slug={slug} />

      {/* ---- the headline tiles ---- */}
      <div className="ov-tiles">
        {tiles.map((t) => (
          <div className="tile" key={t.label}>
            <span className="lbl">{t.label}</span>
            <span className={`v ${t.tone}`}>{t.value}</span>
            <span className="sub">{t.note}</span>
          </div>
        ))}
      </div>

      <div className="ov-split">
        <ProgressLedgerCard project={project} roadmap={roadmap} bugs={bugs} />
        <CadenceCard cadence={cadence} lastPushAt={lastPushAt} />
      </div>

      <ScheduleBand strip={strip} slug={slug} />
      <InFlightBand features={flights} plan={plan} slug={slug} />

      {/* ---- the measured bands. Absent, never empty. ---- */}
      {pulseError ? (
        <div className="band band-failed">
          <div className="band-head"><span className="h">Model usage, tests and runs</span></div>
          <div className="band-empty">
            {pulseError} — so this project's spend, suite and runs could not be READ, which is a
            different thing from a project that spent, tested and ran nothing.
          </div>
        </div>
      ) : !pulse ? (
        <div className="band"><div className="band-empty">Measuring the last twelve weeks…</div></div>
      ) : (
        <>
          {pulse.usage.measured ? (
            <UsageBand usage={pulse.usage} windowDays={pulse.windowDays} />
          ) : (
            <div className="band">
              <div className="band-head"><span className="h">Model usage</span></div>
              <div className="band-empty">
                No sessions and no runs on this project in the last {Math.round(pulse.windowDays / 7)} weeks.
              </div>
            </div>
          )}
          <EngBand pulse={pulse} slug={slug} built={built} />
        </>
      )}

      {(built?.count ?? 0) > 0 && <VerdictBand rows={verdicts} total={built?.count ?? 0} slug={slug} />}

      {/* ---- the river, and what is queued behind it ---- */}
      <div className="ov-split">
        <div className="landed">
          <div className="landed-head">
            <span className="lbl">Pushes</span>
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

        <div className="rail-panel">
          <div className="rail-head">
            <span className="lbl">Next up</span>
            <button className="rail-link" onClick={() => go.detail(slug, 'roadmap')}>the board</button>
          </div>
          <div className="rail-note">tier first, then bucket — the run queue's own sort</div>
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
      </div>

      {/* ---- what shipped, what is only an idea, and what you have told sessions ---- */}
      <div className="ov-trio">
        <div className="rail-panel">
          <div className="rail-head">
            <span className="lbl">Shipped</span>
            <button className="rail-link" onClick={() => go.detail(slug, 'roadmap')}>the archive</button>
          </div>
          <div className="rail-note">verdicted and merged, freshest first</div>
          {shipped.length ? (
            <div className="rail-list">
              {shipped.map((s) => (
                <button className="rail-row" key={s.id}
                  onClick={() => go.detail(slug, 'roadmap', String(s.id))}>
                  <span className="mk done">✓</span>
                  <span className="txt">{s.title}</span>
                  <span className="tier when">
                    {s.ageDays === null ? '—' : s.ageDays === 0 ? 'today' : `${s.ageDays}d`}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rail-empty">
              Nothing has been verdicted and merged yet. Ticking is not a verdict — the board's
              ✓ Review panel stores one.
            </div>
          )}
        </div>

        <NorthStarPanel text={northStar} onSave={onSaveNorthStar} />

        <DirectivesPanel directives={directives} onChange={onChangeDirectives} />
      </div>

      <ConfigStrip project={project} onSaveDeploy={onSaveDeploy} onSaveStack={onSaveStack} />
    </div>
  );
}
