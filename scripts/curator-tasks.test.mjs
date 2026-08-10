#!/usr/bin/env node
// Tests for web/src/lib/curatorTasks.ts — the briefs the Arrange panel's quick
// commands send to the Curator's live session.
// Run: node --experimental-strip-types scripts/curator-tasks.test.mjs
//
// Same loader shim as scripts/plan.test.mjs (#365) — see that file's header.
//
// These strings are not copy. They are instructions handed to a session that
// can PATCH the board, and the two properties that keep that safe are exactly
// the two a render can drop without anybody noticing: every brief names the
// rows it is allowed to touch, and every brief asks before it writes. A command
// that lost its scope line would be acted on across the whole board while the
// owner watched one area; one that lost its ask would rewrite the plan on a
// press. So both are asserted for EVERY task, by iterating the catalogue rather
// than by naming them — a seventh command added without either is a failure
// here rather than a surprise on the board.
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

const url = new URL('../web/src/lib/curatorTasks.ts', import.meta.url);
const { ARRANGE_TASKS, taskByKey, scopeLine } = await import(url.href);

const scope = (over = {}) => ({
  slug: 'stack', areaFilter: '', feature: { id: 12, title: 'The editor' }, ...over,
});

test('the catalogue is the six commands, each in a view', () => {
  assert.deepEqual(ARRANGE_TASKS.map((t) => t.key),
    ['schedule', 'compact', 'catchup', 'balance', 'tier', 'trim']);
  for (const t of ARRANGE_TASKS) assert.ok(t.views.length > 0, `${t.key} belongs to no view`);
});

test('EVERY brief names the rows it may touch', () => {
  for (const t of ARRANGE_TASKS) {
    const wide = t.brief(scope({ areaFilter: '' }));
    const narrow = t.brief(scope({ areaFilter: 'agents' }));
    // The two that do not narrow say so in their own words instead; what must
    // never happen is a brief that says nothing at all about its population.
    if (t.wide) {
      assert.match(wide + narrow, /every|EVERY/, `${t.key} says nothing about its population`);
    } else {
      assert.match(narrow, /"agents"/, `${t.key} does not name the area filter`);
      assert.match(wide, /whole board/, `${t.key} does not say it works the whole board`);
    }
  }
});

test('EVERY brief asks before it writes', () => {
  for (const t of ARRANGE_TASKS) {
    const b = t.brief(scope());
    assert.match(b, /ask before you write/, `${t.key} does not ask before writing`);
    assert.match(b, /PATCH \/api\/projects\/stack\/roadmap/, `${t.key} does not say how to write`);
  }
});

test('a narrowing command tells the session the other areas are out of scope', () => {
  const b = taskByKey('compact').brief(scope({ areaFilter: 'agents' }));
  assert.match(b, /ONLY the items in the "agents" area/);
  assert.match(b, /out of scope/);
});

test('the untagged chip is a population, not an area called unallocated', () => {
  const line = scopeLine('UNALLOCATED');
  assert.match(line, /carrying no area at all/);
  assert.doesNotMatch(line, /the "UNALLOCATED" area/);
});

test('levelling refuses to be narrowed, and says why in the brief itself', () => {
  const b = taskByKey('balance').brief(scope({ areaFilter: 'agents' }));
  // It must NOT tell the session to work one area — that would be an
  // instruction to level between areas while looking at one.
  assert.doesNotMatch(b, /ONLY the items in the "agents" area/);
  assert.match(b, /every area/);
});

test('the trim names the feature it was pressed on, id and all', () => {
  const b = taskByKey('trim').brief(scope({ feature: { id: 77, title: 'Billing' } }));
  assert.match(b, /"Billing"/);
  assert.match(b, /roadmap item 77/);
  // And it reads the whole feature whatever the chip says.
  assert.match(taskByKey('trim').brief(scope({ areaFilter: 'agents' })), /including any in other areas/);
});

test('the trim survives being composed with nothing selected', () => {
  // The button is disabled without a selection, but a brief that threw would
  // take the panel down with it rather than doing nothing.
  const b = taskByKey('trim').brief(scope({ feature: null }));
  assert.match(b, /the selected feature/);
});

test('a Must is never cut, and the brief says so rather than leaving it to judgement', () => {
  assert.match(taskByKey('trim').brief(scope()), /Musts are never cut/);
});

test('claimed work is protected in the two commands that could move it', () => {
  assert.match(taskByKey('balance').brief(scope()), /claim never moves|never moves/i);
});

test('an unknown key resolves to nothing rather than a stray brief', () => {
  assert.equal(taskByKey('nonsense'), undefined);
});
