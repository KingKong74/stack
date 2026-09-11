// THE QUALITY PAGE'S PURE HALF — every number the screen shows, derived here so
// the rail's badge and the screen behind it cannot disagree (#497).
//
// `detail/Quality.tsx` renders these and writes through `store.ts`; nothing in
// this file fetches, and `scripts/quality.test.mjs` is its regression net. That
// split is not tidiness: checks are Stack's ONLY automated regression net and a
// green suite is what #212 auto-merge and #263 auto-verdict spend, so the
// arithmetic that decides "is this suite green" is worth pinning.
//
// ---- THE SEVERITY MAPPING (the decision the mockup left owing) -------------
//
// The console kit grades everything on five words — blocking · broken ·
// degraded · flaky · cosmetic — and Stack stores NONE of them. `bugs.severity`
// is critical/high/medium/low and a check has no severity column at all. A
// sixth column would be a second, drifting truth about how bad something is, so
// the grade is DERIVED, and the two populations derive it differently:
//
//   • A BUG'S GRADE IS ITS OWN COLUMN, 1:1 — critical→blocking, high→broken,
//     medium→degraded, low→cosmetic. A human graded it; nothing here overrules
//     that. `flaky` is never a bug's grade: nothing in `bugs` could source it.
//   • A CHECK'S GRADE IS ITS RESULT. Red is `broken`, and `blocking` when the
//     whole suite is down (every check that has run is red) — the one
//     check-side fact that earns the top word, and the reason "0 blocking"
//     means something rather than being decorative. A linked open bug may LIFT
//     a red check's grade (a critical bug makes its check blocking) and can
//     never lower it: a low-graded bug does not make a red check cosmetic.
//   • `flaky` IS THE ONE GRADE ONLY HISTORY CAN GIVE, and it belongs to a check
//     that is GREEN RIGHT NOW and flipping (`check_results` holds both outcomes
//     in the window). That is what the kit's flaky row says — "passes on a
//     re-run with no code change" — and it is why a currently-red check is
//     `broken` even when it flips: what is wrong with it today is that it is
//     red, and the flipping is in its diagnosis line.
//
// THAT LAST RULE IS LOAD-BEARING AND NOT COSMETIC. It keeps every grade of rank
// ≤ 3 (blocking/broken/degraded) HISTORY-FREE, which is what lets
// `qualityAttention` — the rail's badge, computed from the detail payload alone
// — agree exactly with the screen, which has fetched the history. Grade a red
// check `flaky` and the badge would read one number while the page showed
// another, which is the exact failure the "a row's number and the screen behind
// it must agree" rule exists to prevent. The test pins it.

import type { Bug, BugStatus, Check, CheckHistory, CheckResult, CheckRun, Severity } from '../types';

export type SevKey = 'blocking' | 'broken' | 'degraded' | 'flaky' | 'cosmetic';

// Rank orders every list on the page and picks a group's worst. The COLOURS
// live in styles.css under `.sev-<key>`; nothing here names a tone.
export const SEVERITY: Record<SevKey, { label: string; rank: number }> = {
  blocking: { label: 'Blocking', rank: 1 },
  broken: { label: 'Broken', rank: 2 },
  degraded: { label: 'Degraded', rank: 3 },
  flaky: { label: 'Flaky', rank: 4 },
  cosmetic: { label: 'Cosmetic', rank: 5 },
};
export const SEV_KEYS = Object.keys(SEVERITY) as SevKey[];

const BUG_GRADE: Record<Severity, SevKey> = {
  critical: 'blocking', high: 'broken', medium: 'degraded', low: 'cosmetic',
};
export const bugGrade = (s: Severity): SevKey => BUG_GRADE[s] ?? 'degraded';

const worse = (a: SevKey, b: SevKey): SevKey => (SEVERITY[a].rank <= SEVERITY[b].rank ? a : b);
export const worstOf = (keys: SevKey[]): SevKey | null =>
  (keys.length ? keys.reduce(worse) : null);

