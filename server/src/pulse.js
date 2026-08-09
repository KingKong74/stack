// A project's PULSE — the arithmetic behind the Overview tab's three measured
// bands: what the models spent here, what the test suite is doing, and how the
// autopilot's runs came out. Pure and DB-free (the same shape as debrief.js),
// so `server/test/pulse.test.mjs` can pin every rule without a database.
//
// The route is `GET /api/projects/:slug/pulse` in routes/projects.js. It is a
// READ LAYER: a handful of aggregate queries, never one query per thing.
//
// FIVE RULES THIS FILE EXISTS TO HOLD. Four of them are the same rule wearing
// different clothes — absent is not zero — which is the one thing a dashboard
// gets wrong in a way that costs you a decision:
//
//  1. AN EMPTY WINDOW IS NOT A QUIET ONE. Every block returns `measured: false`
//     when nothing in the window carried the thing being measured, and the
//     client draws that as ABSENT rather than as a row of zeroes. A suite that
//     has never run is not a suite at 0% passing.
//  2. SPEND IS COST WHERE THERE IS COST, AND TOKENS EVERYWHERE ELSE. An
//     interactive session's transcript carries no price (CLAUDE.md, the Roles
//     room), so the two populations MERGE ON TOKENS and cost is reported only
//     over the rows that actually priced themselves — with `pricedRuns` beside
//     it, so a $12 figure never reads as the whole bill.
//  3. THE TWO POPULATIONS ARE NAMED, NEVER BLENDED INTO ONE BAR. Interactive
//     sessions and autopilot runs answer to different policies; the weekly
//     strip stacks them as two tones and the totals say which is which. Same
//     rule the Roles room holds fleet-wide.
//  4. A NULL REVIEW VERDICT IS `none`, WHICH MEANS NO PASS RAN — counted in its
//     own bucket and never folded into `clean`. A run nobody reviewed is not a
//     run that came back clean.
//  5. A DELEGATION THAT LEFT NO TRANSCRIPT IS UNPRICED, NOT FREE. `calls` and
//     `recorded` are both reported, because a subagent's usage lives in its own
//     transcript and a lost one reads as missing, not as nothing.
//
// The token sum matches computeFleetRoles() in routes/control.js exactly —
// input + output + both cache columns. A narrower sum here would have the
// Overview tab and the Roles room quoting different totals for the same night.

/** The window every block is measured over. */
export const PULSE_DAYS = 84;   // 12 weeks, the strip's width
export const PULSE_WEEKS = 12;

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Tokens on one `model_usage` entry. Cache reads and cache creation are real
 * tokens that were really billed; leaving them out understates a cache-heavy
 * session by most of its actual size.
 */
export function entryTokens(u) {
  if (!u || typeof u !== 'object') return 0;
  return num(u.inputTokens) + num(u.outputTokens)
    + num(u.cacheReadInputTokens) + num(u.cacheCreationInputTokens);
}

/** Every model in a `model_usage` blob, with its tokens and (maybe) its cost. */
export function usageEntries(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return [];
  return Object.entries(blob).map(([model, u]) => ({
    model,
    tokens: entryTokens(u),
    // A transcript has no price. `null` keeps that distinct from a genuine $0.
    costUsd: u && u.costUSD !== undefined && u.costUSD !== null ? num(u.costUSD) : null,
  }));
}

/**
 * A model id shortened for a label — the last path segment, minus a trailing
 * date stamp. Deliberately NOT imported from control.js: this runs over a
 * different population and a shared helper there would tie a read layer to a
 * room's private formatting. Both are cosmetic and neither is stored.
 */
export function shortModelName(model) {
  const tail = String(model || '').split('/').pop() || '';
  return tail.replace(/-\d{8}$/, '') || 'unknown';
}

/** Midnight UTC on the Monday of the week containing `t`. */
export function weekStart(t) {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay(): 0 = Sunday. Monday-based weeks put Sunday six days in.
  const back = (d.getUTCDay() + 6) % 7;
  return d.getTime() - back * DAY_MS;
}

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// ---------------------------------------------------------------------------
// usage — what the models spent on this project
// ---------------------------------------------------------------------------

/**
 * Fold interactive sessions and autopilot runs into one usage read.
 *
 * `sessions` rows: { created_at, tokens_used, model_usage, agent_usage,
 *                    agent_calls, agents_recorded, summary, model }
 * `runs` rows:     { finished_at, tokens, cost_usd, model_usage, item_title, outcome }
 *
 * A session's tokens come from `model_usage` + `agent_usage` when it carries
 * them, and fall back to the flat `tokens_used` when it doesn't — the flat
 * column is the older, coarser measure and is the only thing a pre-#167 row
 * has. Falling back rather than adding is what stops a modern row counting
 * twice.
 */
