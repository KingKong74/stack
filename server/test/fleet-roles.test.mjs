// #281 — the fleet roles aggregation, tested against the REAL export (not a
// replica) and the shapes autopilot_runs actually stores.
//
//   node server/test/fleet-roles.test.mjs      # exits non-zero on any failure
//
// No database and no framework: computeFleetRoles is pure precisely so this is
// possible. It is the one piece of #281 where a wrong answer is silent — drift
// that goes unreported looks exactly like a fleet obeying its policy.
import { computeFleetRoles } from '../src/routes/control.js';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();
const usage = (tok, cost) => ({ inputTokens: tok, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost });

const SONNET = 'claude-sonnet-4-5-20250929';
const OPUS5 = 'claude-opus-5-20260115';
const HAIKU = 'claude-haiku-4-5-20251001';
const FABLE = 'claude-fable-5';

const projects = [
  { slug: 'alpha', name: 'Alpha', tint: '#a1', automode: true },
  { slug: 'bravo', name: 'Bravo', tint: '#b2', automode: true },
  { slug: 'charlie', name: 'Charlie', tint: '#c3', automode: true },
  { slug: 'delta', name: 'Delta', tint: '#d4', automode: true },   // automode, no runs
  { slug: 'echo', name: 'Echo', tint: '#e5', automode: false },    // not automode, no runs
];

const rows = [
  // alpha — on policy, advisor consulted, landed
  { slug: 'alpha', outcome: 'landed', tokens: 1000, cost_usd: 1.00, finished_at: hoursAgo(3),
    model_usage: { [SONNET]: usage(800, 0.60), [OPUS5]: usage(200, 0.40) } },
  { slug: 'alpha', outcome: 'landed', tokens: 500, cost_usd: 0.50, finished_at: hoursAgo(30),
    model_usage: { [SONNET]: usage(400, 0.35), [OPUS5]: usage(100, 0.15) } },
  // bravo — advisor configured but NEVER consulted; one failed
  { slug: 'bravo', outcome: 'failed', tokens: 300, cost_usd: 0.30, finished_at: hoursAgo(10),
    model_usage: { [SONNET]: usage(300, 0.30) } },
  { slug: 'bravo', outcome: 'landed', tokens: 200, cost_usd: 0.20, finished_at: hoursAgo(50),
    model_usage: { [SONNET]: usage(200, 0.20) } },
  // charlie — ran on a model the policy names for NEITHER role (off-policy)
  { slug: 'charlie', outcome: 'landed', tokens: 900, cost_usd: 0.90, finished_at: hoursAgo(20),
    model_usage: { [HAIKU]: usage(900, 0.90) } },
];

const r = computeFleetRoles({ usageRows: rows, projects, execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW });

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};

console.log('--- models ---');
const byModel = Object.fromEntries(r.models.map((m) => [m.label, m]));
check('sonnet role', byModel['sonnet-4-5'].role, 'exec');
check('opus-5 role', byModel['opus-5'].role, 'adv');
check('haiku unattributed', byModel['haiku-4-5'].role, '');
check('sonnet runs', byModel['sonnet-4-5'].runs, 4);
check('opus-5 runs', byModel['opus-5'].runs, 2);
// last 24h: alpha run at 3h and bravo at 10h are inside; 30h/50h/20h -> 20h is inside too
check('sonnet today tokens (3h + 10h + 20h? no haiku)', byModel['sonnet-4-5'].todayTokens, 800 + 300);
check('opus-5 today tokens', byModel['opus-5'].todayTokens, 200);
check('haiku today tokens (20h ago, inside 24h)', byModel['haiku-4-5'].todayTokens, 900);

console.log('\n--- assignments ---');
const byProj = Object.fromEntries(r.assignments.map((a) => [a.slug, a]));
check('alpha drift', byProj.alpha.drift, '');
check('alpha exec', byProj.alpha.exec, 'sonnet-4-5');
check('alpha adv', byProj.alpha.adv, 'opus-5');
check('bravo drift', byProj.bravo.drift, 'advisor-unused');
check('bravo adv empty', byProj.bravo.adv, '');
check('charlie drift', byProj.charlie.drift, 'off-policy');
check('charlie driftModel', byProj.charlie.driftModel, 'haiku-4-5');
check('delta (automode, no runs)', byProj.delta.drift, 'no-runs');
check('echo excluded (no automode, no runs)', byProj.echo, undefined);
check('drift sorted first', r.assignments.slice(0, 2).map((a) => a.slug).sort(), ['bravo', 'charlie']);

