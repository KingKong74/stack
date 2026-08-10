#!/usr/bin/env node
// The session-defaults catalogue exists TWICE and the two copies must agree.
// Run: node --experimental-strip-types scripts/session-defaults.test.mjs
//
//   server/src/settings.js  SESSION_DEFAULTS — injected by the SessionStart
//                           hook into every session on every project.
//   web/src/lib/brief.ts    DIRECTIVES       — the Settings toggles, and the
//                           lines written into an exported brief a human pastes
//                           into a session.
//
// Two doors into the same room. A key present on one side and not the other is
// a toggle that switches nothing, or an instruction with no switch; a LINE that
// differs is worse and subtler — the same session behaves differently depending
// on which door it came through, and nothing anywhere reports it. CLAUDE.md has
// said "keys mirror SESSION_DEFAULTS" since the catalogue was written, and
// until #381 nothing checked either half.
//
// The packages cannot import each other (server is Node, brief.ts is browser
// TypeScript), which is exactly why this test is here rather than a shared
// module being possible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';

// The extensionless-relative → .ts rewrite, SCOPED TO web/src. Unscoped (the
// spelling scripts/feature.test.mjs can afford, because it imports nothing but
// browser TypeScript) it also rewrites the requires inside `pg`, which
// server/src/settings.js pulls in through db.js — and `pg` asking for
// './client' then gets handed './client.ts', which does not exist.
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromWeb = String(context?.parentURL || '').includes('/web/src/');
    if (fromWeb && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { SESSION_DEFAULTS, cleanSessionDefaults, sessionDefaultLines } =
  await import(new URL('../server/src/settings.js', import.meta.url).href);
const { DIRECTIVES } =
  await import(new URL('../web/src/lib/brief.ts', import.meta.url).href);

test('the two catalogues carry the same keys, in the same order', () => {
  assert.deepEqual(
    DIRECTIVES.map((d) => d.key),
    SESSION_DEFAULTS.map((d) => d.key),
  );
});

test('and the same lines — a session must not read differently by door', () => {
  const server = new Map(SESSION_DEFAULTS.map((d) => [d.key, d.line]));
  for (const d of DIRECTIVES) {
    assert.equal(d.line, server.get(d.key), `the '${d.key}' line has drifted`);
  }
});

test('every client entry has the furniture the Settings toggle needs', () => {
  for (const d of DIRECTIVES) {
    assert.ok(d.label?.trim(), `'${d.key}' has no label`);
    assert.ok(d.hint?.trim(), `'${d.key}' has no hint`);
  }
});

test('an unknown key is dropped rather than stored', () => {
  assert.deepEqual(cleanSessionDefaults(['ship', 'wharrgarbl', 'fly']), ['ship', 'fly']);
  assert.deepEqual(cleanSessionDefaults('ship'), []);   // not an array = nothing
  assert.deepEqual(cleanSessionDefaults(['ship', 'ship']), ['ship']);
});

test('lines come back in CATALOGUE order, not the order they were toggled', () => {
  // The hook renders these as a bullet list a session reads top to bottom, and
  // a list whose order depends on which checkbox was clicked first reads as a
  // different set of instructions each time.
  const keys = SESSION_DEFAULTS.map((d) => d.key);
  assert.deepEqual(
    sessionDefaultLines([...keys].reverse()),
    SESSION_DEFAULTS.map((d) => d.line),
  );
});

test('#381 — the fly line carries its whole recipe, not just the intent', () => {
  // It is injected into sessions that have read nothing else: a bare `claude`
  // in a checkout gets the SessionStart block and no agent manual. "Open a
  // card" without the shape produces a session that tries and gives up.
  const fly = SESSION_DEFAULTS.find((d) => d.key === 'fly');
  assert.ok(fly, 'the fly default is missing');
  assert.match(fly.line, /roadmap/, 'no endpoint');
  assert.match(fly.line, /"source":"fly"/, 'no source marker');
  assert.match(fly.line, /STACK_TOKEN/, 'no auth');
  assert.match(fly.line, /signs it off/, 'does not say it is held from the runner');
  assert.match(fly.line, /dismissed/, 'does not say what a dismissal means');
});
