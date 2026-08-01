// #262 — risk-tier provenance: an AUTO-derived risk tier must never overwrite
// a tier a HUMAN set. Tested against the REAL export.
//
//   node server/test/risk-tier.test.mjs      # exits non-zero on any failure
//
// riskWriteSource is pure precisely so this needs no database and no server.
//
// NOT covered here (needs a database): the PATCH handler in
// server/src/routes/roadmap.js builds the actual guard as a set of Postgres
// CASE expressions rather than a read-then-check, specifically so every
// right-hand side sees the OLD row and two nights writing the same item
// can't race it. That SQL is built inline in the route handler, not exported
// as a standalone function, so this file cannot call it directly — refactoring
// roadmap.js to make it testable is not this unit's call. What this file pins
// is the gate the handler's branch depends on (riskWriteSource); it does NOT
// prove the CASE expressions themselves actually refuse the write.
import { riskWriteSource, RISK_SOURCES } from '../src/util.js';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

console.log('--- RISK_SOURCES ---');
check('exactly human then auto', RISK_SOURCES, ['human', 'auto']);

console.log('\n--- riskWriteSource ---');
// An absent source is the modal, i.e. a person, and a person's tier wins.
check('undefined is the modal — a person, and a person wins', riskWriteSource(undefined), 'human');
check('null is the modal — a person, and a person wins', riskWriteSource(null), 'human');

check('human passes through', riskWriteSource('human'), 'human');
check('auto passes through', riskWriteSource('auto'), 'auto');

// Present but unrecognised takes the GUARDED path, not the winning one. A
// machine typo that resolved to 'human' would claim the row as human-decided,
// and nothing can unclaim it afterwards — so the fallback has to lean toward
// the branch that CAN be refused (the CASE guard in the PATCH handler), never
// the one that wins outright.
for (const bad of ['gemini', '', 'HUMAN', 0, {}, []]) {
  check(`unrecognised source ${JSON.stringify(bad)} falls to the guarded 'auto' path`, riskWriteSource(bad), 'auto');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
