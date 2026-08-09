// Pins server/src/pulse.js — the Overview tab's three measured bands.
//
// Pure: no database, no API.   node server/test/pulse.test.mjs
//
// What these actually guard is one rule wearing five hats: ABSENT IS NOT ZERO.
// Every assertion below that looks pedantic is there because the alternative
// renders as a confident number nobody can source — a suite that never ran
// showing 0% passing, a run nobody reviewed showing clean, a session whose
// subagent transcript was lost showing free.

import assert from 'node:assert/strict';
import {
  entryTokens, usageEntries, shortModelName, weekStart,
  readUsage, readTests, readRuns, PULSE_WEEKS,
} from '../src/pulse.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

const DAY = 86400000;
const WEEK = 7 * DAY;
// A fixed Thursday, so nothing here depends on when the suite is run.
const NOW = Date.parse('2026-08-06T09:30:00Z');
const iso = (t) => new Date(t).toISOString();

// --- token arithmetic ------------------------------------------------------

test('entryTokens counts cache tokens — they were really billed', () => {
  assert.equal(entryTokens({
    inputTokens: 100, outputTokens: 20,
    cacheReadInputTokens: 4000, cacheCreationInputTokens: 900,
  }), 5020);
});

test('entryTokens tolerates a missing or malformed blob', () => {
  assert.equal(entryTokens(null), 0);
  assert.equal(entryTokens({}), 0);
  assert.equal(entryTokens({ inputTokens: 'x' }), 0);
});

test('usageEntries keeps a missing cost as null, never as $0', () => {
  const [a, b] = usageEntries({
    'claude-opus-5': { inputTokens: 10, outputTokens: 1, costUSD: 0.25 },
    'claude-haiku-4-5': { inputTokens: 5, outputTokens: 1 },
  });
  assert.equal(a.costUsd, 0.25);
  assert.equal(b.costUsd, null, 'no costUSD key must stay null — a transcript has no price');
});

test('usageEntries refuses an array or a scalar rather than inventing models', () => {
  assert.deepEqual(usageEntries([1, 2]), []);
  assert.deepEqual(usageEntries('opus'), []);
});

test('shortModelName drops the path and the date stamp', () => {
  assert.equal(shortModelName('us.anthropic.claude-opus-5-20260101'), 'us.anthropic.claude-opus-5');
  assert.equal(shortModelName('vendor/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(shortModelName(''), 'unknown');
});

test('weekStart lands on Monday UTC, and Sunday belongs to the week before', () => {
  const sunday = Date.parse('2026-08-09T23:59:00Z');
  const monday = Date.parse('2026-08-03T00:00:00Z');
  assert.equal(weekStart(sunday), monday);
  assert.equal(weekStart(monday), monday);
  assert.equal(weekStart(Date.parse('2026-08-10T00:00:00Z')), monday + WEEK);
});

// --- usage -----------------------------------------------------------------

const session = (o = {}) => ({
  created_at: iso(NOW), tokens_used: 0, model_usage: {}, agent_usage: {},
  agent_calls: 0, agents_recorded: 0, summary: '', ...o,
});
const run = (o = {}) => ({
  finished_at: iso(NOW), tokens: 0, cost_usd: 0, model_usage: null,
  item_title: '', outcome: 'landed', commits: 1,
  review_verdict: null, auto_verdict: null, ...o,
});

test('an empty window is not a quiet one — measured:false', () => {
  const u = readUsage({ sessions: [], runs: [], now: NOW });
  assert.equal(u.measured, false);
  assert.equal(u.tokens, 0);
  assert.equal(u.weeks.length, PULSE_WEEKS, 'the strip is still shaped, just not drawn');
});

test('the flat tokens_used column is a FALLBACK, never added to model_usage', () => {
  const u = readUsage({
    sessions: [session({
      tokens_used: 999,
      model_usage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 50 } },
    })],
    now: NOW,
  });
  assert.equal(u.tokens, 150, 'a modern row must not count twice');
});

test('a pre-#167 row with no breakdown still contributes its flat total', () => {
  const u = readUsage({ sessions: [session({ tokens_used: 999 })], now: NOW });
  assert.equal(u.tokens, 999);
  assert.equal(u.models.length, 0, 'but it can name no model, so it claims none');
});

test('a subagent transcript is added to the parent — it is the larger half', () => {
  const u = readUsage({
    sessions: [session({
      model_usage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 0 } },
      agent_usage: { 'claude-haiku-4-5': { inputTokens: 900, outputTokens: 0 } },
    })],
    now: NOW,
  });
  assert.equal(u.tokens, 1000);
  assert.equal(u.models.length, 2);
  assert.equal(u.models[0].label, 'claude-haiku-4-5', 'sorted by tokens, so the executor leads');
});

