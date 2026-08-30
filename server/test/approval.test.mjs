// "Approved for the auto runner" — the one rule, tested against both shapes
// it has to work against (a DB row and the client-shaped item), against the
// SQL fragment that is the same rule inside a WHERE clause, and against both
// enqueue gates BOTH WAYS: unapproved work filtered out, manual and approved
// work still running. That second half is the one that matters — a gate that
// holds everything passes a one-directional test and stops the fleet.
//
//   node server/test/approval.test.mjs      # exits non-zero on any failure
//
// Pure precisely so this needs no database and no host.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isApproved, approvalHold, APPROVED_SQL, PENDING_SQL, partitionApproved,
  roadmapIdsIn, scheduleGate, startGate,
} from '../src/approval.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- isApproved / approvalHold --------------------------------------------

check('a manual item is never held, even unreviewed — the point of this feature',
  isApproved({ source: 'manual', reviewed_at: null }), true);

check('a manual item shaped for the client is never held either',
  isApproved({ source: 'manual', reviewed: false }), true);

check('a hook item with no reviewed_at is not approved (DB shape)',
  isApproved({ source: 'hook', reviewed_at: null }), false);
check('a hook item with reviewed:false is not approved (client shape)',
  isApproved({ source: 'hook', reviewed: false }), false);
check('and approvalHold names the review inbox',
  approvalHold({ source: 'hook', reviewed_at: null }),
  'auto-found and not yet approved — it is in the review inbox');

check('a hook item with a reviewed_at timestamp is approved (DB shape)',
  isApproved({ source: 'hook', reviewed_at: '2026-08-01T00:00:00Z' }), true);
check('and approvalHold is empty for it',
  approvalHold({ source: 'hook', reviewed_at: '2026-08-01T00:00:00Z' }), '');

check('a hook item with reviewed:true is approved (client shape)',
  isApproved({ source: 'hook', reviewed: true }), true);

check('null is not approved (fail safe)', isApproved(null), false);
check('undefined is not approved (fail safe)', isApproved(undefined), false);

// ---- #381: fly, the third origin -------------------------------------------
//
// A fly card is one API call away from being tonight's build, so it is held on
// exactly the same footing as a hook extraction. What differs is only the WORDS
// — a card the owner's own session opened, described as "auto-found", sends
// them looking through commits for a push that never happened.

check('a fly item with no reviewed_at is not approved (DB shape)',
  isApproved({ source: 'fly', reviewed_at: null }), false);
check('a fly item with reviewed:false is not approved (client shape)',
  isApproved({ source: 'fly', reviewed: false }), false);
check('a signed-off fly item IS approved',
  isApproved({ source: 'fly', reviewed_at: '2026-08-10T00:00:00Z' }), true);
check('approvalHold says SESSION for a fly item, not "auto-found"',
  approvalHold({ source: 'fly', reviewed_at: null }),
  'opened by a live session and not yet approved — it is in the review inbox');
check('a source the rule has never heard of is NOT held — only hook and fly are',
  isApproved({ source: 'imported', reviewed_at: null }), true);

// ---- APPROVED_SQL -----------------------------------------------------------

check('APPROVED_SQL produces the expected fragment',
  APPROVED_SQL('ri'), "(ri.source NOT IN ('hook', 'fly') OR ri.reviewed_at IS NOT NULL)");
check('APPROVED_SQL defaults to alias r',
  APPROVED_SQL(), "(r.source NOT IN ('hook', 'fly') OR r.reviewed_at IS NOT NULL)");

{
  let threw = false;
  try { APPROVED_SQL('r; DROP TABLE'); } catch { threw = true; }
  check('APPROVED_SQL rejects an alias that is not a plain identifier', threw, true);
}

// ---- PENDING_SQL, the exact inverse -----------------------------------------
//
// The inbox and the runner gate must partition the board between them. An item
// held from the runner but absent from the inbox is work with no way ever to be
// approved, which is the failure this pair exists to make impossible.

check('PENDING_SQL produces the expected fragment',
  PENDING_SQL('ri'), "(ri.source IN ('hook', 'fly') AND ri.reviewed_at IS NULL)");
check('PENDING_SQL defaults to alias r',
  PENDING_SQL(), "(r.source IN ('hook', 'fly') AND r.reviewed_at IS NULL)");

