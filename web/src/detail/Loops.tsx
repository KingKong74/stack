// LOOPS IS A MOCKUP, from the Claude Design project's "Roadmap Canvas" (its
// `loops` view, 2026-10-12). It reads nothing and writes nothing: the loops,
// their runs and the agents their steps name are the design's sample rows. The
// rail row wears the Mock chip, and the arm switch here arms nothing.
//
// WIRING IT IS A GATE CHANGE, NOT A SCREEN CHANGE. Today there is one loop —
// the autopilot, whose switches live on #/inbox and whose holds GET
// /autopilot/loop explains — and everything that may start work answers to
// the gates in the root CLAUDE.md ("Before you change who or what may run").
// A loop whose finish is "Merge if green" is an auto-merge path, and a
// user-authored guard is a predicate nothing checks. Both need the gate rules
// extended before any of this is real.
//
// Component state only, and it dies with the tab — the same reasoning as
// Artifacts.tsx's header.

import { useState } from 'react';

const H = 3_600_000;

type Outcome = 'landed' | 'no-commits' | 'failed' | 'limit';
type Trigger =
  | { kind: 'schedule'; at: string; days: string; event?: string }
  | { kind: 'event'; event: string; at?: string; days?: string };
interface Run { at: number; outcome: Outcome; note: string; dur: string; cost: string }
interface Step { agent: string; task: string }
interface Loop {
  id: number; name: string; job: string; trigger: Trigger; steps: Step[];
  guard: string; finish: string; enabled: boolean; runs: Run[]; project: string;
}

// The design's sample agents — Skills & agents is wired, this list is not.
const AGENTS = [
  { key: 'executor', name: 'Implementer', model: '', tools: 7, enabled: true },
  { key: 'reviewer', name: 'Reviewer', model: 'claude-opus-5', tools: 4, enabled: true },
  { key: 'architect', name: 'Architect', model: 'claude-opus-5', tools: 4, enabled: true },
  { key: 'sweeper', name: 'Sweeper', model: 'claude-haiku-4-5', tools: 2, enabled: true },
  { key: 'researcher', name: 'Researcher', model: '', tools: 3, enabled: false },
];
const EXEC_MODEL = 'claude-sonnet-5';
const PROJECTS = ['stack', 'folio', 'ledger'];