export const isOpenBug = (b: Bug) => b.status !== 'fixed';

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fmtMs(ms: number | null) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// The failure signature the all-red read compares on: the error text if there
// is one, else the status code. The same signature across every check is one
// cause — the host is down — not N separate bugs.
export const failSignature = (c: Check) => (c.lastError || `HTTP ${c.lastCode ?? '?'}`).trim();

// A failure with no status code never reached the app at all (timeout, refused
// connection), and "no response" says that where a bare em dash didn't.
export const checkResultLine = (c: Check) =>
  (c.lastStatus ? `${c.lastCode ?? 'no response'} · ${fmtMs(c.lastMs)} · ${c.when}` : 'never run');

// A red check still wants a bug filed when the one it is linked to is already
// fixed — that is a fresh regression, not a tracked failure.
const liveBug = (bugs: Bug[], checkId: number) =>
  bugs.find((b) => b.checkId === checkId && isOpenBug(b)) ?? null;

// The assertion a check carries, as one short phrase. A status-only check says
// so — it is the honest answer to "what does passing mean here?".
export function assertLabel(c: Check): string {
  if (c.semantic) return `✧ ${c.semantic}`;
  if (c.jsonPath) return c.jsonPath + (c.jsonExpect ? ` = ${c.jsonExpect}` : '');
  if (c.contains) return `body contains "${c.contains}"`;
  return `status ${c.expectStatus}`;
}

// WHO RUNS IT, which is this app's answer to the kit's push/nightly/manual
// column. Stack has no per-check schedule: a check is probed by the server on
// demand and by the nightly, OR its result is REPORTED from outside (#291) and
// Stack never probes it at all. That is a real two-value distinction and the
// only one the data can source.
export const runBy = (c: Check) => (c.external ? 'reported' : c.auth ? 'stack · auth' : 'stack');

// ---- #279: what a check remembers ----------------------------------------
//
// A check used to have a result but no memory, so a red light carried no
// diagnosis: a fresh regression and a fortnight of failure looked identical.
// These stats turn the same rows into the sentence you actually want — "failed
// 4 of the last 6 runs" — and they only ever claim what the window holds.

export type HistoryStats = {
  n: number;          // results in the window
  fails: number;
  streak: number;     // leading runs sharing the newest result's status
  flaky: boolean;     // both outcomes inside the window
  diagnosis: string;  // plain language, '' when there is nothing to say
};

const NO_HISTORY: HistoryStats = { n: 0, fails: 0, streak: 0, flaky: false, diagnosis: '' };

export function readHistory(results: CheckResult[] | undefined): HistoryStats {
  if (!results?.length) return NO_HISTORY;
  const n = results.length;
  const fails = results.filter((r) => r.status === 'fail').length;
  const newest = results[0].status;
  let streak = 0;
  while (streak < n && results[streak].status === newest) streak += 1;
  const flaky = fails > 0 && fails < n;

  // One run is not a trend — say nothing rather than dress it up. The phrase is
  // always a past participle so it reads standalone on a row ("· failed 4 of
  // the last 6 runs") AND after a name ("Webhook receipt has …"). Order
  // matters: a check whose newest result is its ONLY failure is a fresh
  // regression; one that has failed four times in the window is not, however
  // long its current streak.
  let diagnosis = '';
  if (n >= 2 && fails > 0) {
    diagnosis = fails === n ? `failed every one of the last ${n} runs`
      : fails === 1 ? (newest === 'fail' ? `failed for the first time in ${n} runs` : `failed once in the last ${n} runs`)
        : `failed ${fails} of the last ${n} runs`;
  }
  return { n, fails, streak, flaky, diagnosis };
}

// A check that is green NOW and flipping inside its window. Three results is
// the floor: two cannot tell a flake from a fix.
export const isGreenFlake = (c: Check, h: HistoryStats) =>
  c.lastStatus === 'pass' && h.flaky && h.n >= 3;

// ---- the health read: one verdict over checks AND bugs ---------------------

