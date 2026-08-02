// One definition of a night's debrief — tested pure, no database.
//
//   node server/test/debrief.test.mjs      # exits non-zero on any failure
//
// The cases that matter are the two rules a session gets wrong by guessing:
// a `planned` run is neither landed nor failed (it is the advisor working,
// not idle), and an empty second-model read means NO PASS RAN, never a clean
// sweep.
import { composeDebrief } from '../src/debrief.js';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const run = (overrides) => ({
  slug: 'stack', name: 'Stack', tint: null, id: 1, itemId: '', itemTitle: '',
  branch: '', outcome: 'landed', commits: 1, tokens: 1000, costUsd: 0.1,
  checksFailing: 0, summary: '', reviewVerdict: '', reviewNote: '', reviewFindings: null,
  architectVerdict: '', architectNote: '', architectObs: [],
  day: '2026-08-01', when: 'just now', finishedAt: '2026-08-01T01:00:00Z',
  ...overrides,
});

// ---- mixed night: landed / failed / planned -------------------------------
{
  const runs = [
    run({ id: 1, outcome: 'landed', tokens: 1000, costUsd: 0.10 }),
    run({ id: 2, outcome: 'landed', tokens: 2000, costUsd: 0.20 }),
    run({ id: 3, outcome: 'failed', tokens: 500, costUsd: 0.05 }),
    run({ id: 4, outcome: 'planned', tokens: 300, costUsd: 0.01 }),
    run({ id: 5, outcome: 'no-commits', tokens: 200, costUsd: 0 }),
  ];
  const d = composeDebrief({ day: '2026-08-01', runs });
  check('run count', d.stats.runs, 5);
  check('landed count', d.stats.landed, 2);
  check('failed count', d.stats.failed, 1);
  check('planned count', d.stats.planned, 1);
  check('no-commits count', d.stats.noCommits, 1);
  check('a planned run is not landed', d.stats.landed + d.stats.failed, 3);
  check('a no-commits run does not fall into failed', d.stats.failed, 1);
  check('landed + failed + planned + noCommits sums to runs — nothing falls through',
    d.stats.landed + d.stats.failed + d.stats.planned + d.stats.noCommits, d.stats.runs);
  check('ran is true', d.ran, true);
  check('projects counted', d.stats.projects, 1);
}

// ---- costPerLanded --------------------------------------------------------
{
  const nothingLanded = composeDebrief({ day: 'd', runs: [run({ id: 1, outcome: 'failed', costUsd: 5 })] });
  check('costPerLanded is null when nothing landed', nothingLanded.stats.costPerLanded, null);

  const landedTwo = composeDebrief({
    day: 'd',
    runs: [
      run({ id: 1, outcome: 'landed', costUsd: 1 }),
      run({ id: 2, outcome: 'landed', costUsd: 3 }),
    ],
  });
  check('costPerLanded averages over landed runs', landedTwo.stats.costPerLanded, 2);
}

// ---- absence is not good news ----------------------------------------------
{
  const d = composeDebrief({
    day: 'd',
    runs: [run({ id: 1, reviewVerdict: '' }), run({ id: 2, reviewVerdict: '' })],
  });
  check('no reviewer verdicts anywhere: ran is 0', d.reviewer.ran, 0);
  check('no reviewer verdicts anywhere: clean is 0, not a green sweep', d.reviewer.clean, 0);
  check('same for the architect', [d.architect.ran, d.architect.aligned, d.architect.drifted], [0, 0, 0]);
}

// ---- one run of each decision kind -----------------------------------------
{
  const runs = [
    run({ id: 1, branch: 'auto/blocked', reviewVerdict: 'blocked' }),
    run({ id: 2, branch: 'auto/checks', checksFailing: 2 }),
    run({ id: 3, branch: 'auto/paused', outcome: 'limit' }),
    run({ id: 4, branch: 'auto/failed', outcome: 'failed' }),
    // both blocked AND checks-red — must yield exactly ONE decision, the blocked one
    run({ id: 5, branch: 'auto/both', reviewVerdict: 'blocked', checksFailing: 3 }),
  ];
  const d = composeDebrief({ day: 'd', runs });
  check('four decisions in the documented order', d.decisions.map((x) => x.kind),
    ['blocked', 'blocked', 'checks', 'paused', 'failed']);
  check('a run that is both blocked and red yields exactly one decision',
    d.decisions.filter((x) => x.branch === 'auto/both').length, 1);
  check('...and it is the blocked one',
    d.decisions.find((x) => x.branch === 'auto/both').kind, 'blocked');
  check('tags are the short uppercase label', d.decisions.map((x) => x.tag),
    ['BLOCKED', 'BLOCKED', 'CHECKS', 'PAUSED', 'FAILED']);
  check('every decision carries a sentence', d.decisions.every((x) => typeof x.sentence === 'string' && x.sentence.length > 0), true);
}

