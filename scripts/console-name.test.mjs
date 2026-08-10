#!/usr/bin/env node
// Tests for web/src/lib/agentConsole.ts — how a tab agent's console session is
// named, and how that name is read back (#379, #380, BUG-13).
// Run: node --experimental-strip-types scripts/console-name.test.mjs
//
// Same loader arrangement as scripts/feature.test.mjs (#365) — see that file's
// header for why the resolve hook and the dynamic import are both needed. This
// module's one import is `import type`, which strip-types erases outright, so
// the hook is belt-and-braces here rather than load-bearing.
//
// What this pins that nothing else did: the console name is the ONLY evidence
// the Terminal screen has about who a session belongs to. It has no project
// payload and no agent state there, so a parser that says "auditor" about an
// ad-hoc session puts a stranger's work under an agent's name, and one that
// says null about a real console loses the only thing distinguishing it from
// the four beside it. Both directions are failures and both are asserted.
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

const url = new URL('../web/src/lib/agentConsole.ts', import.meta.url);
const { CONSOLE_AGENTS, consoleSessionName, parseConsoleSession, consoleTitle } =
  await import(url.href);

// --- composing --------------------------------------------------------

test('a console name round-trips for every agent that has one', () => {
  assert.ok(CONSOLE_AGENTS.length > 0, 'the catalogue must not be empty');
  for (const a of CONSOLE_AGENTS) {
    const name = consoleSessionName(a.key, 'stack');
    assert.equal(name, `stack-term-${a.key}-stack`);
    const parsed = parseConsoleSession(name);
    assert.deepEqual(parsed, { agentKey: a.key, agentName: a.name, slug: 'stack' });
    // The agent FIRST — that is what the owner is scanning the strip for.
    assert.equal(consoleTitle(parsed), `${a.name} · stack`);
  }
});

test('the stack-term- prefix survives naming, because three host paths key off it', () => {
  // The running-sessions strip, the browser's mirror/kill list and the idle
  // reaper all match `stack-term-*`. A console that lost the prefix would go
  // invisible to all three at once.
  for (const a of CONSOLE_AGENTS) {
    assert.ok(consoleSessionName(a.key, 'stack').startsWith('stack-term-'));
  }
});

test('a slug is sanitised and capped, never trusted — it arrives from the URL', () => {
  // The daemon's validName refuses anything outside stack-[A-Za-z0-9_-]{1,64}
  // and fails the start frame with no useful sentence, so the cleaning happens
  // here where a sentence is still possible.
  const name = consoleSessionName('auditor', 'a b/c..d');
  assert.match(name, /^stack-[A-Za-z0-9_-]+$/);
  const long = consoleSessionName('auditor', 'x'.repeat(200));
  assert.equal(long, `stack-term-auditor-${'x'.repeat(40)}`);
});

// --- reading it back --------------------------------------------------

test('an ad-hoc session is never dressed up as an agent', () => {
  // generateName('term') produces stack-term-<8 hex>. A parser matching
  // `([a-z]+)` instead of the catalogue would read these as consoles.
  for (const n of ['stack-term-2df4732f', 'stack-term-96b155f1', 'stack-term-c3d2a31d']) {
    assert.equal(parseConsoleSession(n), null, `${n} is not a console`);
  }
});

test('null is the answer for anything that is not a console', () => {
  for (const n of [
    '',
    'stack-auto-nightly',              // an autopilot session, deliberately not listed
    'stack-term-wt-somekey',           // a worktree session
    'stack-term-auditor',              // the agent key with no project after it
    'stack-term-auditor-',             // ...and with an empty one
    'stack-term-notanagent-stack',     // a word that is not in the catalogue
    'auditor-stack',                   // no prefix at all
  ]) {
    assert.equal(parseConsoleSession(n), null, `${JSON.stringify(n)} is not a console`);
  }
  assert.equal(parseConsoleSession(null), null);
  assert.equal(parseConsoleSession(undefined), null);
});

test('a slug containing the separator keeps all of itself', () => {
  // The slug is everything after the agent key, not the next segment — a
  // greedy split on '-' would truncate `my-side-project` to `my`.
  const parsed = parseConsoleSession('stack-term-curator-my-side-project');
  assert.equal(parsed.agentKey, 'curator');
  assert.equal(parsed.slug, 'my-side-project');
});

// --- BUG-13 -----------------------------------------------------------

test("BUG-13: a console name is never an ad-hoc cwd's resume session", () => {
  // The Terminal screen remembers one tmux name per cwd so a reload re-attaches
  // the session that was running there. A tab agent's console still lands on
  // that screen (⤢ sends one, and it sits on the detached strip when its tab
  // closes), so attaching one used to write the agent's name against the
  // project directory — after which every NEW claude tab opened there silently
  // re-attached the agent's console and wore its name.
  //
  // The guard on both the read and the write is exactly this predicate, so
  // this is the property the screen depends on: every console name must be
  // recognisable AS one, or the guard cannot refuse it.
  const resumable = (name) => !parseConsoleSession(name);

  for (const a of CONSOLE_AGENTS) {
    assert.equal(resumable(consoleSessionName(a.key, 'stack')), false,
      `${a.name}'s console must never be stored as a cwd resume session`);
  }
  // ...and the ordinary sessions the map exists FOR are still resumable.
  for (const n of ['stack-term-2df4732f', 'stack-term-96b155f1']) {
    assert.equal(resumable(n), true, `${n} is exactly what the resume map is for`);
  }
});
