// The debrief module turns a run + its sessions into a flat, capped list of
// actionable insights — tested pure, no database, no host.
//
//   node server/test/debrief-extract.test.mjs      # exits non-zero on any failure
//
// The case that matters most is the empty one: no summary, no advisor notes,
// no sessions must read as NO insights, never as a fabricated suggestion.
import { extractInsights, actionableLines } from '../src/debrief.js';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- structured sources: blockers first, then next-steps -----------------

{
  const run = { summary: null, review_note: null, architect_note: null, architect_obs: null };
  const sessions = [
    { next_steps: ['Wire the export button into the toolbar'], blockers: ['Blocked on the missing API key'], created_at: '2026-08-01T00:00:00Z' },
  ];
  const { insights, truncated } = extractInsights(run, sessions);
  check('blockers land before next-steps', insights.map((i) => i.kind), ['blocker', 'next-step']);
  check('sessions attribute as from:session', insights.map((i) => i.from), ['session', 'session']);
  check('text is carried verbatim', insights.map((i) => i.text), ['Blocked on the missing API key', 'Wire the export button into the toolbar']);
  check('nothing dropped, nothing truncated', truncated, 0);
}

// ---- sessions: newest-first, first non-empty list wins, not a merge ------

{
  const run = {};
  const sessions = [
    { next_steps: [], blockers: [], created_at: '2026-08-02T00:00:00Z' }, // newest, empty
    { next_steps: ['Older session next step'], blockers: [], created_at: '2026-08-01T00:00:00Z' },
  ];
  const { insights } = extractInsights(run, sessions);
  check('walks past an empty newest session to the first with content', insights.map((i) => i.text), ['Older session next step']);
}

// ---- architect_obs: array of strings ---------------------------------------

{
  const run = { architect_obs: ['Check the retry logic on the export job', 'Cap the fenced parser at a fixed line count'] };
  const { insights } = extractInsights(run, []);
  check('architect_obs strings become advisor/architect insights', insights.map((i) => [i.kind, i.from, i.text]), [
    ['advisor', 'architect', 'Check the retry logic on the export job'],
    ['advisor', 'architect', 'Cap the fenced parser at a fixed line count'],
  ]);
}

// ---- architect_obs: array of objects, tolerant of missing text -----------

{
  const run = {
    architect_obs: [
      { text: 'Add a regression test for the empty-obs case' },
      { title: 'Only a title field is present here' },
      { nope: 'has none of the recognised keys' },
    ],
  };
  const { insights } = extractInsights(run, []);
  check('object elements use text then title, and one with neither is dropped', insights.map((i) => i.text), [
    'Add a regression test for the empty-obs case',
    'Only a title field is present here',
  ]);
  check('all still tagged advisor/architect', insights.every((i) => i.kind === 'advisor' && i.from === 'architect'), true);
}

// ---- actionableLines: heading tracking + narration is dropped -------------

{
  const summary = [
    '## What happened',
    'We shipped the workbench pull picker and landed the new debrief endpoint tonight. Fixed a flaky check on the way.',
    '',
    '## Next steps',
    '- Wire the debrief insights picker into the Workbench toolbar',
    '- Consider capping architect_obs at a fixed length',
  ].join('\n');
  check('only the bullets under an actionable heading survive, narration does not', actionableLines(summary), [
    'Wire the debrief insights picker into the Workbench toolbar',
    'Consider capping architect_obs at a fixed length',
  ]);
}

// ---- actionableLines: a fenced code block is ignored entirely ------------

{
  const summary = [
    'Intro line with plenty of words is not actionable on its own.',
    '',
    '```',
    '- Wire the fake button from inside the fence',
    'Needs to be done still inside the fence',
    '```',
    '',
    '## Next steps',
    '- Wire the real button integration for real',
  ].join('\n');
  check('a fenced block is skipped even though it reads as actionable', actionableLines(summary), [
    'Wire the real button integration for real',
  ]);
}

// ---- dedup across the whole result, first occurrence (and its kind) wins -

{
  const text = 'Wire the debrief insights picker into the Workbench toolbar';
  const run = { summary: `## Next steps\n- ${text}\n` };
  const sessions = [{ next_steps: [text], blockers: [] }];
  const { insights } = extractInsights(run, sessions);
  check('the same sentence in next-steps and prose yields one insight', insights.length, 1);
  check('and it keeps the next-step kind, not note', [insights[0].kind, insights[0].from], ['next-step', 'session']);
}

// ---- the cap reports what it drops, never silently -------------------------

{
  const architect_obs = Array.from({ length: 20 }, (_, i) => `Observation number ${i} worth reviewing closely`);
  const { insights, truncated } = extractInsights({ architect_obs }, [], { cap: 5 });
  check('the cap is honoured', insights.length, 5);
  check('and the drop count is reported', truncated, 15);
}

// ---- an empty run is an absence, not a fabricated suggestion -------------

check('nothing in, nothing out',
  extractInsights({}, []),
  { insights: [], truncated: 0 });

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