// ---- push notes attach by branch, not by position --------------------------
{
  const runs = [
    run({ id: 1, slug: 'stack', branch: 'auto/one' }),
    run({ id: 2, slug: 'stack', branch: 'auto/two' }),
  ];
  const notes = [
    { slug: 'stack', branch: 'auto/one', day: 'd', note: 'looks fine' },
    { slug: 'stack', branch: 'unrelated-branch', day: 'd', note: 'should not attach anywhere' },
  ];
  const d = composeDebrief({ day: 'd', runs, notes });
  check('note attaches to the matching branch', d.runs.find((r) => r.branch === 'auto/one').pushNote, 'looks fine');
  check('note does not attach to a different branch', d.runs.find((r) => r.branch === 'auto/two').pushNote, '');
  check('a note for an unrelated branch attaches nowhere', d.runs.every((r) => r.pushNote !== 'should not attach anywhere'), true);

  // several notes on the same branch: the LAST one wins
  const notes2 = [
    { slug: 'stack', branch: 'auto/one', day: 'd', note: 'first' },
    { slug: 'stack', branch: 'auto/one', day: 'd', note: 'second' },
  ];
  const d2 = composeDebrief({ day: 'd', runs: [run({ id: 1, slug: 'stack', branch: 'auto/one' })], notes: notes2 });
  check('the last matching note wins', d2.runs[0].pushNote, 'second');
}

// ---- string-valued tokens/costUsd (as pg returns them) ----------------------
{
  const runs = [
    run({ id: 1, tokens: '1500', costUsd: '0.25' }),
    run({ id: 2, tokens: '2500', costUsd: '0.75' }),
  ];
  const d = composeDebrief({ day: 'd', runs });
  check('string tokens sum to a number, not concatenation', d.stats.tokens, 4000);
  check('string costUsd sums to a number', d.stats.costUsd, 1);
}

// ---- disagreement ------------------------------------------------------------
{
  const runs = [
    run({ id: 1, branch: 'auto/split', reviewVerdict: 'clean', architectVerdict: 'drifting', itemId: '9', itemTitle: 'Thing' }),
    run({ id: 2, branch: 'auto/agree', reviewVerdict: 'clean', architectVerdict: 'aligned' }),
    run({ id: 3, branch: 'auto/unrun', reviewVerdict: 'concerns', architectVerdict: '' }),
  ];
  const d = composeDebrief({ day: 'd', runs });
  check('only the run where both exist and disagree lands in disagree', d.disagree.length, 1);
  check('it names the run', d.disagree[0], {
    slug: 'stack', itemId: '9', itemTitle: 'Thing', branch: 'auto/split',
    reviewVerdict: 'clean', architectVerdict: 'drifting',
  });
}

// ---- empty input -------------------------------------------------------------
{
  const d = composeDebrief({ day: '2026-08-01', runs: [], notes: [] });
  check('ran is false with no runs', d.ran, false);
  check('stats are all zeroed', d.stats, {
    runs: 0, landed: 0, failed: 0, planned: 0, noCommits: 0, projects: 0, tokens: 0, costUsd: 0, costPerLanded: null,
  });
  check('reviewer/architect are all zeroed', [d.reviewer, d.architect], [
    { ran: 0, clean: 0, flagged: 0, blocked: 0, findings: 0 },
    { ran: 0, aligned: 0, drifted: 0 },
  ]);
  check('no decisions, no disagreement, no runs', [d.decisions, d.disagree, d.runs], [[], [], []]);

  // No NaN or undefined anywhere in the payload — round-trip through JSON,
  // which turns NaN/undefined into null/dropped, and a raw string search for
  // "NaN" catches the case JSON.stringify would otherwise hide.
  const raw = JSON.stringify(d);
  check('no NaN literal anywhere in the payload', raw.includes('NaN'), false);
  const roundTrip = JSON.parse(raw);
  check('round-trip is stable (nothing was NaN/undefined under the hood)', roundTrip, d);
}

// ---- unscoped (cross-project) vs scoped --------------------------------------
{
  const crossNight = composeDebrief({ day: 'd', runs: [run({ id: 1 })] });
  check('no slug given: scope is null (cross-project)', crossNight.scope, null);
  const scoped = composeDebrief({ day: 'd', slug: 'stack', runs: [run({ id: 1 })] });
  check('slug given: scope echoes it', scoped.scope, 'stack');
  check('day is echoed', scoped.day, 'd');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