console.log('\n--- worth ---');
check('advisedRuns', r.worth.advisedRuns, 2);
check('advisedLanded', r.worth.advisedLanded, 2);
check('plainRuns', r.worth.plainRuns, 3);
check('plainLanded', r.worth.plainLanded, 2);
check('advCostUsd', Number(r.worth.advCostUsd.toFixed(2)), 0.55);
check('execCostUsd', Number(r.worth.execCostUsd.toFixed(2)), 1.45);
check('totalCostUsd (incl. off-policy haiku)', Number(r.worth.totalCostUsd.toFixed(2)), 2.90);
check('advShare ~19%', Math.round(r.worth.advShare), 19);
check('avgAdvPerRun', Number(r.worth.avgAdvPerRun.toFixed(3)), 0.275);
check('costBasis', r.worth.costBasis, true);

console.log('\n--- runs (#288 — the run-level headline the role cards lead with) ---');
// Five rows, every one with a breakdown; only charlie's haiku run used a model
// neither role names. The per-model counts cannot say this: sonnet alone
// appears in four runs, so "off policy" has to be counted once per RUN.
check('total runs (with a breakdown)', r.runs.total, 5);
check('off-policy runs', r.runs.offPolicy, 1);
check('on-policy runs', r.runs.onPolicy, 4);
check('total == advised + plain + plan', r.runs.total,
  r.worth.advisedRuns + r.worth.plainRuns + r.worth.planRuns);
check('haiku adoptable as executor', byModel['haiku-4-5'].adoptExec, 'haiku');
check('sonnet adopts the family alias, not the dated id', byModel['sonnet-4-5'].adoptExec, 'sonnet');
check('opus-5 adoptable as advisor', byModel['opus-5'].adoptAdv, 'claude-opus-5');

console.log('\n--- edge: no runs at all ---');
const empty = computeFleetRoles({ usageRows: [], projects, execAlias: '', advAlias: '', now: NOW });
check('models empty', empty.models, []);
check('advShare 0', empty.worth.advShare, 0);
check('all automode rows are no-runs', empty.assignments.every((a) => a.drift === 'no-runs'), true);

console.log('\n--- edge: runs with no model_usage (older rows) ---');
const noBreak = computeFleetRoles({
  usageRows: [{ slug: 'alpha', outcome: 'landed', tokens: 10, cost_usd: 0.1, finished_at: hoursAgo(2), model_usage: null }],
  projects, execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW,
});
check('sits out the advised/unadvised split', [noBreak.worth.advisedRuns, noBreak.worth.plainRuns], [0, 0]);
check('but the project still counts a run', noBreak.assignments.find((a) => a.slug === 'alpha').runs, 1);
// (#288) …and the role cards say so rather than reading 0 of 0 as compliance.
check('runs.total excludes it', noBreak.runs.total, 0);
check('runs.noBreakdown reports it', noBreak.runs.noBreakdown, 1);

// --------------------------------------------------------------------------
// Plan nights. A plan night runs on the ADVISOR alone and commits nothing by
// design (outcome 'planned'), so it can never be 'landed'. Counting it in the
// advised/unadvised comparison scored the advisor as having failed to land a
// run it was never asked to land — and, before the runner recorded its
// breakdown at all, left a plan-only week reading 'advisor-unused', which is
// the one arrangement where that is certainly false.
// --------------------------------------------------------------------------
console.log('\n--- plan nights (advisor evidence, but not a land rate) ---');
const planOnly = computeFleetRoles({
  usageRows: [
    { slug: 'alpha', outcome: 'planned', tokens: 500, cost_usd: 0.50, finished_at: hoursAgo(4),
      model_usage: { [OPUS5]: usage(500, 0.50) } },
    { slug: 'alpha', outcome: 'planned', tokens: 300, cost_usd: 0.30, finished_at: hoursAgo(8),
      model_usage: { [OPUS5]: usage(300, 0.30) } },
  ],
  projects, execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW,
});
check('plan nights sit out the land rate', [planOnly.worth.advisedRuns, planOnly.worth.plainRuns], [0, 0]);
check('…and are counted as their own', planOnly.worth.planRuns, 2);
check('…the advisor held both', planOnly.worth.advisedPlanRuns, 2);
check('runs.total includes them', planOnly.runs.total, 2);
check('runs.plan names them', planOnly.runs.plan, 2);
check('nothing sat out unexplained', planOnly.runs.noBreakdown, 0);
check('their spend still counts', Number(planOnly.worth.advCostUsd.toFixed(2)), 0.80);
check('avgAdvPerRun divides by the runs advice was seen in', Number(planOnly.worth.avgAdvPerRun.toFixed(2)), 0.40);
// The regression this whole change exists to prevent.
check('a plan-only week is NOT advisor-unused',
  planOnly.assignments.find((a) => a.slug === 'alpha').drift, '');