const EVENTS: Record<string, string> = {
  push: 'every push', suite: 'after each suite run', bug: 'when a bug is filed',
  ready: 'when an item is marked Ready', pr: 'when a PR opens',
};
const DAYS: Record<string, string> = { daily: 'daily', weekdays: 'weekdays', sun: 'Sundays', sat: 'Saturdays' };
const FIN: Record<string, [string, string]> = {
  merge: ['Merge if green', 'Merges only when the guard holds.'],
  pr: ['Open a PR', 'Leaves the merge to you.'],
  board: ['File to the board', 'Results land as cards in the right area.'],
  inbox: ['Post to the inbox', 'A one-line report waits for you in the morning.'],
};
// [label, status tone, the mark's fill]
const OUT: Record<Outcome, [string, string, string]> = {
  landed: ['landed', 'success', 'var(--action-accent)'],
  'no-commits': ['no commits', 'neutral', 'var(--grey-500)'],
  failed: ['failed', 'danger', 'var(--red-500)'],
  limit: ['hit a limit', 'warning', 'var(--amber-500)'],
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function seed(): Loop[] {
  const L = (id: number, name: string, job: string, trigger: Trigger, steps: Step[], guard: string, finish: string, enabled: boolean, runs: Run[], project = ''): Loop =>
    ({ id, name, job, trigger, steps, guard, finish, enabled, runs, project });
  const R = (hrs: number, outcome: Outcome, note: string, dur: string, cost: string): Run =>
    ({ at: Date.now() - hrs * H, outcome, note, dur, cost });
  return [
    L(1, 'Land the green ones', 'Review and merge a branch once its checks go green.', { kind: 'event', event: 'push' },
      [{ agent: 'reviewer', task: 'Read the diff and give a verdict.' }, { agent: 'executor', task: 'Merge if the verdict is clean.' }],
      'checks pass and 0 behind main', 'merge', true,
      [R(0.6, 'landed', 'stack · term-lane-holder', '4m', '$0.90'), R(2.4, 'landed', 'stack · quality-summary', '6m', '$1.40'),
        R(4.1, 'no-commits', 'folio · print-margins: verdict concerns', '3m', '$0.70'), R(7.5, 'landed', 'stack · board-j-k', '5m', '$1.10'),
        R(10.2, 'failed', 'ledger · import-csv: 2 checks red', '2m', '$0.40')]),
    L(2, 'Nightly branch sweep', 'Prune branches that are merged or have gone quiet.', { kind: 'schedule', at: '02:00', days: 'daily' },
      [{ agent: 'sweeper', task: 'Delete merged and stale branches.' }], 'no commits in 7 days', 'inbox', true,
      [R(8.3, 'landed', '6 branches removed', '48s', '$0.12'), R(32.3, 'landed', '2 branches removed', '41s', '$0.09')]),
    L(3, 'Quarantine flaky checks', 'Pull a check out of the suite when it keeps flipping.', { kind: 'event', event: 'suite' },
      [{ agent: 'sweeper', task: 'Mark the check as quarantined and file a bug.' }], 'red 3 of last 20 runs', 'board', true,
      [R(1.5, 'no-commits', 'nothing flaky', '20s', '$0.04'), R(5.5, 'landed', 'quarantined GET /api/overview', '35s', '$0.06'),
        R(9.5, 'no-commits', 'nothing flaky', '18s', '$0.04')]),
    L(4, 'Grade new bugs', 'Give every new bug a severity and an area.', { kind: 'event', event: 'bug' },
      [{ agent: 'reviewer', task: 'Read the report and the linked commit, then grade it.' }], 'never sets Blocking', 'board', false,
      [R(30, 'landed', 'BUG-41 graded high', '1m', '$0.20')]),
    L(5, 'Plan night', 'Draft plans for the unplanned high-priority work.', { kind: 'schedule', at: '21:00', days: 'sun' },
      [{ agent: 'architect', task: 'Read each unplanned high item and the code it touches.' }, { agent: 'researcher', task: 'Look up anything the plan depends on.' }],
      'commits nothing, ever', 'inbox', true, [R(40, 'landed', '3 plans drafted', '9m', '$2.10')]),
    L(6, 'Auto-rebase stale branches', 'Keep open branches close to main.', { kind: 'schedule', at: '03:00', days: 'daily' },
      [{ agent: 'executor', task: 'Rebase onto main and push.' }], 'stops if conflicts exceed 2 files', 'pr', false,
      [R(55, 'limit', 'stack · sprint-planner: hit the token cap', '18m', '$4.20')], 'stack'),
  ];
}

const dayOk = (d: Date, days: string) => {
  const w = d.getDay();
  return days === 'daily' || (days === 'weekdays' && w > 0 && w < 6) || (days === 'sun' && w === 0) || (days === 'sat' && w === 6);
};
// A schedule's firings between two instants, host time.
const occurrences = (tr: Trigger, from: number, to: number) => {
  const out: number[] = [];
  const [hh, mm] = (tr.at || '00:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(hh, mm, 0, 0);
  d.setDate(d.getDate() - 1);
  for (let i = 0; i < 10; i++) {
    const t = d.getTime();
    if (t > to) break;
    if (t >= from && dayOk(d, tr.days || 'daily')) out.push(t);
    d.setDate(d.getDate() + 1);
  }
  return out;
};
const fmtIn = (ms: number) => {
  const m = Math.round(ms / 60e3);
  return m < 60 ? `in ${m}m` : m < 24 * 60 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : `in ${Math.round(m / 1440)}d`;
};
const ageMs = (ms: number) => {
  const d = Date.now() - ms;
  if (d < 60e3) return 'just now';
  if (d < H) return `${Math.round(d / 60e3)}m ago`;
  if (d < 24 * H) return `${Math.round(d / H)}h ago`;
  return `${Math.round(d / (24 * H))}d ago`;
};
const trigText = (tr: Trigger) => (tr.kind === 'event' ? `on ${EVENTS[tr.event] || tr.event}` : `${tr.at} ${DAYS[tr.days] || tr.days}`);
const agentName = (k: string) => AGENTS.find((a) => a.key === k)?.name ?? k;
const when = (t: number) => {
  const d = new Date(t);
  const today = d.toDateString() === new Date().toDateString();
  return `${today ? 'today' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} ${d.toTimeString().slice(0, 5)}`;
};

function Switch({ on, title, onToggle }: { on: boolean; title: string; onToggle: () => void }) {
  return (
    <button className={`lp-sw${on ? ' on' : ''}`} role="switch" aria-checked={on} title={title} aria-label={title} onClick={onToggle}>
      <span className="knob" />
    </button>
  );
}
const Arrow = () => <span className="lp-arrow" aria-hidden="true" />;

export function Loops() {
  const [loops, setLoops] = useState<Loop[]>(seed);
  const [nextId, setNextId] = useState(7);
  const [armed, setArmed] = useState(true);
  const [selId, setSelId] = useState<number | undefined>(1);

  const now = Date.now();
  const W0 = now - 12 * H;
  const SPAN = 24 * H;
  const pct = (t: number) => `${(((t - W0) / SPAN) * 100).toFixed(2)}%`;
  const sel = loops.find((l) => l.id === selId) || loops[0];
  const live = loops.filter((l) => l.enabled).length;

  const ticks: { left: string; label: string }[] = [];
  {
    const d = new Date(W0);
    d.setMinutes(0, 0, 0);
    for (let i = 0; i <= 25; i++) {
      if (i) d.setHours(d.getHours() + 1);
      const t = d.getTime();
      if (t > W0 && t < W0 + SPAN && d.getHours() % 3 === 0 && Math.abs(t - now) > 1.2 * H) {
        ticks.push({ left: pct(t), label: `${String(d.getHours()).padStart(2, '0')}:00` });
      }
    }
  }

  const upd = (fn: (l: Loop) => Partial<Loop>) => sel && setLoops((xs) => xs.map((l) => (l.id === sel.id ? { ...l, ...fn(l) } : l)));
  const trUpd = (o: Partial<Trigger>) => upd((l) => ({ trigger: { ...l.trigger, ...o } as Trigger }));

  return (
    <div className="lp">
      <div className="lp-head">
        <div className="lp-title">
          <h1>Loops</h1>
          <span>Jobs that run without you. Each one is a trigger, a chain of agents, and the guard that stops it.</span>
        </div>
        <div className={`lp-arm${armed ? '' : ' off'}`}>
          <span className="tx">
            <span className="l">{armed ? 'Automation armed' : 'Automation off'}</span>
            <span className="h">{armed ? `${live} of ${loops.length} loops may start work` : 'No loop starts new work. Running jobs finish.'}</span>
          </span>
          <Switch on={armed} title={armed ? 'Disarm: no loop starts new work' : 'Arm the automation'} onToggle={() => setArmed((a) => !a)} />
        </div>
        <button className="lp-primary" onClick={() => {
          const id = nextId;
          setNextId((n) => n + 1);
          setLoops((xs) => [...xs, { id, name: 'New loop', job: '', trigger: { kind: 'schedule', at: '09:00', days: 'weekdays' }, steps: [{ agent: 'executor', task: '' }], guard: '', finish: 'pr', enabled: false, runs: [], project: '' }]);
          setSelId(id);
        }}><span className="plus">+</span>New loop</button>
      </div>

      <div className="lp-timeline">
        <div className="lp-tlinner">
          <div className="lp-tlrow head">
            <span className="eyebrow">Loop</span>
            <div className="lp-ticks">
              {ticks.map((t) => <span key={t.label + t.left} style={{ left: t.left }}>{t.label}</span>)}
              <span className="now">now</span>
            </div>
            <span className="eyebrow end">Next</span>
          </div>
          {loops.map((l) => {
            const go = l.enabled && armed;
            const past = l.runs.filter((r) => r.at >= W0).map((r) => {
              const o = OUT[r.outcome];
              return { left: pct(r.at), bg: o[2], border: o[2], op: 1, title: `${o[0]} · ${ageMs(r.at)} · ${r.note}` };
            });
            const fut = l.trigger.kind === 'schedule'
              ? occurrences(l.trigger, now, W0 + SPAN).map((t) => ({
                left: pct(t), bg: 'var(--surface-card)', border: go ? 'var(--text-secondary)' : 'var(--border-default)',
                op: go ? 1 : 0.5, title: go ? `Fires ${fmtIn(t - now)}` : 'Would fire here, but is held',
              }))
              : [];
            let next: string;
            let nextCls = '';
            if (!l.enabled) { next = 'paused'; nextCls = 'off'; }
            else if (!armed) { next = 'held'; nextCls = 'held'; }
            else if (l.trigger.kind === 'event') next = `on ${l.trigger.event}`;
            else { const n = occurrences(l.trigger, now, now + 8 * 24 * H)[0]; next = n ? fmtIn(n - now) : '—'; }
            const dot = go ? 'var(--action-accent)' : l.enabled ? 'var(--amber-500)' : 'var(--grey-600)';
            return (
              <button key={l.id} className={`lp-tlrow${sel && l.id === sel.id ? ' on' : ''}`} onClick={() => setSelId(l.id)}>
                <span className="lp-name">
                  <span className="dot" style={{ background: dot }} />
                  <span className="tx">
                    <span className={`n${l.enabled ? '' : ' off'}`}>{l.name || 'Untitled loop'}</span>
                    <span className="t">{trigText(l.trigger)} · {l.steps.map((s) => agentName(s.agent)).join(' → ')}</span>
                  </span>
                </span>
                <span className="lp-track">
                  <span className="rule" />
                  <span className="nowline" />
                  {[...past, ...fut].map((m, i) => (
                    <span key={i} className="mark" title={m.title}
                      style={{ left: m.left, background: m.bg, borderColor: m.border, opacity: m.op }} />
                  ))}
                </span>
                <span className={`lp-next ${nextCls}`}>{next}</span>
              </button>
            );
          })}
          <div className="lp-legend">
            {([['landed', OUT.landed[2], OUT.landed[2]], ['no commits', OUT['no-commits'][2], OUT['no-commits'][2]],
              ['failed', OUT.failed[2], OUT.failed[2]], ['hit a limit', OUT.limit[2], OUT.limit[2]],
              ['scheduled', 'var(--surface-card)', 'var(--text-secondary)']] as [string, string, string][]).map(([label, bg, border]) => (
              <span key={label}><span className="sw" style={{ background: bg, borderColor: border }} />{label}</span>
            ))}
            <span className="rc-grow" />
            <span>12 hours either side of now</span>
          </div>
        </div>
      </div>

      {sel && (
        <div className="lp-detail">
          <div className="lp-detailhead">
            <div className="lp-names">
              <input className="nm" value={sel.name} placeholder="Name this loop" aria-label="Loop name"
                onChange={(e) => { const v = e.target.value; upd(() => ({ name: v })); }} />
              <input className="job" value={sel.job} placeholder="The job, in one line" aria-label="The job"
                onChange={(e) => { const v = e.target.value; upd(() => ({ job: v })); }} />
            </div>
            <div className="lp-acts">
              <select className="lp-select mono" value={sel.project} title="Which projects this loop works on" aria-label="Projects"
                onChange={(e) => { const v = e.target.value; upd(() => ({ project: v })); }}>
                <option value="">all projects</option>
                {PROJECTS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button className="lp-btn" onClick={() => upd((l) => ({ runs: [...l.runs, { at: Date.now(), outcome: 'landed', note: 'started by you', dur: '—', cost: '—' }] }))}>
                Run now
              </button>
              <button className="lp-btn quiet" onClick={() => {
                setLoops((xs) => xs.filter((l) => l.id !== sel.id));
                setSelId(loops.find((l) => l.id !== sel.id)?.id);
              }}>Delete</button>
              <span className="lp-state">
                <span>{!sel.enabled ? 'Paused' : armed ? 'Running' : 'Held'}</span>
                <Switch on={sel.enabled} title={sel.enabled ? 'Pause this loop' : 'Resume this loop'}
                  onToggle={() => upd((x) => ({ enabled: !x.enabled }))} />
              </span>
            </div>
          </div>

          <div className="lp-chainwrap">
            <div className="lp-chain">
              <div className="lp-node when">
                <span className="eyebrow">When</span>
                <div className="lp-seg">
                  {(['schedule', 'event'] as const).map((k) => (
                    <button key={k} className={sel.trigger.kind === k ? 'on' : ''}
                      onClick={() => trUpd(k === 'event'
                        ? { kind: k, event: sel.trigger.event || 'push' }
                        : { kind: k, at: sel.trigger.at || '09:00', days: sel.trigger.days || 'daily' })}>
                      {cap(k)}
                    </button>
                  ))}
                </div>
                {sel.trigger.kind === 'schedule' ? (
                  <div className="lp-pair">
                    <input type="time" className="lp-select mono time" value={sel.trigger.at || '09:00'} aria-label="Time"
                      onChange={(e) => trUpd({ at: e.target.value || '00:00' })} />
                    <select className="lp-select" value={sel.trigger.days || 'daily'} aria-label="Days"
                      onChange={(e) => trUpd({ days: e.target.value })}>
                      {Object.entries(DAYS).map(([v, label]) => <option key={v} value={v}>{cap(label)}</option>)}
                    </select>
                  </div>
                ) : (
                  <select className="lp-select" value={sel.trigger.event || 'push'} aria-label="Event"
                    onChange={(e) => trUpd({ event: e.target.value })}>
                    {Object.entries(EVENTS).map(([v, label]) => <option key={v} value={v}>{cap(label)}</option>)}
                  </select>
                )}
                <span className="note">{sel.trigger.kind === 'event' ? 'Runs each time it happens, one at a time.' : 'Host time. Quiet hours still apply.'}</span>
              </div>

              {sel.steps.map((s, i) => {
                const a = AGENTS.find((x) => x.key === s.agent);
                const stepUpd = (o: Partial<Step>) => upd((x) => ({ steps: x.steps.map((y, j) => (j === i ? { ...y, ...o } : y)) }));
                return (
                  <div className="lp-link" key={i}>
                    <Arrow />
                    <div className={`lp-node step${a && a.enabled ? ' live' : ''}`}>
                      <div className="lp-stephead">
                        <span className="num">{i + 1}</span>
                        <span className="eyebrow">Agent</span>
                        <span className="rc-grow" />
                        {sel.steps.length > 1 && (
                          <button className="x" title="Remove this step" aria-label={`Remove step ${i + 1}`}
                            onClick={() => upd((x) => ({ steps: x.steps.filter((_, j) => j !== i) }))}>✕</button>
                        )}
                      </div>
                      <select className="lp-select" value={s.agent} aria-label={`Step ${i + 1} agent`} onChange={(e) => stepUpd({ agent: e.target.value })}>
                        {AGENTS.map((x) => <option key={x.key} value={x.key}>{x.name}{x.enabled ? '' : ' (off)'}</option>)}
                      </select>
                      <textarea className="lp-text" rows={3} value={s.task} placeholder="What this agent does here" aria-label={`Step ${i + 1} task`}
                        onChange={(e) => stepUpd({ task: e.target.value })} />
                      <span className="meta">
                        {a ? `${a.model ? a.model.replace(/^claude-/, '') : `inherits ${EXEC_MODEL.replace(/^claude-/, '')}`} · ${a.tools} tools` : 'No such agent'}
                      </span>
                      {(!a || !a.enabled) && (
                        <span className="warn">{!a ? 'This agent no longer exists.' : 'This agent is off in Skills & agents, so the step is skipped.'}</span>
                      )}
                    </div>
                  </div>
                );
              })}

              <Arrow />
              <button className="lp-addstep" onClick={() => upd((l) => ({ steps: [...l.steps, { agent: 'reviewer', task: '' }] }))}>
                <span className="plus">+</span>Add a step
              </button>
              <Arrow />
              <div className="lp-node guard">
                <span className="eyebrow">Guard</span>
                <textarea className="lp-text" rows={3} value={sel.guard} placeholder="Stops the loop when…" aria-label="Guard"
                  onChange={(e) => { const v = e.target.value; upd(() => ({ guard: v })); }} />
                <span className="note">The condition that stops it before it does damage.</span>
              </div>
              <Arrow />
              <div className="lp-node then">
                <span className="eyebrow">Then</span>
                <select className="lp-select" value={sel.finish} aria-label="Then"
                  onChange={(e) => { const v = e.target.value; upd(() => ({ finish: v })); }}>
                  {Object.entries(FIN).map(([v, f]) => <option key={v} value={v}>{f[0]}</option>)}
                </select>
                <span className="note">{(FIN[sel.finish] || FIN.inbox)[1]}</span>
              </div>
            </div>
          </div>

          <div className="lp-runs">
            <div className="lp-runshead">
              <span className="l">Recent runs</span>
              {sel.runs.length > 0 && (
                <span className="n">{sel.runs.filter((r) => r.outcome === 'landed').length} of {sel.runs.length} landed</span>
              )}
            </div>
            <div className="lp-runlist">
              {[...sel.runs].sort((a, b) => b.at - a.at).slice(0, 6).map((r, i) => {
                const o = OUT[r.outcome];
                return (
                  <div className="lp-run" key={i}>
                    <span className="when">{when(r.at)}</span>
                    <span className="out" style={{ background: `var(--status-${o[1]}-bg)`, color: `var(--status-${o[1]}-fg)` }}>{o[0]}</span>
                    <span className="note">{r.note}</span>
                    <span className="num">{r.dur}</span>
                    <span className="num">{r.cost}</span>
                  </div>
                );
              })}
              {sel.runs.length === 0 && <span className="lp-noruns">No runs yet.</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
