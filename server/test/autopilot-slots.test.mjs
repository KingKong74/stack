// #265 — N parallel workers instead of one global lane.
//
//   node server/test/autopilot-slots.test.mjs      # exits non-zero on any failure
//
// Pure and framework-free, same idiom as fleet-roles.test.mjs: slots.js takes
// no database and no imports from the rest of the server, so the real rule is
// testable without one. A wrong answer here either starves the fleet back
// down to one lane or lets two jobs fight over the same worktree.
import { canClaim, pickClaimable, cleanWorkers } from '../src/slots.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};

const job = (id, projectId, itemId, kind = 'manual') => ({ id, projectId, itemId, kind, status: 'queued' });

console.log('--- workers=1 reproduces today\'s behaviour exactly ---');
{
  const inFlight = [job('a1', 'p1', null, 'nightly')];
  check('any kind blocks every candidate (manual)', canClaim(job('c1', 'p2', 5, 'manual'), inFlight, 1), 'all 1 lanes busy');
  check('any kind blocks every candidate (plan)', canClaim(job('c2', 'p1', 5, 'plan'), inFlight, 1), 'all 1 lanes busy');
  check('empty deck, one candidate claims', canClaim(job('c3', 'p1', null, 'nightly'), [], 1), null);
}

console.log('\n--- workers=2, empty deck: first queued job is handed out ---');
{
  const { job: won, reasons } = pickClaimable([job('q1', 'p1', 1, 'manual'), job('q2', 'p2', 2, 'manual')], [], 2);
  check('first queued wins', won && won.id, 'q1');
  check('no reasons on an empty deck', reasons, []);
}

console.log('\n--- workers=2, two DIFFERENT projects: both run side by side ---');
{
  const inFlight = [job('a1', 'p1', 1, 'manual')];
  check('different project claimable', canClaim(job('c1', 'p2', 9, 'manual'), inFlight, 2), null);
}

console.log('\n--- workers=2, ONE project, jobs pinned to DIFFERENT items: both run side by side ---');
{
  const inFlight = [job('a1', 'p1', 1, 'manual')];
  check('different item, same project claimable', canClaim(job('c1', 'p1', 2, 'manual'), inFlight, 2), null);
}

console.log('\n--- workers=2, one project, jobs pinned to the SAME item: second is blocked ---');
{
  const inFlight = [job('a1', 'p1', 1, 'manual')];
  check('same item blocked', canClaim(job('c1', 'p1', 1, 'manual'), inFlight, 2), 'that item is already running');
}

console.log('\n--- workers=2, one project: pinned in flight, UNPINNED nightly queued: blocked ---');
{
  const inFlight = [job('a1', 'p1', 5, 'manual')];
  check('unpinned candidate blocked by pinned in-flight', canClaim(job('c1', 'p1', null, 'nightly'), inFlight, 2), 'project already has a job in flight');
}

console.log('\n--- workers=2, one project: UNPINNED nightly in flight, pinned job queued: blocked ---');
{
  const inFlight = [job('a1', 'p1', null, 'nightly')];
  check('pinned candidate blocked by unpinned in-flight', canClaim(job('c1', 'p1', 5, 'manual'), inFlight, 2), 'project already has a job in flight');
}

console.log('\n--- workers=4 with 4 in flight: deck full ---');
{
  const inFlight = [job('a1', 'p1', 1), job('a2', 'p2', 2), job('a3', 'p3', 3), job('a4', 'p4', 4)];
  check('deck full', canClaim(job('c1', 'p5', 9), inFlight, 4), 'all 4 lanes busy');
}

console.log('\n--- merge waits for an empty deck, claims one ---');
{
  const busy = [job('a1', 'p1', 1, 'manual')];
  check('queued merge blocked while anything is in flight', canClaim(job('m1', 'p2', null, 'merge'), busy, 4), 'merge/revert waits for an empty deck');
  check('merge claimable on an empty deck', canClaim(job('m1', 'p2', null, 'merge'), [], 4), null);
}

