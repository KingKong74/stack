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

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