test('an interactive session is never priced, even if a blob carries a cost', () => {
  const u = readUsage({
    sessions: [session({ model_usage: { m: { inputTokens: 10, costUSD: 5 } } })],
    now: NOW,
  });
  assert.equal(u.costUsd, 0);
  assert.equal(u.pricedRuns, 0);
  assert.equal(u.models[0].costUsd, null, 'a transcript carries no cost — CLAUDE.md');
});

test('cost comes off runs, and pricedRuns says how much of the bill it is', () => {
  const u = readUsage({
    runs: [run({ cost_usd: '1.50', tokens: 10 }), run({ cost_usd: 0, tokens: 10 })],
    now: NOW,
  });
  assert.equal(u.costUsd, 1.5, 'NUMERIC comes back from pg as a STRING');
  assert.equal(u.pricedRuns, 1);
  assert.equal(u.runs, 2);
});

test('shares are TOKEN-based, because only half the population has a price', () => {
  const u = readUsage({
    sessions: [session({ model_usage: { a: { inputTokens: 300 } } })],
    runs: [run({ model_usage: { b: { inputTokens: 100, costUSD: 9 } } })],
    now: NOW,
  });
  const a = u.models.find((m) => m.model === 'a');
  const b = u.models.find((m) => m.model === 'b');
  assert.equal(Math.round(a.share), 75);
  assert.equal(Math.round(b.share), 25, 'a cost-weighted share would describe the autopilot alone');
});

test('the two populations are stacked separately, never blended', () => {
  const u = readUsage({
    sessions: [session({ tokens_used: 40 })],
    runs: [run({ tokens: 60 })],
    now: NOW,
  });
  assert.equal(u.interactiveTokens, 40);
  assert.equal(u.autoTokens, 60);
  const last = u.weeks[u.weeks.length - 1];
  assert.equal(last.interactive, 40);
  assert.equal(last.auto, 60);
});

test('weeks are zero-filled and Monday-keyed across the whole window', () => {
  const u = readUsage({
    sessions: [session({ created_at: iso(NOW - 3 * WEEK), tokens_used: 7 })],
    now: NOW,
  });
  assert.equal(u.weeks.length, PULSE_WEEKS);
  assert.equal(u.weeks.filter((w) => w.interactive > 0).length, 1);
  assert.equal(u.weeks[PULSE_WEEKS - 4].interactive, 7, 'three weeks back from the last column');
  assert.ok(u.weeks.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week)));
});

test('a row outside the window is dropped rather than clamped into an edge week', () => {
  const u = readUsage({
    sessions: [session({ created_at: iso(NOW - 40 * WEEK), tokens_used: 500 })],
    now: NOW,
  });
  assert.equal(u.weeks.reduce((n, w) => n + w.interactive, 0), 0, 'never piled onto week one');
  assert.equal(u.tokens, 500, 'but the total still counts what the query returned');
});

test('an unparseable timestamp is skipped, not turned into week zero', () => {
  const u = readUsage({ sessions: [session({ created_at: 'not-a-date', tokens_used: 5 })], now: NOW });
  assert.equal(u.tokens, 0);
});

test('delegations report calls AND recorded — a lost transcript is unpriced, not free', () => {
  const u = readUsage({
    sessions: [session({ agent_calls: 3, agents_recorded: 1 })],
    now: NOW,
  });
  assert.deepEqual(u.delegations, { calls: 3, recorded: 1 });
});

test('the median session ignores sessions that reported no tokens at all', () => {
  const u = readUsage({
    sessions: [
      session({ tokens_used: 0 }), session({ tokens_used: 10 }),
      session({ tokens_used: 20 }), session({ tokens_used: 30 }),
    ],
    now: NOW,
  });
  assert.equal(u.medianSessionTokens, 20, 'an unmeasured session is not a zero-token one');
});

test('recent is newest-first and capped', () => {
  const u = readUsage({
    sessions: Array.from({ length: 40 }, (_, i) =>
      session({ created_at: iso(NOW - i * DAY), tokens_used: i, summary: `s${i}` })),
    now: NOW,
  });
  assert.equal(u.recent.length, 24);
  assert.equal(u.recent[0].text, 's0');
});

// --- tests -----------------------------------------------------------------

const check = (o = {}) => ({ id: 1, name: 'c', last_status: 'pass', external: false, ...o });