export type Verdict = 'good' | 'needs-work' | 'down' | 'untested';

export type Health = {
  verdict: Verdict; label: string; why: string;
  total: number; passing: number; failing: number; never: number; run: number;
  serious: number; open: number; avgMs: number | null;
  down: boolean;             // every check that has run is red
  oneCause: string | null;   // …and all of them the same way: the host, not N bugs
};

export function readHealth(checks: Check[], bugs: Bug[]): Health {
  const passing = checks.filter((c) => c.lastStatus === 'pass').length;
  const failing = checks.filter((c) => c.lastStatus === 'fail').length;
  const run = passing + failing;
  const never = checks.length - run;
  const open = bugs.filter(isOpenBug);
  const serious = open.filter((b) => b.severity === 'critical' || b.severity === 'high').length;
  const latencies = checks.flatMap((c) => (c.lastStatus === 'pass' && c.lastMs != null ? [c.lastMs] : []));
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  const red = checks.filter((c) => c.lastStatus === 'fail');
  const sig = red.length >= 2 && red.every((c) => failSignature(c) === failSignature(red[0]))
    ? failSignature(red[0]) : null;
  const down = run > 0 && passing === 0;
  const oneCause = down ? sig : null;

  // A red check the owner has already filed a bug against is a tracked failure,
  // and saying so is the difference between "two things are wrong" and "one
  // thing is wrong and you know about it".
  const linkedRed = red.some((c) => liveBug(bugs, c.id));

  const base = { total: checks.length, passing, failing, never, run, serious, open: open.length, avgMs, down, oneCause };

  if (!checks.length && !bugs.length) {
    return { ...base, verdict: 'untested', label: 'Untested', why: 'Nothing has been checked yet.' };
  }
  if (down) {
    return {
      ...base, verdict: 'down', label: 'Down',
      why: `0 of ${run} passing${oneCause ? ` — every one of them ${oneCause}.` : '.'}`,
    };
  }
  if (failing > 0 || serious > 0) {
    const bits = [failing > 0 ? `${plural(failing, 'check')} red` : '', serious > 0 ? `${plural(serious, 'serious bug')} open` : '']
      .filter(Boolean).join(' and ');
    return {
      ...base, verdict: 'needs-work', label: 'Needs work',
      why: `${bits.charAt(0).toUpperCase()}${bits.slice(1)}.${linkedRed
        ? ' One of the bugs is why one of the checks is red.'
        : failing > 0 && serious > 0 ? ' The pass rate alone would read fine.' : ''}`,
    };
  }
  if (!run) {
    return {
      ...base, verdict: 'untested', label: 'Untested',
      why: checks.length ? `${plural(checks.length, 'check')} waiting on a first run.` : 'No checks yet, nothing serious open.',
    };
  }
  return {
    ...base, verdict: 'good', label: 'Good',
    why: `${passing} of ${checks.length} passing, nothing serious open.${never ? ` ${plural(never, 'check')} never run.` : ''}`,
  };
}

// ---- the grade of one red check -------------------------------------------
//
// History-free on purpose — see this file's header. `bug` is its LIVE linked
// bug (an already-fixed one grades nothing), `down` the suite-wide read.
export function gradeRedCheck(bug: Bug | null, down: boolean): SevKey {
  const base: SevKey = down ? 'blocking' : 'broken';
  return bug ? worse(base, bugGrade(bug.severity)) : base;
}

// ---- Open items: the one list that mixes red checks with open bugs ---------
//
// The Quality loop is run → see what is red → file what is real → fix →
// re-run → close, and it used to cross a tab boundary twice. One list, so it
// doesn't.
//
// A BUG LINKED TO A RED CHECK IS NOT ITS OWN ROW: it is already drawn as that
// row's bug chip, and listing it twice would double-count the same problem in
// the strip, the badge and the list. That is the whole of the bug↔check link's
// (#278) job on this screen.