{
  let threw = false;
  try { PENDING_SQL('r; DROP TABLE'); } catch { threw = true; }
  check('PENDING_SQL rejects an alias that is not a plain identifier', threw, true);
}

// The two fragments must be complements. Evaluated in JS rather than SQL, over
// every combination the columns can actually hold, so this test needs no
// database and still catches a drift between the two spellings.
{
  let disagree = 0;
  for (const source of ['hook', 'fly', 'manual', 'imported']) {
    for (const reviewed_at of [null, '2026-08-10T00:00:00Z']) {
      const approved = source === 'manual' || source === 'imported' || reviewed_at !== null;
      const pending = (source === 'hook' || source === 'fly') && reviewed_at === null;
      if (approved === pending) disagree++;              // never both, never neither
      if (isApproved({ source, reviewed_at }) !== approved) disagree++;
    }
  }
  check('every row is either approved or pending, never both and never neither',
    disagree, 0);
}

// ---- partitionApproved -------------------------------------------------------

{
  const items = [
    { id: 1, source: 'manual', reviewed_at: null },
    { id: 2, source: 'hook', reviewed_at: null },
    { id: 3, source: 'hook', reviewed_at: '2026-08-01T00:00:00Z' },
    { id: 4, source: 'hook', reviewed: true },
  ];
  const { approved, held } = partitionApproved(items);
  check('partitionApproved splits a mixed list', [approved.map((i) => i.id), held.map((i) => i.id)],
    [[1, 3, 4], [2]]);
}

// ---- the enqueue gates, both ways -------------------------------------------
//
// The map the routes hand in: roadmap id → row. 1 is a manual item nobody has
// reviewed (approved — that is the whole point), 2 is auto-found and held, 3
// is auto-found and signed off.

const BOARD = new Map([
  [1, { id: 1, source: 'manual', reviewed_at: null, title: 'Hand-written work' }],
  [2, { id: 2, source: 'hook', reviewed_at: null, title: 'Found on a push' }],
  [3, { id: 3, source: 'hook', reviewed_at: '2026-08-01T00:00:00Z', title: 'Approved in the inbox' }],
]);

check('roadmapIdsIn: a plain Run now puts nothing in play, so nothing is queried',
  roadmapIdsIn(null, []), []);
check('roadmapIdsIn: a pinned id and its agenda dedupe into one lookup',
  roadmapIdsIn(2, [2, 3, 'BUG-7']), [2, 3]);

// --- GET /next, the unattended schedule enqueue (drops silently) ---
check('schedule: a pinned MANUAL item enqueues — a manual item is never held',
  scheduleGate(1, [], BOARD), { agenda: [] });
check('schedule: a pinned APPROVED found item enqueues',
  scheduleGate(3, [], BOARD), { agenda: [] });
check('schedule: a pinned HELD item drops the enqueue',
  scheduleGate(2, [], BOARD), { held: true });
check('schedule: a pinned id that is not on this project at all is held (fail safe)',
  scheduleGate(99, [], BOARD), { held: true });
check('schedule: a mixed agenda runs its approved half, in order',
  scheduleGate(null, [1, 2, 3], BOARD), { agenda: [1, 3] });
check('schedule: an agenda where every roadmap id is held drops the enqueue',
  scheduleGate(null, [2, 99], BOARD), { held: true });
check('schedule: bug keys carry no approval gate and keep their place',
  scheduleGate(null, ['BUG-7', 2, 1], BOARD), { agenda: ['BUG-7', 1] });
check('schedule: an agenda of nothing but bug keys enqueues untouched',
  scheduleGate(null, ['BUG-7', 'BUG-9'], BOARD), { agenda: ['BUG-7', 'BUG-9'] });
check('schedule: a held PIN blocks even when the agenda is fine',
  scheduleGate(2, [1, 3], BOARD), { held: true });

// --- POST /start, Run now (refuses out loud) ---
check('start: a manual pin runs, nothing held',
  startGate(1, [], BOARD), { held: [], agenda: [] });
check('start: an approved found pin runs, nothing held',
  startGate(3, [], BOARD), { held: [], agenda: [] });
check('start: a held pin is refused BY NAME, not dropped',
  startGate(2, [], BOARD),
  { held: [{ id: 2, title: 'Found on a push',
    reason: '#2 "Found on a push" is auto-found and not yet approved — it is in the review inbox.' }],
  agenda: [] });
