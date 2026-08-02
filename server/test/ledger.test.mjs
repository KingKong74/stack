// #269 — the throughput ledger, tested against the REAL export (not a
// replica) and the shapes autopilot_runs/autopilot_jobs actually store.
//
//   node server/test/ledger.test.mjs      # exits non-zero on any failure
//
// No database and no framework: computeLedger is pure precisely so this is
// possible. It is the one piece of #269 where a wrong answer is silent — a
// trend that quietly drifts looks exactly like a fleet that is fine.
import { computeLedger } from '../src/routes/control.js';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const usage = (tok, cost) => ({ inputTokens: tok, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost });

const SONNET = 'claude-sonnet-4-5-20250929';
const OPUS5 = 'claude-opus-5-20260115';
const HAIKU = 'claude-haiku-4-5-20251001';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};

// ----------------------------------------------------------------------
// runRows for the days/window/noCommitRate/perNight arithmetic. Every
// tokens/cost_usd is a STRING, exactly what pg hands back for BIGINT/NUMERIC.
// ----------------------------------------------------------------------
const R_OLD = { outcome: 'landed', tokens: '700', cost_usd: '0.70', finished_at: '2026-07-13T10:00:00Z' };            // day -13 (oldest bucket)
const R_PLANNED = { outcome: 'planned', tokens: '500', cost_usd: '0.50', finished_at: '2026-07-20T10:00:00Z' };       // day -6, ALONE on its day
const R_D2 = { outcome: 'landed', tokens: '1000', cost_usd: '1.00', finished_at: '2026-07-21T10:00:00Z' };            // day -5
const R_D1_LANDED = { outcome: 'landed', tokens: '3000', cost_usd: '3.00', finished_at: '2026-07-23T10:00:00Z' };     // day -3
const R_D1_NOCOMMIT = { outcome: 'no-commits', tokens: '0', cost_usd: '0', finished_at: '2026-07-23T11:00:00Z' };     // day -3, same day

const runRows = [R_OLD, R_PLANNED, R_D2, R_D1_LANDED, R_D1_NOCOMMIT];

const jobRows = [
  // merges — only 'done' rows count at all; the 'auto-merge' detail prefix is
  // the ONLY record of which merges the runner made itself (#212).
  { kind: 'merge', status: 'done', detail: 'auto-merge: item 42 (green)', created_at: '2026-07-24T12:00:00Z' },       // recent, auto
  { kind: 'merge', status: 'done', detail: 'merge origin/auto/item-42 into main', created_at: '2026-07-23T12:00:00Z' }, // recent, human
  { kind: 'merge', status: 'queued', detail: 'auto-merge: pending', created_at: '2026-07-25T12:00:00Z' },             // not done — excluded entirely
  // reverts — autopilot_jobs carries no finished_at column at all; half()'s
  // fallback to created_at is the only thing that can classify these.
  { kind: 'revert', created_at: '2026-07-24T12:00:00Z' },   // recent (2 days ago)
  { kind: 'revert', created_at: '2026-07-16T12:00:00Z' },   // prev (10 days ago)
];

const verdictRows = [
  { review_tag: 'solid', finished_at: '2026-07-25T10:00:00Z' },      // recent (1 day ago)
  { review_tag: 'solid', finished_at: '2026-07-21T10:00:00Z' },      // recent (5 days ago)
  { review_tag: 'needs-work', finished_at: '2026-07-14T10:00:00Z' }, // prev (12 days ago)
];

const ledger = computeLedger({ runRows, jobRows, verdictRows, execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW });

console.log('--- days (14 buckets, oldest first) ---');
check('exactly 14 buckets', ledger.days.length, 14);
check('oldest first', ledger.days[0].day, '2026-07-13');
check('today last', ledger.days[13].day, '2026-07-26');
const byDay = Object.fromEntries(ledger.days.map((d) => [d.day, d]));
check('oldest day carries its run', byDay['2026-07-13'], { day: '2026-07-13', landed: 1, runs: 1, tokens: 700, costUsd: 0.70 });
check('a day with no runs is a present zero row, not omitted',
  byDay['2026-07-16'], { day: '2026-07-16', landed: 0, runs: 0, tokens: 0, costUsd: 0 });