export type OpenItem = {
  key: string;
  kind: 'check' | 'bug';
  checkId: number | null;   // the check to run for this row ('' = none runnable)
  bugKey: string | null;    // the bug this row is, or the one its check caught
  name: string;
  severity: SevKey;
  detail: string;
  meta: string;
  canRun: boolean;          // Stack can probe it (an external row it cannot)
  wantsBug: boolean;        // a red check with no live bug filed against it
  wantsCheck: boolean;      // a bug nothing covers
};

export function openItems(checks: Check[], bugs: Bug[], history: CheckHistory): OpenItem[] {
  const health = readHealth(checks, bugs);
  const out: OpenItem[] = [];
  const shownBugs = new Set<string>();

  for (const c of checks) {
    const h = readHistory(history[c.id]);
    const bug = liveBug(bugs, c.id);
    const where = c.feature || 'ungrouped';
    if (c.lastStatus === 'fail') {
      if (bug) shownBugs.add(bug.id);
      out.push({
        key: `check:${c.id}`, kind: 'check', checkId: c.id, bugKey: bug?.id ?? null,
        name: c.name,
        severity: gradeRedCheck(bug, health.down),
        detail: failSignature(c),
        meta: [where, h.diagnosis, c.when].filter(Boolean).join(' · '),
        canRun: !c.external, wantsBug: !bug, wantsCheck: false,
      });
    } else if (isGreenFlake(c, h)) {
      out.push({
        key: `flake:${c.id}`, kind: 'check', checkId: c.id, bugKey: bug?.id ?? null,
        name: c.name, severity: 'flaky',
        detail: 'green now, but it has flipped with no change to what it tests',
        meta: [where, h.diagnosis, c.when].filter(Boolean).join(' · '),
        canRun: !c.external, wantsBug: false, wantsCheck: false,
      });
    }
  }

  for (const b of bugs) {
    if (!isOpenBug(b) || shownBugs.has(b.id)) continue;
    const cover = b.checkId == null ? null : checks.find((c) => c.id === b.checkId) ?? null;
    out.push({
      key: `bug:${b.id}`, kind: 'bug', checkId: cover?.id ?? null, bugKey: b.id,
      name: b.title,
      severity: bugGrade(b.severity),
      detail: cover ? `covered by “${cover.name}”, which is green` : 'no check covers it',
      meta: [b.status === 'open' ? '' : b.status, b.reviewed ? '' : 'awaiting review', b.meta]
        .filter(Boolean).join(' · '),
      canRun: !!cover && !cover.external, wantsBug: false, wantsCheck: !cover,
    });
  }

  const kindRank = (i: OpenItem) => (i.kind === 'check' ? 0 : 1);
  return out.sort((a, b) =>
    SEVERITY[a.severity].rank - SEVERITY[b.severity].rank
    || kindRank(a) - kindRank(b)
    || a.name.localeCompare(b.name));
}

// THE RAIL'S BADGE. The open items that are actually WRONG — blocking, broken
// or degraded — which is what the badge meant before the tab became a mockup
// (red checks + serious open bugs) and what its critical tone still claims.
// Flaky and cosmetic are noise at that tone.
//
// It takes NO history, and the header says why that is safe: no rank ≤ 3 grade
// depends on one, so this and the screen count the same rows.
export const ATTENTION_RANK = 3;
export const qualityAttention = (checks: Check[], bugs: Bug[]) =>
  openItems(checks, bugs, {}).filter((o) => SEVERITY[o.severity].rank <= ATTENTION_RANK).length;

// ---- the feature grouping -------------------------------------------------
//
// One free-text label per check (`checks.feature`) read into the groups the
// "By feature" table draws. Three rules the screen leans on:
//
//   • '' IS A REAL GROUP, not a missing one. A project that has never grouped
//     anything gets one row called Ungrouped holding its whole suite — the flat
//     list it had before — never an empty table.
//   • THE BAR IS THE PASS RATE over checks that have RUN, and a group where
//     nothing has run reads "never run" rather than 0%. Same rule as a NULL
//     verdict: no pass is not a failed pass. It is NOT coverage — Stack probes
//     a live app over HTTP and has no idea what fraction of it they touch, so a
//     coverage bar here would be a number nobody could source.
//   • ORDER IS BY WHAT NEEDS YOU — red first, then flaky, then never-run, then
//     the rest by name, with Ungrouped always last. Alphabetical would bury the
//     one red group under whatever happens to start with an A.