check('…and the advisor is the model shown', planOnly.assignments.find((a) => a.slug === 'alpha').adv, 'opus-5');

// With no advisor configured a plan night falls back to the executor model, so
// it is a plan run that advice never touched — a different question, and the
// two counters have to be able to disagree.
const planNoAdv = computeFleetRoles({
  usageRows: [
    { slug: 'alpha', outcome: 'planned', tokens: 500, cost_usd: 0.50, finished_at: hoursAgo(4),
      model_usage: { [SONNET]: usage(500, 0.50) } },
  ],
  projects, execAlias: 'sonnet', advAlias: '', now: NOW,
});
check('unadvised plan night still counts as a plan run', planNoAdv.worth.planRuns, 1);
check('…but not as an advised one', planNoAdv.worth.advisedPlanRuns, 0);
check('…and claims no advisor cost', planNoAdv.worth.advCostUsd, 0);

// --------------------------------------------------------------------------
// Interactive sessions. The executor/advisor policy governs the AUTOPILOT, so
// a model the human picked in a terminal is a different population: it shows
// in the merged evidence list and in `manual`, and it must never reach the
// role cards, `worth` or drift. A hand-picked Opus is not off-policy.
// --------------------------------------------------------------------------
console.log('\n--- interactive sessions (evidence, never policy) ---');
const withManual = computeFleetRoles({
  usageRows: rows,
  sessionRows: [
    // one session that switched model mid-flight, and delegated
    { slug: 'alpha', created_at: hoursAgo(5), agent_calls: 3,
      agent_types: { Explore: 2, 'general-purpose': 1 },
      model_usage: { [OPUS5]: usage(4000), [FABLE]: usage(1000) } },
    { slug: 'alpha', created_at: hoursAgo(9), agent_calls: 0, agent_types: {},
      model_usage: { [OPUS5]: usage(2000) } },
    // a session recorded before the hook sent a breakdown: counted, but it
    // cannot claim a model. The denominator has to say so.
    { slug: 'bravo', created_at: hoursAgo(12), agent_calls: 0, agent_types: {}, model_usage: {} },
  ],
  projects, execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW,
});
check('sessions counted', withManual.manual.sessions, 3);
check('…and the ones that actually carried usage', withManual.manual.sessionsWithUsage, 2);
check('manual tokens summed', withManual.manual.tokens, 7000);
check('manual models, biggest first', withManual.manual.models.map((m) => m.label), ['opus-5', 'fable-5']);
check('a mid-session switch counts both', withManual.manual.models.find((m) => m.label === 'fable-5').sessions, 1);
check('delegations counted', [withManual.manual.delegatedSessions, withManual.manual.agentCalls], [1, 3]);
check('agent types ranked', withManual.manual.agentTypes, [{ type: 'Explore', count: 2 }, { type: 'general-purpose', count: 1 }]);

// The separation that matters — everything policy-shaped must be untouched.
check('worth is identical with or without sessions',
  JSON.stringify(withManual.worth), JSON.stringify(r.worth));
check('runs are identical', JSON.stringify(withManual.runs), JSON.stringify(r.runs));
check('assignments are identical',
  JSON.stringify(withManual.assignments), JSON.stringify(r.assignments));
check('the role-card model list is identical',
  JSON.stringify(withManual.models), JSON.stringify(r.models));