check('a day whose only run was PLANNED reads as zero too — excluded from days, not just window',
  byDay['2026-07-20'], { day: '2026-07-20', landed: 0, runs: 0, tokens: 0, costUsd: 0 });
check('a day with two runs (one landed, one no-commits) sums tokens across both',
  byDay['2026-07-23'], { day: '2026-07-23', landed: 1, runs: 2, tokens: 3000, costUsd: 3.00 });

console.log('\n--- planned runs excluded from every metric (#219) ---');
// R_PLANNED sits alone on 2026-07-20 (6 days ago — inside the 7-day "now"
// window). Dropping it from the fixture entirely must not move `now` at all;
// if it were counted, its day would add a third active night (nights: 2 -> 3)
// and a fourth row to the denominator (noCommitRate: 1/3 -> 1/4).
const withoutPlanned = computeLedger({
  runRows: runRows.filter((r) => r !== R_PLANNED), jobRows, verdictRows,
  execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW,
});
check('the planned run changes nothing in `now`', JSON.stringify(ledger.now), JSON.stringify(withoutPlanned.now));
check('noCommitRate: 1 no-commits of 3 (landed×2 + no-commits×1) — not /4', ledger.now.noCommitRate, 1 / 3);
check('perNight: 2 landed over 2 active nights — not /7, not /3', ledger.now.perNight, 1);

console.log('\n--- tokensPerItem / costPerItem: string BIGINT/NUMERIC coerced, not concatenated ---');
check('tokensPerItem sums LANDED tokens only, over landed count', ledger.now.tokensPerItem, 2000);
check('costPerItem sums LANDED cost only, over landed count', ledger.now.costPerItem, 2.00);
check('both are numbers, not the string-concatenation bug', typeof ledger.now.tokensPerItem, 'number');

console.log('\n--- merges ---');
check('merges.now.total counts both DONE merges (auto + human)', ledger.merges.now.total, 2);
check('merges.now.auto counts only the auto-merge-prefixed one', ledger.merges.now.auto, 1);

console.log('\n--- reverts: created_at, not finished_at (autopilot_jobs has no finished_at) ---');
check('reverts.now (2 days ago)', ledger.reverts.now, 1);
check('reverts.prev (10 days ago)', ledger.reverts.prev, 1);

console.log('\n--- reverts: rate carries a direction, and a denominator ---');
// A dedicated fixture: 4 runs land in the recent half, one revert alongside
// them, so the rate (0.25) reads as something a raw count of 1 could not.
const rateRuns = [
  { outcome: 'landed', tokens: '100', cost_usd: '0.10', finished_at: '2026-07-24T09:00:00Z' },
  { outcome: 'landed', tokens: '100', cost_usd: '0.10', finished_at: '2026-07-24T10:00:00Z' },
  { outcome: 'landed', tokens: '100', cost_usd: '0.10', finished_at: '2026-07-24T11:00:00Z' },
  { outcome: 'landed', tokens: '100', cost_usd: '0.10', finished_at: '2026-07-24T12:00:00Z' },
];
const rateJobs = [{ kind: 'revert', created_at: '2026-07-24T12:00:00Z' }];
const rateLedger = computeLedger({
  runRows: rateRuns, jobRows: rateJobs, verdictRows: [], execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW,
});
check('reverts.rateNow: 1 revert over 4 landed', rateLedger.reverts.rateNow, 0.25);