export const UNGROUPED = 'Ungrouped';

export type FeatureGroup = {
  key: string;              // '' = ungrouped
  label: string;
  checks: Check[];
  passing: number; failing: number; never: number; run: number;
  flakes: number;
  rate: number | null;      // 0–100 over the checks that have run; null = none have
  avgMs: number | null;
  bugs: number;             // open bugs filed from checks in this group
  worst: SevKey | null;     // null = clean
  read: string;             // the one sentence this group's history can answer
};

// The group's own read, on the same ladder the health band uses: what is red
// beats what is flaky beats what has never run.
function readGroup(checks: Check[], history: CheckHistory): string {
  const stats = checks.map((c) => ({ c, s: readHistory(history[c.id]) }));
  const red = stats.filter((x) => x.c.lastStatus === 'fail').sort((a, b) => b.s.fails - a.s.fails);
  if (red.length) {
    const worstRed = red[0];
    const lead = red.length > 1 ? `${red.length} red. ` : '';
    const tail = worstRed.s.diagnosis || `is failing — ${failSignature(worstRed.c)}`;
    return `${lead}“${worstRed.c.name}” ${tail}.`;
  }
  const flaky = stats.filter((x) => isGreenFlake(x.c, x.s)).sort((a, b) => b.s.fails - a.s.fails)[0];
  if (flaky) return `Green now, but “${flaky.c.name}” ${flaky.s.diagnosis}.`;
  const never = checks.filter((c) => !c.lastStatus).length;
  if (never === checks.length) return `${plural(checks.length, 'check')} waiting on a first run.`;
  if (never) return `Everything that has run is green. ${plural(never, 'check')} never run.`;
  return `All ${plural(checks.length, 'check')} green.`;
}

export function groupByFeature(checks: Check[], bugs: Bug[], history: CheckHistory): FeatureGroup[] {
  const health = readHealth(checks, bugs);
  const openByCheck = new Set(bugs.filter(isOpenBug).flatMap((b) => (b.checkId != null ? [b.checkId] : [])));
  const buckets = new Map<string, Check[]>();
  for (const c of checks) {
    const key = c.feature || '';
    const list = buckets.get(key);
    if (list) list.push(c); else buckets.set(key, [c]);
  }

  const groups: FeatureGroup[] = [...buckets].map(([key, list]) => {
    const passing = list.filter((c) => c.lastStatus === 'pass').length;
    const failing = list.filter((c) => c.lastStatus === 'fail').length;
    const run = passing + failing;
    const ms = list.flatMap((c) => (c.lastStatus === 'pass' && c.lastMs != null ? [c.lastMs] : []));
    const flakes = list.filter((c) => isGreenFlake(c, readHistory(history[c.id]))).length;
    // The group's tag is the worst grade anything in it carries — the same
    // grades the Open items list gives, so a feature cannot read Broken while
    // every row under it reads Blocking.
    const grades = list.flatMap<SevKey>((c) => (c.lastStatus === 'fail'
      ? [gradeRedCheck(liveBug(bugs, c.id), health.down)] : []));
    if (!grades.length && flakes) grades.push('flaky');
    return {
      key, label: key || UNGROUPED, checks: list,
      passing, failing, run, never: list.length - run, flakes,
      rate: run ? Math.round((passing / run) * 100) : null,
      avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      bugs: list.filter((c) => openByCheck.has(c.id)).length,
      worst: worstOf(grades),
      read: readGroup(list, history),
    };
  });

  const rank = (g: FeatureGroup) => (g.failing ? 0 : g.flakes ? 1 : g.never === g.checks.length ? 2 : 3);
  return groups.sort((a, b) =>
    (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0)
    || rank(a) - rank(b)
    || b.failing - a.failing
    || a.label.localeCompare(b.label));
}