export function readUsage({ sessions = [], runs = [], now = Date.now() } = {}) {
  const from = weekStart(now - (PULSE_WEEKS - 1) * WEEK_MS);
  const weeks = [];
  const byWeek = new Map();
  for (let i = 0; i < PULSE_WEEKS; i++) {
    const start = from + i * WEEK_MS;
    const row = { week: isoDay(start), interactive: 0, auto: 0 };
    weeks.push(row);
    byWeek.set(start, row);
  }
  const put = (at, key, tokens) => {
    const row = byWeek.get(weekStart(at));
    if (row) row[key] += tokens;
  };

  const models = new Map();
  const bump = (model, tokens, costUsd, population) => {
    if (!models.has(model)) {
      models.set(model, {
        model, label: shortModelName(model), tokens: 0,
        costUsd: 0, priced: false, sessions: 0, runs: 0, lastAt: 0,
      });
    }
    const m = models.get(model);
    m.tokens += tokens;
    if (costUsd !== null) { m.costUsd += costUsd; m.priced = true; }
    m[population] += 1;
    return m;
  };

  let interactiveTokens = 0, autoTokens = 0;
  let costUsd = 0, pricedRuns = 0;
  let calls = 0, recorded = 0;
  const sessionSizes = [];
  const recent = [];

  for (const s of sessions) {
    const at = new Date(s.created_at).getTime();
    if (!Number.isFinite(at)) continue;
    const entries = [...usageEntries(s.model_usage), ...usageEntries(s.agent_usage)];
    const measured = entries.reduce((n, e) => n + e.tokens, 0);
    // The flat column is a FALLBACK, never an addition — see the doc comment.
    const tokens = measured > 0 ? measured : num(s.tokens_used);

    interactiveTokens += tokens;
    if (tokens > 0) sessionSizes.push(tokens);
    put(at, 'interactive', tokens);
    calls += num(s.agent_calls);
    recorded += num(s.agents_recorded);

    for (const e of entries) {
      // An interactive session is never priced (CLAUDE.md: a transcript carries
      // no cost), so its cost is not offered even if a blob happens to hold one.
      const m = bump(e.model, e.tokens, null, 'sessions');
      m.lastAt = Math.max(m.lastAt, at);
    }
    recent.push({
      kind: 'session',
      at: new Date(at).toISOString(),
      models: entries.map((e) => e.model),
      text: String(s.summary || '').trim(),
      tokens,
    });
  }

  for (const r of runs) {
    const at = new Date(r.finished_at).getTime();
    if (!Number.isFinite(at)) continue;
    const entries = usageEntries(r.model_usage);
    const measured = entries.reduce((n, e) => n + e.tokens, 0);
    const tokens = measured > 0 ? measured : num(r.tokens);
    const runCost = num(r.cost_usd);

    autoTokens += tokens;
    put(at, 'auto', tokens);
    costUsd += runCost;
    if (runCost > 0) pricedRuns += 1;

    for (const e of entries) {
      const m = bump(e.model, e.tokens, e.costUsd, 'runs');
      m.lastAt = Math.max(m.lastAt, at);
    }
    recent.push({
      kind: 'run',
      at: new Date(at).toISOString(),
      models: entries.map((e) => e.model),
      text: String(r.item_title || '').trim(),
      tokens,
    });
  }

  const tokens = interactiveTokens + autoTokens;
  // Shares are TOKEN-based even where cost exists, because only half the
  // population has a price and a cost-weighted share would silently describe
  // the autopilot alone. Same rule as the Roles room's merged shares.
  const modelList = [...models.values()]
    .map((m) => ({
      model: m.model, label: m.label, tokens: m.tokens,
      costUsd: m.priced ? Math.round(m.costUsd * 100) / 100 : null,
      sessions: m.sessions, runs: m.runs,
      share: tokens > 0 ? (m.tokens / tokens) * 100 : 0,
      lastAt: new Date(m.lastAt).toISOString(),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  recent.sort((a, b) => (a.at < b.at ? 1 : -1));

  return {
    // Nothing ran here in twelve weeks. The client draws the whole band absent
    // rather than a chart of twelve empty columns.
    measured: sessions.length > 0 || runs.length > 0,
    weeks,
    sessions: sessions.length,
    runs: runs.length,
    tokens,
    interactiveTokens,
    autoTokens,
    medianSessionTokens: median(sessionSizes),
    // Priced runs only. `pricedRuns` of `runs` is what stops this reading as
    // the project's whole bill.
    costUsd: Math.round(costUsd * 100) / 100,
    pricedRuns,
    delegations: { calls, recorded },
    models: modelList,
    recent: recent.slice(0, 24),
  };
}

// ---------------------------------------------------------------------------
// tests — the suite, which is the evidence #212 and #263 spend
// ---------------------------------------------------------------------------

/**
 * `checks` rows: { id, name, last_status, external }
 * `suiteRuns`:   { total, passed, failed, duration_ms, run_at }  (scope='all')
 * `results`:     { check_id, status }  — newest first, per check
 *
 * FLAKY MEANS IT HAS GONE BOTH WAYS. A check that has failed every time is
 * BROKEN, not flaky, and calling it flaky is how a real regression gets filed
 * under "known noise" and left alone.
 */
export function readTests({ checks = [], suiteRuns = [], results = [] } = {}) {
  const byCheck = new Map();
  for (const r of results) {
    if (!byCheck.has(r.check_id)) byCheck.set(r.check_id, []);
    byCheck.get(r.check_id).push(r.status);
  }

  const flaky = [];
  for (const c of checks) {
    const hist = byCheck.get(c.id) || [];
    if (hist.length < 2) continue;
    const passes = hist.filter((s) => s === 'pass').length;
    if (passes === 0 || passes === hist.length) continue;   // broken or clean, not flaky
    let flips = 0;
    for (let i = 1; i < hist.length; i++) if (hist[i] !== hist[i - 1]) flips += 1;
    flaky.push({ name: c.name, flips, of: hist.length });
  }
  flaky.sort((a, b) => b.flips - a.flips);

  const totals = suiteRuns.reduce(
    (acc, r) => ({ total: acc.total + num(r.total), passed: acc.passed + num(r.passed) }),
    { total: 0, passed: 0 }
  );
  const last = suiteRuns.length
    ? suiteRuns.reduce((a, b) => (new Date(a.run_at) > new Date(b.run_at) ? a : b))
    : null;

  return {
    // A project with no checks has not got a green suite; it has no suite. The
    // client says exactly that, and offers to seed one.
    measured: checks.length > 0,
    checks: checks.length,
    failing: checks.filter((c) => c.last_status === 'fail').length,
    // NEVER RUN is its own state, the same rule as a NULL review_verdict — an
    // unprobed check is not a passing one.
    never: checks.filter((c) => !c.last_status).length,
    external: checks.filter((c) => c.external).length,
    suite: {
      // No suite run in the window. `passRate: null` renders as NO RUN, not 0%.
      runs: suiteRuns.length,
      passRate: totals.total > 0 ? (totals.passed / totals.total) * 100 : null,
      medianMs: median(suiteRuns.map((r) => num(r.duration_ms)).filter((n) => n > 0)),
      lastAt: last ? new Date(last.run_at).toISOString() : null,
      lastPassed: last ? num(last.passed) : null,
      lastTotal: last ? num(last.total) : null,
    },
    flaky: flaky.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// runs — how the autopilot's nights on this project came out
// ---------------------------------------------------------------------------

/**
 * The five outcomes partition across FOUR buckets, exactly as debrief.js does
 * it fleet-wide: landed / failed (failed + limit) / planned / noCommits, which
 * always sum to `total`. Spelt here rather than imported because debrief.js
 * composes a NIGHT (one day, cross-project) and this composes a PROJECT over
 * twelve weeks — but the partition is the same one, and if that one ever
 * changes this changes with it.
 *
 * A PLAN NIGHT COMMITS NOTHING BY DESIGN, so it can never be `landed` and sits
 * out the land rate entirely. Folding it in scores the advisor as having failed
 * to land runs nobody asked it to land.
 */
export function readRuns({ runs = [] } = {}) {
  const bucket = { landed: 0, failed: 0, planned: 0, noCommits: 0 };
  const verdicts = { clean: 0, concerns: 0, blocked: 0, none: 0 };
  let autoVerdictRuns = 0;
  let commits = 0;

  for (const r of runs) {
    if (r.outcome === 'landed') bucket.landed += 1;
    else if (r.outcome === 'failed' || r.outcome === 'limit') bucket.failed += 1;
    else if (r.outcome === 'planned') bucket.planned += 1;
    else bucket.noCommits += 1;
    commits += num(r.commits);

    // NULL = NO PASS RAN. Its own bucket, never folded into clean.
    const v = r.review_verdict;
    if (v === 'clean' || v === 'concerns' || v === 'blocked') verdicts[v] += 1;
    else verdicts.none += 1;

    // #263's own receipt, and it lives on the RUN. NULL means no auto-verdict
    // was given — which is not the same as one that was refused, and says
    // nothing about whether the run was good. A normal/high-risk item never
    // attempts one at all.
    if (String(r.auto_verdict || '').trim()) autoVerdictRuns += 1;
  }

  const landable = bucket.landed + bucket.failed + bucket.noCommits;
  return {
    measured: runs.length > 0,
    total: runs.length,
    ...bucket,
    commits,
    // Over the runs that COULD land — plan nights excluded, per the doc comment.
    landRate: landable > 0 ? (bucket.landed / landable) * 100 : null,
    verdicts,
    autoVerdictRuns,
  };
}