console.log('\n--- everyModel (the merged receipt) ---');
const byEvery = Object.fromEntries(withManual.everyModel.map((m) => [m.label, m]));
check('fable-5 is manual-only', [byEvery['fable-5'].source, byEvery['fable-5'].role], ['manual', '']);
check('sonnet-4-5 is autopilot-only', byEvery['sonnet-4-5'].source, 'autopilot');
check('opus-5 ran in both', byEvery['opus-5'].source, 'both');
// The regression this separation exists to prevent: a manual model must not
// arrive carrying a role, or the executor card renders it as drift.
check('no manual-only model carries a role',
  withManual.everyModel.filter((m) => m.source === 'manual' && m.role !== '').length, 0);
check('opus-5 tokens are the sum of both halves', byEvery['opus-5'].tokens, 300 + 6000);
check('shares are token-based and total 100',
  Math.round(withManual.everyModel.reduce((n, m) => n + m.share, 0)), 100);
check('a week with no sessions still returns the list', r.everyModel.length > 0, true);
check('…and every row of it is autopilot',
  r.everyModel.every((m) => m.source === 'autopilot'), true);



// --------------------------------------------------------------------------
// splitRunRoles — the shared attribution the throughput ledger (#269) uses.
// Alias match first, the old highest-token heuristic only as the fallback, and
// every token placed (the ledger is a two-bucket total that must reconcile).
// --------------------------------------------------------------------------
console.log('\n--- splitRunRoles (#269 attribution) ---');
const { splitRunRoles } = await import('../src/routes/control.js');
const roleOf = (out, model) => out.find((e) => e.model === model);

{
  // policy names both — the alias match decides, nothing is assumed
  const out = splitRunRoles({ [SONNET]: usage(800, 0.6), [OPUS5]: usage(200, 0.4) }, 'sonnet', 'claude-opus-5');
  check('on-policy: sonnet is exec', roleOf(out, SONNET).role, 'exec');
  check('on-policy: opus-5 is adv', roleOf(out, OPUS5).role, 'adv');
  check('on-policy: nothing assumed', out.some((e) => e.assumed), false);
}
{
  // THE FIX: the advisor genuinely outspent the executor this run. The old
  // heuristic called the biggest model the executor and got it backwards.
  const out = splitRunRoles({ [OPUS5]: usage(900, 0.9), [SONNET]: usage(100, 0.1) }, 'sonnet', 'claude-opus-5');
  check('advisor-heavy run: opus-5 still adv (heuristic would say exec)', roleOf(out, OPUS5).role, 'adv');
  check('advisor-heavy run: sonnet still exec', roleOf(out, SONNET).role, 'exec');
}
{
  // nothing matches (a run from before a policy change) — old behaviour intact
  const out = splitRunRoles({ [HAIKU]: usage(900, 0.9), ['claude-opus-4-1-20250101']: usage(100, 0.1) }, 'sonnet', 'claude-opus-5');
  check('off-policy: highest-token is exec', roleOf(out, HAIKU).role, 'exec');
  check('off-policy: the rest are adv', roleOf(out, 'claude-opus-4-1-20250101').role, 'adv');
  check('off-policy: both flagged assumed', out.every((e) => e.assumed), true);
}
{
  // executor on the CLI default: the advisor is named, the rest inferred
  const out = splitRunRoles({ [SONNET]: usage(800, 0.6), [OPUS5]: usage(200, 0.4) }, '', 'claude-opus-5');
  check('CLI-default exec: opus-5 named adv', roleOf(out, OPUS5).assumed, false);
  check('CLI-default exec: sonnet assumed exec', [roleOf(out, SONNET).role, roleOf(out, SONNET).assumed], ['exec', true]);
}
{
  // every token lands in a bucket — the ledger total must reconcile
  const mu = { [SONNET]: usage(500, 0.5), [HAIKU]: usage(400, 0.4), [OPUS5]: usage(100, 0.1) };
  const out = splitRunRoles(mu, 'sonnet', 'claude-opus-5');
  const placed = out.reduce((n, e) => n + e.tokens, 0);
  check('nothing is dropped', placed, 1000);
  check('all roles assigned', out.every((e) => e.role === 'exec' || e.role === 'adv'), true);
  check('unclaimed haiku goes to adv (exec already named)', roleOf(out, HAIKU).role, 'adv');
}
check('no model_usage yields nothing', splitRunRoles(null, 'sonnet', 'claude-opus-5'), []);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
