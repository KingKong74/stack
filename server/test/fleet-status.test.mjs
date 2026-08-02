// #270 — the fleet-wide "why is it idle" status, tested against the REAL
// export (not a replica), pure and against an injected `now`.
//
//   node server/test/fleet-status.test.mjs      # exits non-zero on any failure
//
// No database and no framework: computeFleetStatus is pure precisely so this
// is possible. The whole point of the item is that a screen of calm green is
// a lie when the dispatcher has stopped polling, so the case that matters
// most here is precedence — dispatcher-silent has to outrank every other
// reading, including one that is otherwise fully healthy.
import { computeFleetStatus } from '../src/routes/control.js';

const NOW = Date.parse('2026-07-26T12:00:00Z');
const secondsAgo = (s) => new Date(NOW - s * 1000).toISOString();
const hb = (ageSec, hostLocal = '10:00pm') => ({ last_poll_at: secondsAgo(ageSec), host_local: hostLocal });

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (want ${JSON.stringify(want)})`}`);
};

// A base of otherwise-fully-healthy inputs, so each precedence case only has
// to change the one field that is supposed to win.
const base = {
  heartbeat: hb(30), busySlots: 0, capacity: 2, queuedCount: 0,
  armed: true, automodeCount: 2, eligibleCount: 2, heldResume: null,
  nightlyTime: '11:00pm', now: NOW,
};

console.log('--- precedence: dispatcher-silent > working > disarmed > no-automode > paused > nothing-eligible > waiting ---');

// Case 1: a silent dispatcher outranks EVERYTHING. Armed, automode on,
// eligible work queued and a slot busy would all read as calm on their own —
// the whole point of the ordering is that none of it matters if nobody is
// polling to act on it.
{
  const r = computeFleetStatus({
    ...base, heartbeat: hb(3 * 3600), busySlots: 1, armed: true, automodeCount: 2, eligibleCount: 2,
  });
  check('silent beats a fully healthy fleet', r.status.code, 'dispatcher-silent');
}

// Case 2: a busy slot outranks disarmed — the run in flight is real work
// regardless of whether the switch that would start a NEW one is on.
{
  const r = computeFleetStatus({ ...base, busySlots: 1, armed: false });
  check('busy beats disarmed', r.status.code, 'working');
}

// Case 3: disarmed outranks no-automode — the arm switch is the more
// fundamental blockage, so it is named first even when nothing is in
// automode either.
{
  const r = computeFleetStatus({ ...base, armed: false, automodeCount: 0 });
  check('disarmed beats no-automode', r.status.code, 'disarmed');
}

// Case 4: no-automode outranks paused — a held resume in a project that
// isn't even in automode doesn't matter until automode is on somewhere.
{
  const r = computeFleetStatus({
    ...base, armed: true, automodeCount: 0, heldResume: { status: 'paused' },
  });
  check('no-automode beats paused', r.status.code, 'no-automode');
}

// Case 5: paused outranks nothing-eligible — a held resume IS the reason
// nothing is eligible right now, so it gets named ahead of the generic
// nothing-eligible reading.
{
  const r = computeFleetStatus({
    ...base, armed: true, automodeCount: 2, eligibleCount: 0, heldResume: { status: 'paused' },
  });
  check('paused beats nothing-eligible', r.status.code, 'paused');
}

// Case 6: nothing-eligible — armed, automode on, no held resume, but no
// eligible work either.
{
  const r = computeFleetStatus({
    ...base, armed: true, automodeCount: 2, eligibleCount: 0, heldResume: null,
  });
  check('nothing-eligible', r.status.code, 'nothing-eligible');
}

// Case 7: waiting — the fully healthy case, calm because it's confirmed
// calm (a fresh heartbeat), not merely because nothing said otherwise.
{
  const r = computeFleetStatus({
    ...base, armed: true, automodeCount: 2, eligibleCount: 2, heldResume: null, heartbeat: hb(30),
  });
  check('waiting', r.status.code, 'waiting');
}

console.log('\n--- heartbeat freshness (a dead loop must never read as calm) ---');

// Case 8: exactly at the threshold is NOT silent. The rule is `> 300`, and a
// boundary tick one cron cycle wide is jitter in when the row landed, not an
// outage — the dispatcher runs on a one-minute cron so 300s is the "four
// missed ticks" line, and 300 itself hasn't missed a fourth yet.
{
  const r = computeFleetStatus({ ...base, heartbeat: hb(300) });
  check('ageSec===300 is not silent', r.heartbeat.silent, false);
  check('…and resolves to the calm case', r.status.code, 'waiting');
}

// Case 9: one second past it IS silent.
{
  const r = computeFleetStatus({ ...base, heartbeat: hb(301) });
  check('ageSec===301 is silent', r.heartbeat.silent, true);
  check('…and the status says so', r.status.code, 'dispatcher-silent');
}

