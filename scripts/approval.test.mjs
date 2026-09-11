#!/usr/bin/env node
// "APPROVED FOR THE AUTO RUNNER" — the rule that exists THREE TIMES, and the
// one file that reads all three.
// Run: node --experimental-strip-types scripts/approval.test.mjs
//
// The type-stripping loader is for the client twin only (web/src/lib/approval.ts);
// the other two are plain ESM. Same shim as scripts/spine.test.mjs.
//
// WHAT THIS IS FOR. The rule is `source NOT IN ('hook','fly') OR reviewed_at IS
// NOT NULL`, and it decides whether the overnight fleet may build a row. It is
// spelt out in server/src/approval.js, scripts/lib/approval.mjs and
// web/src/lib/approval.ts because none of the three packages can import
// another — CLAUDE.md says as much, and adds that "scripts/approval.test.mjs
// keeps them honest". Until this rewrite it did not: it imported the SCRIPT
// twin alone and had no opinion about the other two, so the sentence in
// CLAUDE.md was describing a test that did not exist. It does now, and section
// C is it.
//
// The failure this guards is asymmetric, which is why both directions are
// asserted separately. A twin that is too STRICT holds work a human typed —
// the failure mode #359 exists to not have. A twin that is too LOOSE lets the
// fleet build a row a session wrote for itself in one API call, with no human
// anywhere in the path (#381). Neither shows up as an error; both look like a
// normal night.
import module from 'node:module';

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

import { isApproved, approvalHold } from './lib/approval.mjs';
const server = await import(new URL('../server/src/approval.js', import.meta.url).href);
const client = await import(new URL('../web/src/lib/approval.ts', import.meta.url).href);

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// ---- A. isApproved, on the script twin --------------------------------------

check('a manual item is never held, even unreviewed — the point of this feature',
  isApproved({ source: 'manual', reviewed: false }), true);

check('a hook item that is unreviewed is NOT approved',
  isApproved({ source: 'hook', reviewed: false }), false);

check('a hook item that has been reviewed IS approved',
  isApproved({ source: 'hook', reviewed: true }), true);

check('a missing source defaults to manual, so it IS approved',
  isApproved({ reviewed: false }), true);

check('null is not approved (fail safe)', isApproved(null), false);
check('undefined is not approved (fail safe)', isApproved(undefined), false);

// ---- #381: a fly item is held on the same footing as a hook item ------------
// The card a session opens for its own work is one API call away from being
// tonight's build. The sign-off is the only thing between those two states.

check('a fly item that is unsigned is NOT approved',
  isApproved({ source: 'fly', reviewed: false }), false);

check('a fly item that has been signed off IS approved',
  isApproved({ source: 'fly', reviewed: true }), true);

check('a fly item is held on reviewed_at too, not just the client shape',
  isApproved({ source: 'fly', reviewed_at: '2026-08-10T00:00:00Z' }), true);

check('an unknown source is NOT held — only hook and fly are',
  isApproved({ source: 'imported', reviewed: false }), true);

// ---- B. approvalHold --------------------------------------------------------

check('approvalHold is empty for an approved item',
  approvalHold({ source: 'manual', reviewed: false }), '');

check('approvalHold names the review inbox for a held item',
  approvalHold({ source: 'hook', reviewed: false }),
  'auto-found and not yet approved — approve it in the review inbox first');

check('approvalHold says SESSION for a fly item, not "auto-found" (#381)',
  approvalHold({ source: 'fly', reviewed: false }),
  'opened by a live session and not yet approved — approve it in the review inbox first');

// ---- C. THE THREE TWINS AGREE ----------------------------------------------
//
// Every shape all three can be asked about, asserted against all three at once.
// The server and script copies read a DB row OR a client-shaped item; the
// client copy reads the client shape only, and section D pins that as the
// deliberate difference it is rather than letting it pass as agreement.

const CLIENT_SHAPES = [
  [{ source: 'manual', reviewed: false }, true, 'a manual row is approved unreviewed'],
  [{ source: 'manual', reviewed: true }, true, 'and stays approved reviewed'],
  [{ source: 'hook', reviewed: false }, false, 'an extracted row is HELD'],
  [{ source: 'hook', reviewed: true }, true, 'until a human keeps it'],
  [{ source: 'fly', reviewed: false }, false, "a session's own card is HELD (#381)"],
  [{ source: 'fly', reviewed: true }, true, 'until a human keeps it'],
  [{ source: '', reviewed: false }, true, 'an empty source falls back to manual'],
  [{ reviewed: false }, true, 'a missing source falls back to manual'],
  [{ source: 'imported', reviewed: false }, true, 'an unknown source is not one of the two held ones'],
  [{ source: 'HOOK', reviewed: false }, true, 'the match is exact — no source is held by accident of case'],
];

for (const [item, want, why] of CLIENT_SHAPES) {
  const got = [isApproved(item), server.isApproved(item), client.isApproved(item)];
  check(`three twins agree: ${why}`, got, [want, want, want]);
}

check('three twins agree: a null item is NOT approved (fail safe, all three)',
  [isApproved(null), server.isApproved(null), client.isApproved(null)], [false, false, false]);

check('three twins agree: undefined is NOT approved either',
  [isApproved(undefined), server.isApproved(undefined), client.isApproved(undefined)], [false, false, false]);

check('three twins agree: isHeld is exactly the inverse of isApproved',
  [client.isHeld({ source: 'hook', reviewed: false }), client.isHeld({ source: 'manual', reviewed: false })],
  [true, false]);

// ---- D. the ONE deliberate difference, pinned so it stays deliberate --------
//
// The host twins accept a raw DB row (`reviewed_at`, a timestamp); the client
// never sees one — `shape.js` renders it as `reviewed: boolean` before it
// reaches the browser — so the client twin reads `reviewed` alone. That is a
// narrowing, not a disagreement, and it is safe in ONE direction only: were a
// raw row ever handed to the client copy it would report HELD, which errs
// toward refusing to run rather than toward running something unsigned.

const DB_ROW = { source: 'hook', reviewed_at: '2026-08-10T00:00:00Z' };
check('a DB row reads approved on both host twins',
  [isApproved(DB_ROW), server.isApproved(DB_ROW)], [true, true]);
check('and the client, which never sees one, errs toward HELD rather than toward running it',
  client.isApproved(DB_ROW), false);

// ---- E. the words a refusal says -------------------------------------------
//
// Not shared strings, and deliberately so: the server's refusal is read in an
// API response and the script's in a terminal. What both must never do is
// describe a session's own card as "auto-found", which sends its reader hunting
// through commits for a push that never happened.

for (const [name, hold] of [['script', approvalHold], ['server', server.approvalHold]]) {
  check(`${name}: an approved item has nothing to say`, hold({ source: 'manual', reviewed: false }), '');
  const hook = hold({ source: 'hook', reviewed: false });
  const fly = hold({ source: 'fly', reviewed: false });
  check(`${name}: a hook hold says auto-found`, /auto-found/.test(hook), true);
  check(`${name}: a fly hold says SESSION and never auto-found`,
    [/live session/.test(fly), /auto-found/.test(fly)], [true, false]);
  check(`${name}: both point at the review inbox`,
    [/review inbox/.test(hook), /review inbox/.test(fly)], [true, true]);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