test('no checks is no suite — not a suite at 0%', () => {
  const t = readTests({});
  assert.equal(t.measured, false);
  assert.equal(t.suite.passRate, null);
});

test('a suite that never ran reports passRate null, never 0', () => {
  const t = readTests({ checks: [check({ last_status: null })] });
  assert.equal(t.measured, true, 'the checks exist');
  assert.equal(t.suite.passRate, null, 'but nothing has run them');
  assert.equal(t.never, 1);
});

test('pass rate is summed across runs, not averaged across their percentages', () => {
  const t = readTests({
    checks: [check()],
    suiteRuns: [
      { total: 100, passed: 100, failed: 0, duration_ms: 1000, run_at: iso(NOW) },
      { total: 1, passed: 0, failed: 1, duration_ms: 2000, run_at: iso(NOW - DAY) },
    ],
  });
  assert.equal(Math.round(t.suite.passRate * 10) / 10, 99, 'averaging percentages gives 50%');
  assert.equal(t.suite.medianMs, 1500);
});

test('the last run is the newest by run_at, not the last row returned', () => {
  const t = readTests({
    checks: [check()],
    suiteRuns: [
      { total: 5, passed: 1, failed: 4, duration_ms: 1, run_at: iso(NOW - 5 * DAY) },
      { total: 5, passed: 5, failed: 0, duration_ms: 1, run_at: iso(NOW) },
      { total: 5, passed: 2, failed: 3, duration_ms: 1, run_at: iso(NOW - DAY) },
    ],
  });
  assert.equal(t.suite.lastPassed, 5);
  assert.equal(t.suite.lastAt, iso(NOW));
});

test('FLAKY means it has gone both ways — an always-failing check is broken', () => {
  const t = readTests({
    checks: [check({ id: 1, name: 'flaps' }), check({ id: 2, name: 'broken', last_status: 'fail' })],
    results: [
      { check_id: 1, status: 'fail' }, { check_id: 1, status: 'pass' }, { check_id: 1, status: 'fail' },
      { check_id: 2, status: 'fail' }, { check_id: 2, status: 'fail' }, { check_id: 2, status: 'fail' },
    ],
  });
  assert.deepEqual(t.flaky.map((f) => f.name), ['flaps']);
  assert.equal(t.flaky[0].flips, 2);
  assert.equal(t.failing, 1, 'the broken one is still counted as failing');
});

test('one result is not a flake — a check needs a history to have flipped', () => {
  const t = readTests({ checks: [check()], results: [{ check_id: 1, status: 'fail' }] });
  assert.deepEqual(t.flaky, []);
});

// --- runs ------------------------------------------------------------------

test('no runs is measured:false, not a project with a 0% land rate', () => {
  const r = readRuns({ runs: [] });
  assert.equal(r.measured, false);
  assert.equal(r.landRate, null);
});

test('the five outcomes partition across four buckets and sum to the total', () => {
  const r = readRuns({
    runs: [
      run({ outcome: 'landed' }), run({ outcome: 'failed' }), run({ outcome: 'limit' }),
      run({ outcome: 'planned' }), run({ outcome: 'no-commits' }),
    ],
  });
  assert.deepEqual(
    { landed: r.landed, failed: r.failed, planned: r.planned, noCommits: r.noCommits },
    { landed: 1, failed: 2, planned: 1, noCommits: 1 }
  );
  assert.equal(r.landed + r.failed + r.planned + r.noCommits, r.total);
});

test('a plan night commits nothing by design and sits out the land rate', () => {
  const r = readRuns({ runs: [run({ outcome: 'landed' }), run({ outcome: 'planned' })] });
  assert.equal(r.landRate, 100, 'folding the plan night in would score it as a failure to land');
  assert.equal(r.planned, 1, 'and it is still counted, in its own bucket');
});

test('a NULL review verdict is NO PASS RAN — its own bucket, never clean', () => {
  const r = readRuns({
    runs: [
      run({ review_verdict: 'clean' }), run({ review_verdict: null }),
      run({ review_verdict: '' }), run({ review_verdict: 'blocked' }),
    ],
  });
  assert.deepEqual(r.verdicts, { clean: 1, concerns: 0, blocked: 1, none: 2 });
});

test('auto_verdict counts only runs that actually gave one', () => {
  const r = readRuns({
    runs: [run({ auto_verdict: 'checks green, low risk' }), run({ auto_verdict: null }), run({ auto_verdict: '  ' })],
  });
  assert.equal(r.autoVerdictRuns, 1);
});

console.log(`pulse: ${passed} assertions passed`);