// Case 10: THE most important assertion in this file. A null heartbeat is
// UNKNOWN, never silent — this server may simply pre-date the heartbeat
// table. Reading absence as an outage would fail LOUD in exactly the
// direction CLAUDE.md forbids for this class of surface (fail silent =
// report nothing, not fail loud on a guess); reading it as silence is the
// opposite mistake, alarming on a fleet that may be perfectly healthy.
{
  const r = computeFleetStatus({ ...base, heartbeat: null, armed: true, automodeCount: 2, eligibleCount: 2, heldResume: null });
  check('null heartbeat ageSec is null', r.heartbeat.ageSec, null);
  check('null heartbeat is not silent', r.heartbeat.silent, false);
  check('…and the rest of the state still resolves normally', r.status.code, 'waiting');
}

// Case 11: hostLocal echoes the row, and is '' when there is no row.
{
  const r = computeFleetStatus({ ...base, heartbeat: hb(30, '11:47pm') });
  check('hostLocal echoes the heartbeat row', r.heartbeat.hostLocal, '11:47pm');
  const rNull = computeFleetStatus({ ...base, heartbeat: null });
  check('hostLocal is empty with no heartbeat', rNull.heartbeat.hostLocal, '');
}

console.log('\n--- copy: a duration, never a relative stamp ---');

// Case 12: the silent line names a DURATION ("3h 20m"), not a relativeTime()
// stamp — "has not polled for 3h ago." is nonsense, and relativeTime() is
// also wrong further out (a bare ISO date past five weeks). This is the one
// line the whole item exists to make loud, so it gets its own check.
{
  const r = computeFleetStatus({ ...base, heartbeat: hb(3 * 3600 + 20 * 60) });
  check('names the duration', r.status.text.includes('3h 20m'), true);
  check('never a relative stamp', r.status.text.includes(' ago'), false);
}

console.log('\n--- copy: the saturated line counts the queue ---');

// Case 13: every slot busy — the wording distinguishes a deep queue from a
// single job from nothing counted yet.
{
  const r = computeFleetStatus({ ...base, busySlots: 1, capacity: 1, queuedCount: 3, heartbeat: hb(30) });
  check('plural queue depth', r.status.text.includes('3 jobs wait'), true);
}
{
  const r = computeFleetStatus({ ...base, busySlots: 1, capacity: 1, queuedCount: 1, heartbeat: hb(30) });
  check('singular queue depth', r.status.text.includes('1 job waits'), true);
}
{
  const r = computeFleetStatus({ ...base, busySlots: 1, capacity: 1, queuedCount: 0, heartbeat: hb(30) });
  check('no counted queue falls back to "new work waits"', r.status.text.includes('new work waits'), true);
}

console.log('\n--- the one-click fix matches the specific blockage ---');

// Case 14: each blockage's fix targets the thing that actually unblocks it.
{
  const r = computeFleetStatus({ ...base, armed: false, automodeCount: 0 });
  check('disarmed fixes with arm', r.status.fix.kind, 'arm');
}
{
  const r = computeFleetStatus({ ...base, armed: true, automodeCount: 2, eligibleCount: 0, heldResume: null });
  check('nothing-eligible fixes with plan', r.status.fix.kind, 'plan');
}
{
  const r = computeFleetStatus({ ...base, armed: true, automodeCount: 2, eligibleCount: 0, heldResume: { status: 'paused' } });
  check('paused fixes with resume', r.status.fix.kind, 'resume');
}

// Case 15: dispatcher-silent has NO fix — the blockage is host-side and a
// button here would lie about being able to help from the browser. The hint
// carries the crontab/log commands to run on the host instead.
{
  const r = computeFleetStatus({ ...base, heartbeat: hb(3 * 3600) });
  check('dispatcher-silent has no fix', r.status.fix, null);
  check('…but a host-side hint instead', r.status.hint.length > 0, true);
}

console.log('\n--- the unknown-pulse qualifier appears only when the pulse actually IS unknown ---');

// Case 16: with a null heartbeat, a calm outcome still carries a hint saying
// the pulse is unknown — "confirmed calm" and "nobody said otherwise" must
// not read the same. With a fresh heartbeat and the same otherwise-calm
// state, the qualifier must NOT appear — it would be lying about there being
// any doubt.
{
  const r = computeFleetStatus({ ...base, heartbeat: null, armed: true, automodeCount: 2, eligibleCount: 2, heldResume: null });
  check('unknown pulse: waiting carries a hint', r.status.code === 'waiting' && r.status.hint.length > 0, true);
}
{
  const r = computeFleetStatus({ ...base, heartbeat: hb(30), armed: true, automodeCount: 2, eligibleCount: 2, heldResume: null });
  check('known pulse: waiting carries no hint', r.status.code === 'waiting' && r.status.hint.length === 0, true);
}

console.log('\n--- paused wording splits on WHY it is paused ---');

// A hung-up session (needs a human) and a usage-limit pause (resolves
// itself on reset) are different situations and must not share a sentence.
{
  const r = computeFleetStatus({ ...base, heldResume: { status: 'paused' }, eligibleCount: 0 });
  check('hung-up session text', r.status.text.includes('hung up'), true);
}
{
  const r = computeFleetStatus({ ...base, heldResume: { status: 'not_before' }, eligibleCount: 0 });
  check('usage-limit text', r.status.text.includes('usage limit'), true);
  check('…and does not say hung up', r.status.text.includes('hung up'), false);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
