#!/usr/bin/env node
// Tests for web/src/lib/termName.ts — the keystroke replay that names a
// terminal session after the first thing the human sent it (#512).
// Run: node --experimental-strip-types scripts/termname.test.mjs
//
// WHAT THIS PINS, and why it is worth a test at all: the input is a KEYSTROKE
// STREAM, not a string. Everything here is a case where the naive
// `chunk.split('\r')[0]` names a session something the human never typed —
// a backspaced typo, a bracketed paste, an arrow key, the bare Enter that
// answers claude's trust prompt. Each of those shipped as a bug in some
// terminal somewhere; this is the list.
//
// Same loader shim as scripts/spine.test.mjs (#365): termName.ts is TypeScript
// living under web/, outside this repo's module graph. See that file's header.
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

const url = new URL('../web/src/lib/termName.ts', import.meta.url);
const { newCapture, feedTyped, nameFrom } = await import(url.href);

/** Feed a stream one character at a time — the way xterm actually delivers
 *  typing — and return the first name it produced. */
const typeOut = (s) => {
  const st = newCapture();
  for (const ch of s) {
    const got = feedTyped(st, ch);
    if (got) return got;
  }
  return null;
};

test('the first submitted line is the name, verbatim', () => {
  assert.equal(typeOut('why is the dispatcher skipping 477\r'), 'why is the dispatcher skipping 477');
});

test('case is never improved — what you wrote is what it is called', () => {
  assert.equal(typeOut('npm run build\r'), 'npm run build');
  assert.equal(typeOut('/checkpoint\r'), '/checkpoint');
});

test('backspaces are replayed, not recorded', () => {
  assert.equal(typeOut('ehco\x7f\x7f\x7f\x7fecho hello\r'), 'echo hello');
});

test('control-U abandons the line and the capture stays open', () => {
  assert.equal(typeOut('wrong thing\x15the real question\r'), 'the real question');
});

test('control-C abandons the line too', () => {
  assert.equal(typeOut('half a thought\x03fix the rail\r'), 'fix the rail');
});

test('control-W drops the last word', () => {
  assert.equal(typeOut('fix the raiil\x17rail\r'), 'fix the rail');
});

test('arrow keys and other CSI sequences are keys, not characters', () => {
  assert.equal(typeOut('rebuild\x1b[D\x1b[C the icons\r'), 'rebuild the icons');
  assert.equal(typeOut('\x1b[A\x1b[Bcheck the lanes\r'), 'check the lanes');
});

test('a bracketed paste contributes its payload and not its wrapper', () => {
  assert.equal(
    typeOut('\x1b[200~audit the merge probe\x1b[201~\r'),
    'audit the merge probe',
  );
});

test('THE TRUST PROMPT DOES NOT NAME THE SESSION — a bare Enter is not a name', () => {
  assert.equal(typeOut('\rwire the board tab\r'), 'wire the board tab');
});

test('…and neither does a single-digit menu answer', () => {
  assert.equal(typeOut('1\rwire the board tab\r'), 'wire the board tab');
  assert.equal(typeOut('2\r'), null);
});

test('a line with no letter in it is not a name', () => {
  assert.equal(nameFrom('1'), '');
  assert.equal(nameFrom('2026-09-14'), '');
  assert.equal(nameFrom('   '), '');
});

test('two characters is below the floor', () => {
  assert.equal(nameFrom('ls'), '');
  assert.equal(nameFrom('cat'), 'cat');
});

test('whitespace is collapsed but nothing else is touched', () => {
  assert.equal(nameFrom('  give   risk   a  surface  '), 'give risk a surface');
  assert.equal(typeOut('a\tb\r'), 'a b');
});

test('a long line is cut on a word boundary with an ellipsis', () => {
  const got = nameFrom(
    'arbitrate the branch parser divergence that scripts branch test mjs records today');
  assert.ok(got.endsWith('…'), got);
  assert.ok(got.length <= 61, `${got.length}: ${got}`);
  assert.ok(!/[\s,.;:]…$/.test(got), got);
  assert.ok(got.startsWith('arbitrate the branch parser divergence'), got);
});

test('a long unbroken line is cut hard rather than left whole', () => {
  const got = nameFrom('x'.repeat(200));
  assert.equal(got, `${'x'.repeat(60)}…`);
});

test('NAMED ONCE: the capture latches and later lines are ignored', () => {
  const st = newCapture();
  assert.equal(feedTyped(st, 'first question\r'), 'first question');
  assert.equal(feedTyped(st, 'second question\r'), null);
  assert.equal(feedTyped(st, 'third question\r'), null);
  assert.ok(st.done);
});

test('the buffer does not grow without limit before a submit', () => {
  const st = newCapture();
  feedTyped(st, 'y'.repeat(5000));
  assert.ok(st.buf.length <= 400, String(st.buf.length));
});

test('a stream split across chunks reads the same as one typed straight', () => {
  const st = newCapture();
  assert.equal(feedTyped(st, 'give risk a '), null);
  assert.equal(feedTyped(st, 'surface again'), null);
  assert.equal(feedTyped(st, '\r'), 'give risk a surface again');
});