console.log('\n--- reverts.rateNow is null, not 0, with no landed denominator ---');
// A revert alongside a night that landed nothing — the rate over a zero
// denominator must read as unknown, not as a suspiciously perfect zero.
const noLandedRuns = [
  { outcome: 'no-commits', tokens: '0', cost_usd: '0', finished_at: '2026-07-24T10:00:00Z' },
];
const noLandedJobs = [{ kind: 'revert', created_at: '2026-07-24T12:00:00Z' }];
const noLandedLedger = computeLedger({
  runRows: noLandedRuns, jobRows: noLandedJobs, verdictRows: [], execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW,
});
check('a revert with nothing landed reads as null, never 0', noLandedLedger.reverts.rateNow, null);
if (noLandedLedger.reverts.rateNow !== null) {
  fails++;
  console.log(`FAIL  reverts.rateNow must be === null (strict), got ${JSON.stringify(noLandedLedger.reverts.rateNow)}`);
} else {
  console.log('ok    reverts.rateNow === null (strict)');
}

console.log('\n--- firstPass: 14-day totals unchanged ---');
check('solid over every verdicted row', { solid: ledger.firstPass.solid, verdicted: ledger.firstPass.verdicted }, { solid: 2, verdicted: 3 });

console.log('\n--- firstPass: now/prev split on finished_at ---');
check('firstPass.now: the two recent solids', ledger.firstPass.now, { solid: 2, verdicted: 2 });
check('firstPass.prev: the one older needs-work', ledger.firstPass.prev, { solid: 0, verdicted: 1 });
check('firstPass.solid equals now.solid + prev.solid', ledger.firstPass.solid, ledger.firstPass.now.solid + ledger.firstPass.prev.solid);
check('firstPass.verdicted equals now.verdicted + prev.verdicted', ledger.firstPass.verdicted, ledger.firstPass.now.verdicted + ledger.firstPass.prev.verdicted);

console.log('\n--- firstPass.prev.verdicted is 0 with no older verdicts — the client\'s "no arrow" case ---');
const fpAllRecent = [
  { review_tag: 'solid', finished_at: '2026-07-25T10:00:00Z' },
];
const fpAllRecentLedger = computeLedger({
  runRows: [], jobRows: [], verdictRows: fpAllRecent, execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW,
});
check('firstPass.prev.verdicted === 0 when nothing older exists', fpAllRecentLedger.firstPass.prev.verdicted, 0);

console.log('\n--- roles: executor/advisor split by alias, assumed only for neither ---');
const roleRows = [
  // on-policy: sonnet claims exec, opus-5 claims adv — neither assumed
  { outcome: 'landed', tokens: '1000', cost_usd: '1.00', finished_at: '2026-07-25T10:00:00Z',
    model_usage: { [SONNET]: usage(800, 0.60), [OPUS5]: usage(200, 0.40) } },
  // a model the policy names for NEITHER role — splitRunRoles' fallback names
  // it exec (nothing claimed exec yet on this row) and flags it assumed.
  { outcome: 'landed', tokens: '300', cost_usd: '0.30', finished_at: '2026-07-25T11:00:00Z',
    model_usage: { [HAIKU]: usage(300, 0.30) } },
];
const rolesLedger = computeLedger({ runRows: roleRows, execAlias: 'sonnet', advAlias: 'claude-opus-5', now: NOW });
check('roles.executor.tokens: sonnet (800, on-policy) + haiku (300, assumed)', rolesLedger.roles.executor.tokens, 1100);
check('roles.executor.costUsd', Number(rolesLedger.roles.executor.costUsd.toFixed(2)), 0.90);
check('roles.advisor.tokens: opus-5 only', rolesLedger.roles.advisor.tokens, 200);
check('roles.advisor.costUsd', Number(rolesLedger.roles.advisor.costUsd.toFixed(2)), 0.40);
check('roles.assumed accumulates ONLY the haiku row', rolesLedger.roles.assumed.tokens, 300);
check('roles.assumed.costUsd', Number(rolesLedger.roles.assumed.costUsd.toFixed(2)), 0.30);
// The on-policy row's tokens must NOT be counted as assumed.
check('sonnet/opus-5 are not in assumed', rolesLedger.roles.assumed.tokens < rolesLedger.roles.executor.tokens + rolesLedger.roles.advisor.tokens, true);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
