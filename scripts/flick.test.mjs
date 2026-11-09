#!/usr/bin/env node
// Tests for web/src/lib/flick.ts — the ⌃` flick between the terminal and the board.
// Run: node --experimental-strip-types scripts/flick.test.mjs
//
// The rule that matters: going BACK to the terminal carries no cwd once it has
// been opened, because a cwd re-runs the ⌨ handoff and can spawn a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { flickTarget, isFlickKey } = await import(new URL('../web/src/lib/flick.ts', import.meta.url).href);
const { parseHash } = await import(new URL('../web/src/lib/route.ts', import.meta.url).href);

const term = parseHash('#/terminal');

test('from the terminal: the focused pane\'s project board', () => {
  assert.equal(flickTarget(term, { termProject: 'stack', lastAway: '', termMounted: true }), '#/p/stack/roadmap');
});

test('from the terminal: back to the tab you left, if it is the same project', () => {
  assert.equal(flickTarget(term, { termProject: 'stack', lastAway: '#/p/stack/plans', termMounted: true }), '#/p/stack/plans');
  assert.equal(flickTarget(term, { termProject: 'stack', lastAway: '#/p/other/plans', termMounted: true }), '#/p/stack/roadmap');
});

test('from the terminal with no project: back where you came from, else home', () => {
  assert.equal(flickTarget(term, { termProject: '', lastAway: '#/timeline', termMounted: true }), '#/timeline');
  assert.equal(flickTarget(term, { termProject: '', lastAway: '', termMounted: true }), '#/');
});

test('to the terminal: bare once mounted, so nothing spawns', () => {
  const board = parseHash('#/p/stack/roadmap');
  assert.equal(flickTarget(board, { termProject: '', lastAway: '', termMounted: true }), '#/terminal');
  assert.equal(flickTarget(board, { termProject: '', lastAway: '', termMounted: false }), '#/terminal?cwd=stack');
  assert.equal(flickTarget(parseHash('#/timeline'), { termProject: '', lastAway: '', termMounted: false }), '#/terminal');
});

test('the key is ⌃` alone', () => {
  const k = (o) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: 'Backquote', ...o });
  assert.ok(isFlickKey(k({ ctrlKey: true })));
  assert.ok(!isFlickKey(k({})));
  assert.ok(!isFlickKey(k({ ctrlKey: true, shiftKey: true })));
  assert.ok(!isFlickKey(k({ ctrlKey: true, code: 'KeyB' })));
});
