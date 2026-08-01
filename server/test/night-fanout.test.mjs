// #266 — nights fan out as one job per item, not one job per project. This
// pins the two pure helpers that make that safe and the structural fact that
// only the NIGHTLY enqueue uses them.
//
//   node server/test/night-fanout.test.mjs      # exits non-zero on any failure
//
// No database: splitNightBudget/nightFanOut are pure precisely so this is
// possible (importing routes/autopilot.js does not connect to Postgres — it
// only queries lazily, once a route handler runs). A wrong split either
// starves a fanned-out job below the runner's own floor (MIN_JOB_TOKENS,
// silently rounded back up — the night overspends what it was budgeted) or
// drops a fraction of the night's token budget on the floor (the night
// underspends what it was given). Both are silent unless pinned here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MIN_JOB_TOKENS, splitNightBudget, nightFanOut } from '../src/routes/autopilot.js';

let fails = 0;
const ok = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${pass ? '' : `  (want ${JSON.stringify(want)})`}`);
};
const assertTrue = (label, cond) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
};

// --------------------------------------------------------------------------
// splitNightBudget — the total stays honest.
// --------------------------------------------------------------------------
console.log('--- splitNightBudget: the sum is exact ---');
for (const [total, n] of [[1_500_000, 7], [100, 3], [1, 5], [999_999, 4], [50_000, 1]]) {
  const shares = splitNightBudget(total, n);
  ok(`(${total}, ${n}) length`, shares.length, n);
  ok(`(${total}, ${n}) sum`, shares.reduce((a, b) => a + b, 0), total);
  const max = Math.max(...shares);
  const min = Math.min(...shares);
  assertTrue(`(${total}, ${n}) shares within 1 of each other (max ${max} min ${min})`, max - min <= 1);
}

console.log('\n--- splitNightBudget: the remainder goes to the front ---');
ok('splitNightBudget(100, 3)', splitNightBudget(100, 3), [34, 33, 33]);

console.log('\n--- splitNightBudget: edges ---');
// total 0 means unlimited, so an unlimited night must hand every job an
// unlimited share (0), NOT a share of nothing divided evenly.
ok('total 0 (unlimited) -> every share 0', splitNightBudget(0, 4), [0, 0, 0, 0]);
ok('n <= 0 -> []', splitNightBudget(1_000_000, 0), []);
ok('n negative -> []', splitNightBudget(1_000_000, -3), []);
// Negative total takes the same branch as unlimited (total <= 0) — pinned so
// a future change to that branch has to notice it moves this too.
ok('negative total behaves like unlimited', splitNightBudget(-500, 3), [0, 0, 0]);

// --------------------------------------------------------------------------
// nightFanOut — the fan-out is bounded on every axis.
// --------------------------------------------------------------------------
console.log('\n--- nightFanOut: bounds ---');
ok('bounded by maxItems', nightFanOut(3, 10, 0), 3);
ok('bounded by what is eligible', nightFanOut(5, 2, 0), 2);
ok('nothing eligible -> 0', nightFanOut(5, 0, 0), 0);
ok('maxItems 0 (unlimited) capped at 20', nightFanOut(0, 50, 0), 20);
ok('maxItems above the ceiling capped at 20', nightFanOut(99, 50, 0), 20);

console.log('\n--- nightFanOut: the budget floor bites ---');
// 120,000 tokens / MIN_JOB_TOKENS (50,000) = 2.4 -> floor 2. A 10-way fan-out
// would hand each job 12,000 tokens, which the runner rounds back up to
// MIN_JOB_TOKENS, quietly spending 5x the night's budget.
ok('a 120k-token night with 10 eligible and maxItems 10 funds only 2 jobs',
  nightFanOut(10, 10, 120_000), Math.max(1, Math.floor(120_000 / MIN_JOB_TOKENS)));
ok('…which is 2, not 10', nightFanOut(10, 10, 120_000), 2);
ok('the floor never takes fan-out below 1 (tiny non-zero budget)', nightFanOut(5, 5, 1), 1);
ok('an unlimited budget (0) does not apply the floor', nightFanOut(5, 5, 0), 5);

console.log('\n--- nightFanOut + splitNightBudget: no job is underfunded, none overfunded ---');
// THE INVARIANT THAT MATTERS: whatever nightFanOut decides, splitting the
// same budget across that many jobs must never hand one of them less than
// the runner's own floor, and must still total exactly the night's budget —
// EXCEPT when the whole night's budget is itself below the floor, in which
// case there is no way to split it and still meet the floor. nightFanOut
// still returns 1 rather than 0 there (a tiny budget must not silently
// disable the autopilot) and hands that one job the WHOLE budget; the
// runner's own 50k floor is what it actually ends up running at, not what
// this record shows funded. So the property has two arms:
//   tokens >= MIN_JOB_TOKENS  -> every share >= MIN_JOB_TOKENS
//   0 < tokens < MIN_JOB_TOKENS -> exactly one job, funded with the whole
//                                   (sub-floor) budget
// and in both arms the shares still sum to exactly `tokens`.
const combos = [];
for (const maxItems of [0, 1, 2, 3, 5, 10, 20, 99]) {
  for (const eligible of [0, 1, 2, 5, 10, 30]) {
    for (const tokens of [0, 1, 100, 49_999, 50_000, 50_001, 99_999, 120_000, 1_000_000, 1_500_000, 3_000_000]) {
      combos.push([maxItems, eligible, tokens]);
    }
  }
}
let atOrAboveFloor = 0;
let belowFloor = 0;
for (const [maxItems, eligible, tokens] of combos) {
  const n = nightFanOut(maxItems, eligible, tokens);
  if (tokens <= 0 || n <= 0) continue;
  const shares = splitNightBudget(tokens, n);
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum !== tokens) {
    fails++;
    console.log(`FAIL  sum mismatch for (${maxItems}, ${eligible}, ${tokens}) n=${n}: got ${sum} want ${tokens}`);
  }
  if (tokens >= MIN_JOB_TOKENS) {
    atOrAboveFloor++;
    const under = shares.some((s) => s < MIN_JOB_TOKENS);
    if (under) {
      fails++;
      console.log(`FAIL  underfunded share for (${maxItems}, ${eligible}, ${tokens}) n=${n}: ${JSON.stringify(shares)}`);
    }
  } else {
    belowFloor++;
    if (n !== 1 || shares.length !== 1 || shares[0] !== tokens) {
      fails++;
      console.log(`FAIL  sub-floor budget for (${maxItems}, ${eligible}, ${tokens}) should fund exactly 1 job with the whole budget, got n=${n} shares=${JSON.stringify(shares)}`);
    }
  }
}
assertTrue(`property held: ${atOrAboveFloor} combinations at/above the floor, ${belowFloor} below it (of ${combos.length} total)`, true);

// --------------------------------------------------------------------------
// STRUCTURAL guard: the fan-out belongs to the nightly enqueue and nothing
// else. This section reads the SOURCE, not the behaviour — its only job is
// to make a future change that fans the plan sweep (or an audit sweep) out
// fail loudly here rather than silently drifting away from the design.
// --------------------------------------------------------------------------
console.log('\n--- structural: fan-out applies to the nightly enqueue only ---');
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/routes/autopilot.js'), 'utf8');

// The nightly INSERT: carries night_date and token_budget together with the
// 'nightly' kind — that is the one enqueue statement the fan-out feeds.
const nightlyInsertRe = /INSERT INTO autopilot_jobs \(project_id, kind, night_date, item_id, token_budget\)[\s\S]*?'nightly'/;
const nightlyMatch = src.match(nightlyInsertRe);
assertTrue('the nightly INSERT carries night_date + token_budget + \'nightly\'', !!nightlyMatch);

// The plan sweep's INSERT: single row per project, selecting 'plan','plan',
// and it must not mention token_budget, row_number, or the fan-out helpers.
const planInsertRe = /INSERT INTO autopilot_jobs \(project_id, kind, session_kind\)\s*SELECT p\.id, 'plan', 'plan'[\s\S]*?ON CONFLICT DO NOTHING/;
const planMatch = src.match(planInsertRe);
assertTrue('the plan sweep INSERT is the single-row-per-project form', !!planMatch);
if (planMatch) {
  const stmt = planMatch[0];
  assertTrue('…and does not mention token_budget', !stmt.includes('token_budget'));
  assertTrue('…and does not mention row_number (no fan-out ranking)', !stmt.includes('row_number'));
  assertTrue('…and never calls nightFanOut', !stmt.includes('nightFanOut'));
  assertTrue('…and never calls splitNightBudget', !stmt.includes('splitNightBudget'));
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