check('start: an id that is not on this project says so rather than blaming approval',
  startGate(99, [], BOARD).held[0].reason, '#99 is not an item on this project.');
check('start: a mixed agenda runs its survivors WITHOUT an error — the human gets the runnable part',
  startGate(null, [1, 2, 3], BOARD), { held: [], agenda: [1, 3] });
check('start: an all-held agenda names every one of them',
  startGate(null, [2, 99], BOARD).held.map((h) => h.id), [2, 99]);
check('start: bug keys pass and keep their place',
  startGate(null, ['BUG-7', 2, 1], BOARD), { held: [], agenda: ['BUG-7', 1] });

// ---- no fifth copy of the rule ------------------------------------------------
//
// The rule is spelt out three times on purpose — server, scripts, client —
// because none of the three packages can import another. Every OTHER place
// that gates work reads one of those three. This guard is what stops a fourth
// hand-rolled copy drifting back in: it caught SessionPlanModal, which had
// been filtering the Run-now agenda by its own copy since #228. That component
// has since gone (nothing rendered it once the Roadmap strip was culled), so
// the list below is the two host-side gates — but the guard's own self-test
// still fires on SessionPlanModal's copy verbatim, which is what keeps this
// from becoming a check that cannot fail.
//
// Scoped to the files that actually gate execution. The review-inbox COUNTS
// (overview.js, triage.js, ProjectDetail.tsx) legitimately spell
// source='hook' AND reviewed_at IS NULL — they count a different population,
// across three tables, and are not an approval gate. Since #381 their ROADMAP
// half goes through PENDING_SQL (the inverse of this rule, so the inbox and the
// gate cannot disagree); their bug and future halves still spell 'hook' by
// hand, correctly — neither of those tables can ever hold a 'fly' row.

const QUEUES = [
  ['scripts/stack-autopilot.mjs', 'lib/approval.mjs'],          // the runner's eligible()/pins/agenda
  ['server/src/routes/autopilot.js', '../approval.js'],         // the two enqueue gates
];
// A hand-rolled copy is a source test and a reviewed test close enough
// together to be the same expression…
const HANDROLLED = /source\s*(===|!==|==|!=|<>|=)\s*['"](hook|manual)['"][^\n]{0,80}reviewed/i;
// …but those same two columns ALSO spell the review inbox, which is a count,
// not a gate — overview.js tallies it over bugs and roadmap items. What tells
// the two apart is that
// an eligibility filter is never only about approval: it asks in the same
// breath whether the item is claimed or parked. So a hit needs an
// eligibility neighbour within a few lines.
const ELIGIBILITY_NEARBY = /claim|skipped/i;
const WINDOW = 3;

const handRolledIn = (src) => {
  const lines = src.split('\n');
  const idx = lines.findIndex((line, i) =>
    HANDROLLED.test(line)
    && !/^\s*(\/\/|--|\*)/.test(line)   // a comment describing the rule is not a copy of it
    && lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).some((l) => ELIGIBILITY_NEARBY.test(l)));
  return idx === -1 ? '' : `line ${idx + 1}: ${lines[idx].trim()}`;
};

for (const [rel, imports] of QUEUES) {
  const src = readFileSync(join(REPO, rel), 'utf8');
  check(`${rel} reads the shared rule`, src.includes(imports), true);
  check(`${rel} does not hand-roll it`, handRolledIn(src), '');
}

// The guard's own test. A guard that cannot fail is a green tick for nothing,
// so it is aimed at the copy it actually found — SessionPlanModal's, verbatim
// as it stood before this item — and at the inbox count it must NOT flag.
check('the guard catches the copy that was really there',
  handRolledIn([
    "      .filter((it) => ['must', 'should'].includes(it.bucket) && !it.claimedBy && !it.skipped",
    "        && (it.source === 'manual' || it.reviewed)",
    '        && (!area || (it.area || \'\') === area))',
  ].join('\n')),
  "line 2: && (it.source === 'manual' || it.reviewed)");
check('and leaves the review-inbox count alone',
  handRolledIn([
    'SELECT project_id FROM bugs WHERE source = \'hook\' AND reviewed_at IS NULL',
    'UNION ALL',
    'SELECT project_id FROM roadmap_items WHERE source = \'hook\' AND reviewed_at IS NULL AND NOT done',
  ].join('\n')),
  '');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