console.log('\n--- a merge in flight blocks every other candidate, including a different project ---');
{
  const inFlight = [job('m1', 'p1', null, 'merge')];
  check('same project candidate blocked', canClaim(job('c1', 'p1', 9, 'manual'), inFlight, 4), 'a merge/revert is in flight');
  check('different project candidate blocked too', canClaim(job('c2', 'p2', 9, 'manual'), inFlight, 4), 'a merge/revert is in flight');
  // revert behaves the same as merge for this gate
  const inFlightRevert = [job('r1', 'p1', 7, 'revert')];
  check('revert in flight blocks a different project too', canClaim(job('c3', 'p2', 9, 'manual'), inFlightRevert, 4), 'a merge/revert is in flight');
}

console.log('\n--- two queued merges never run together ---');
{
  const inFlight = [job('m1', 'p1', null, 'merge')];
  check('second merge blocked by the first', canClaim(job('m2', 'p2', null, 'merge'), inFlight, 4), 'a merge/revert is in flight');
  const inFlightRevert = [job('r1', 'p1', 3, 'revert')];
  check('merge blocked by a revert in flight', canClaim(job('m3', 'p2', null, 'merge'), inFlightRevert, 4), 'a merge/revert is in flight');
}

console.log('\n--- pickClaimable steps over a blocked job and reports the skip ---');
{
  const inFlight = [job('a1', 'p1', 1, 'manual')];
  const queued = [
    job('q1', 'p1', 1, 'manual'),   // blocked: same item as a1
    job('q2', 'p1', null, 'nightly'), // blocked: unpinned vs pinned a1
    job('q3', 'p2', 9, 'manual'),   // claimable: different project
  ];
  const { job: won, reasons } = pickClaimable(queued, inFlight, 2);
  check('the eligible job behind the blocked ones wins', won && won.id, 'q3');
  check('the skipped ones are reported in order', reasons, [
    { id: 'q1', reason: 'that item is already running' },
    { id: 'q2', reason: 'project already has a job in flight' },
  ]);
}

console.log('\n--- pickClaimable: nothing claimable reports every reason, job null ---');
{
  const inFlight = [job('a1', 'p1', null, 'merge')];
  const queued = [job('q1', 'p2', 1, 'manual'), job('q2', 'p3', 2, 'manual')];
  const { job: won, reasons } = pickClaimable(queued, inFlight, 4);
  check('nothing handed out', won, null);
  check('every queued job reported', reasons, [
    { id: 'q1', reason: 'a merge/revert is in flight' },
    { id: 'q2', reason: 'a merge/revert is in flight' },
  ]);
}

console.log('\n--- workers coercion: 0, -3, undefined, \'x\' -> 1; 99 -> 4 ---');
check('0 -> 1', cleanWorkers(0), 1);
check('-3 -> 1', cleanWorkers(-3), 1);
check('undefined -> 1', cleanWorkers(undefined), 1);
check("'x' -> 1", cleanWorkers('x'), 1);
check('99 -> 4', cleanWorkers(99), 4);
// and canClaim's own coercion agrees (the deck-full reason names the coerced count)
check('canClaim coerces 99 workers to 4 in its reason', canClaim(job('c1', 'p1', 1), [job('a', 'p2', 1), job('b', 'p3', 1), job('c', 'p4', 1), job('d', 'p5', 1)], 99), 'all 4 lanes busy');

console.log('\n--- item ids compare correctly across string/number mixes ---');
{
  const inFlight = [job('a1', 'p1', 7, 'manual')]; // number
  check('in-flight itemId 7 (number) vs candidate \'7\' (string) is the SAME item',
    canClaim(job('c1', 'p1', '7', 'manual'), inFlight, 2), 'that item is already running');
  const inFlightStr = [job('a2', 'p1', '7', 'manual')]; // string
  check('in-flight itemId \'7\' (string) vs candidate 7 (number) is the SAME item',
    canClaim(job('c2', 'p1', 7, 'manual'), inFlightStr, 2), 'that item is already running');
  // different items, mixed types, still allowed side by side
  check('different items across string/number types still run side by side',
    canClaim(job('c3', 'p1', '8', 'manual'), inFlight, 2), null);
  // undefined itemId treated the same as null (unpinned)
  const inFlightUndef = [{ id: 'a3', projectId: 'p1', itemId: undefined, kind: 'nightly', status: 'running' }];
  check('undefined itemId treated as unpinned, blocked like null',
    canClaim(job('c4', 'p1', 5, 'manual'), inFlightUndef, 2), 'project already has a job in flight');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
