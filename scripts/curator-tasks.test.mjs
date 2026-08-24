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
// than by naming them — the next command added without either is a failure here
// rather than a surprise on the board. That matters more since #428 emptied the
// catalogue down to one: a check written against named tasks would have been
// deleted with them and covered nothing thereafter.
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
const { ARRANGE_TASKS, TOP_LEVEL_TASKS, taskByKey, scopeLine } = await import(url.href);

const scope = (over = {}) => ({ slug: 'stack', areaFilter: '', ...over });

// The six that went were all timeline arithmetic and went WITH the Timeline
// (#428) — an op moves with its surface. This asserts the catalogue is what is
// left rather than asserting a count, so adding a board-shaped command is a
// one-line change here and not a rewrite.
test('the catalogue is the one side action, and no top-level commands are left', () => {
  assert.deepEqual(ARRANGE_TASKS.map((t) => t.key), ['allocate']);
  // `allocate` is drawn INSIDE the ✧ read's card, not as a button of its own —
  // two top-level buttons with the same name would be a puzzle, not a choice.
  assert.deepEqual(ARRANGE_TASKS.filter((t) => t.side).map((t) => t.key), ['allocate']);
  assert.deepEqual(TOP_LEVEL_TASKS.map((t) => t.key), []);
  for (const t of ARRANGE_TASKS) assert.ok(t.views.length > 0, `${t.key} belongs to no board`);
});

// It is a SECOND WAY to run the ✧ read, so the two must agree about what they
// act on. The read works the untagged rows whatever the chip says; a brief that
// let the chip narrow it would send the session after the one population that
// by definition holds none of them.
test('the side allocation works the untagged rows whatever the chip says', () => {
  const t = taskByKey('allocate');
  assert.equal(t.wide, true);
  const narrow = t.brief(scope({ areaFilter: 'agents' }));
  assert.doesNotMatch(narrow, /ONLY the items in the "agents" area/);
  assert.match(narrow, /whatever the board is filtered to/);
});

test('the side allocation changes the area and nothing else, and says which areas are new', () => {
  const b = taskByKey('allocate').brief(scope());
  assert.match(b, /PREFER THE AREAS THIS PROJECT ALREADY USES/);
  assert.match(b, /which ones would be new/);
  assert.match(b, /no retitling, no re-bucketing/);
  // The same escape hatch the ✧ read's prompt gives: an unplaceable item is
  // left alone rather than guessed at.
  assert.match(b, /LEAVE OUT anything you genuinely cannot place/);
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

test('the untagged chip is a population, not an area called unallocated', () => {
  const line = scopeLine('UNALLOCATED');
  assert.match(line, /carrying no area at all/);
  assert.doesNotMatch(line, /the "UNALLOCATED" area/);
});

// The catalogue is down to one task, so the two properties every brief must
// carry are asserted over it alone — and they are asserted by ITERATING, so the
// next command added is covered the moment it lands rather than when somebody
// remembers to add a case.
test('an unknown key resolves to nothing rather than a stray brief', () => {
  assert.equal(taskByKey('nonsense'), undefined);
});
