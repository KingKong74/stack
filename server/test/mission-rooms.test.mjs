#!/usr/bin/env node
// #514 — Mission Control's Models room: the two pure decisions it makes about a
// measured model id. PURE, no database:
//
//   node server/test/mission-rooms.test.mjs
//
// Both of these are cosmetic-looking and neither is. `providerOf` decides which
// card a row of real spend appears under, and a model it does not recognise has
// to land in `other` rather than vanish — an unlabelled bill is still a bill,
// and dropping one is how a provider quietly stops being counted.
//
// `rolesFor` is the one with teeth. The settings row holds a CLI ALIAS and a
// transcript records the id the CLI resolved it to, so the match is containment
// — and containment over an EMPTY alias matches everything. '' means "whatever
// the CLI's own default is", so a blank executor labelling every model on the
// screen as the executor's pick is exactly the confident-wrong-answer failure
// the room exists to avoid. That case is the reason this file exists.

import assert from 'node:assert/strict';
import { providerOf, rolesFor } from '../src/routes/models.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('providerOf');

test('claude ids land on Anthropic, in every spelling that appears in a transcript', () => {
  assert.equal(providerOf('claude-sonnet-4-5-20250929'), 'anthropic');
  assert.equal(providerOf('claude-opus-5'), 'anthropic');
  // The Bedrock/Vertex forms carry the vendor in a path segment.
  assert.equal(providerOf('us.anthropic.claude-opus-4-8'), 'anthropic');
  assert.equal(providerOf('anthropic/claude-haiku-4-5'), 'anthropic');
});

test('gemini ids land on Gemini', () => {
  assert.equal(providerOf('gemini-2.5-flash'), 'gemini');
  assert.equal(providerOf('models/gemini-flash-lite-latest'), 'gemini');
});

test('an unrecognised id is bucketed, NEVER dropped', () => {
  assert.equal(providerOf('qwen3-coder:32b'), 'other');
  assert.equal(providerOf(''), 'other');
  assert.equal(providerOf(null), 'other');
});

console.log('rolesFor');

test('an alias matches the full id the CLI resolved it to', () => {
  assert.deepEqual(rolesFor('claude-sonnet-4-5-20250929', 'sonnet', 'opus'), ['executor']);
  assert.deepEqual(rolesFor('claude-opus-5-20260101', 'sonnet', 'opus'), ['advisor']);
});

test('BOTH roles can land on one row — the same alias on both is a real setting', () => {
  assert.deepEqual(rolesFor('claude-opus-5', 'claude-opus-5', 'claude-opus-5'), ['executor', 'advisor']);
});

test('AN EMPTY ALIAS NEVER MATCHES — the whole point of the file', () => {
  // '' is a substring of every string. Matching on it would label every model
  // on the screen with a role nobody assigned.
  assert.deepEqual(rolesFor('claude-sonnet-4-5', '', ''), []);
  assert.deepEqual(rolesFor('gemini-2.5-flash', '', ''), []);
  // …and a whitespace-only alias is the same thing wearing a space.
  assert.deepEqual(rolesFor('claude-opus-5', '   ', ''), []);
});

test('a model nothing points at is unassigned, which is an ANSWER', () => {
  assert.deepEqual(rolesFor('gemini-2.5-flash', 'sonnet', 'opus'), []);
});

test('the match is case-insensitive, since neither side controls the other’s casing', () => {
  assert.deepEqual(rolesFor('Claude-Sonnet-4-5', 'sonnet', ''), ['executor']);
});

console.log(`\n${n} checks passed.`);