// ---- the strip's five numbers ---------------------------------------------
//
// Read left to right as a sentence. `blocking` counts the SAME grading the list
// does, so "0 blocking" over a list with a Blocking row in it is impossible.

export type QualityStat = { v: string; l: string; good?: boolean; sev?: SevKey };

export function statStrip(items: OpenItem[], health: Health): QualityStat[] {
  const at = (k: SevKey) => items.filter((o) => o.severity === k).length;
  const blocking = at('blocking');
  const mid = at('broken') + at('degraded');
  const flaky = at('flaky');
  return [
    { v: health.run ? `${health.passing}/${health.total}` : `0/${health.total}`, l: 'passing' },
    { v: String(blocking), l: 'blocking', ...(blocking ? { sev: 'blocking' as SevKey } : { good: true }) },
    { v: String(mid), l: 'broken or degraded', ...(mid ? { sev: 'broken' as SevKey } : { good: true }) },
    { v: String(flaky), l: 'flaky' },
    { v: fmtMs(health.avgMs), l: 'avg' },
  ];
}

// The sparkline: FULL RUNS ONLY, oldest → newest. A run-one or a feature run
// charted beside them would read as a dip that never happened (#279), which is
// the same lie in a picture that a manufactured check_runs row would be in the
// ledger. Height is the pass rate, floored so a total wipe-out still draws.
export type SparkBar = { key: number; height: number; amber: boolean; title: string };

export function sparkline(runs: CheckRun[], keep = 30): SparkBar[] {
  return runs.filter((r) => r.scope === 'all').slice(0, keep).reverse().map((r) => ({
    key: r.id,
    height: r.total ? Math.max(8, Math.round((r.passed / r.total) * 100)) : 8,
    amber: r.failed > 0,
    title: `${r.passed}/${r.total} passed · ${r.when} · ${fmtMs(r.durationMs)}`,
  }));
}

// ---- Bugs, clustered ------------------------------------------------------
//
// The kit clusters bugs area → subject. Stack's bugs have neither: what they
// have is a STATUS (the workflow axis, and the one thing this screen writes on
// them) and, since #278, whether a check covers them. So the two levels are
// status, then covered / uncovered — which is the quality loop's own question
// ("what is open that nothing would catch again?") and what makes the "write a
// check" action on a row mean something. Inventing an area column to match the
// kit's picture would be authoring a taxonomy nobody asked for.

export const BUG_STATUS_ORDER: BugStatus[] = ['open', 'investigating', 'fixing', 'fixed'];

export type BugCluster = {
  status: BugStatus;
  label: string;
  bugs: Bug[];
  uncovered: number;
  worst: SevKey | null;
  subjects: { subject: string; covered: boolean; bugs: Bug[] }[];
};

export function clusterBugs(bugs: Bug[], checks: Check[], labels: Record<BugStatus, string>): BugCluster[] {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const covered = (b: Bug) => b.checkId != null && byId.has(b.checkId);
  const rank = (b: Bug) => SEVERITY[bugGrade(b.severity)].rank;

  return BUG_STATUS_ORDER.flatMap((status) => {
    const list = bugs.filter((b) => b.status === status).sort((a, b) => rank(a) - rank(b));
    if (!list.length) return [];
    const yes = list.filter(covered);
    const no = list.filter((b) => !covered(b));
    return [{
      status, label: labels[status], bugs: list,
      uncovered: no.length,
      // A FIXED bug's severity is history, not a claim about the app now, so a
      // closed cluster wears no grade — the same reason a green check has none.
      worst: status === 'fixed' ? null : worstOf(list.map((b) => bugGrade(b.severity))),
      subjects: [
        ...(no.length ? [{ subject: 'No check covers it', covered: false, bugs: no }] : []),
        ...(yes.length ? [{ subject: 'Covered by a check', covered: true, bugs: yes }] : []),
      ],
    }];
  });
}
