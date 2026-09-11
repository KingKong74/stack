#!/usr/bin/env node
// Tests for web/src/lib/route.ts — the hash router every screen in the app is
// reached through.
// Run: node --experimental-strip-types scripts/route.test.mjs
//
// Same loader shim as scripts/spine.test.mjs.
//
// WHY A ROUTER EARNS A TEST WHEN NOTHING VISIBLE BREAKS. A routing bug does not
// throw and does not render an error — it renders the WRONG PAGE, or the
// dashboard, and the only person who finds out is whoever followed the link.
// Three classes of that, all of them live in this repo:
//
//   • THE CULLED SURFACES MUST NOT 404. Mission Control's rooms, the Futures
//     tab, the Workbench's notes and the recipe library are all gone, and their
//     URLs are all still in bookmarks, in older search payloads and in six
//     screens' worth of topbar history. `#/control/review` landing on the
//     placeholder is what says "this is being rebuilt"; landing on the
//     dashboard says "this app is broken".
//   • ANYTHING A USER TYPED HAS TO SURVIVE THE ROUND TRIP. A slug or an `hl`
//     carrying a slash, a space, a `?` or a `#` is encoded on the way out and
//     must come back byte-identical, or a deep link silently opens a different
//     row — or no row.
//   • THE ORDER OF THE ARMS IS PART OF THE CONTRACT. A project whose slug is
//     "terminal" must still open as a project.
//
// `parseHash` is exported and takes the hash as an argument (the same injection
// `util.pushCadence` uses for `today`) precisely so this file can exist without
// a browser. `useRoute` is the thin wrapper that reads `window` and is not
// tested here — there is nothing in it but the subscription.
//
// VALIDATED BY MUTATION. Five regressions were introduced into route.ts on
// purpose and this file run against each:
//
//   a second decodeURIComponent on `hl`   → 3 fails  (the bug this file found)
//   path decoding throws on a bad escape  → 1 fail
//   a culled room 404s to the dashboard   → 1 fail
//   the share token swallows the query    → 1 fail
//   `brief=0` reads as true               → 2 fails
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

const { parseHash, hrefTo } = await import(new URL('../web/src/lib/route.ts', import.meta.url).href);

// ---- A. the flat screens ---------------------------------------------------

test('the bare screens resolve, with or without the leading #', () => {
  for (const [hash, name] of [
    ['#/', 'dashboard'], ['/', 'dashboard'], ['', 'dashboard'], ['#', 'dashboard'],
    ['#/settings', 'settings'], ['#/timeline', 'timeline'],
    ['#/control', 'control'], ['#/skills', 'skills'],
  ]) {
    assert.equal(parseHash(hash).name, name, `${JSON.stringify(hash)} did not resolve`);
  }
});

test('A CULLED ROOM LANDS ON ITS PLACEHOLDER, never on a 404 or the dashboard', () => {
  // Mission Control's seven rooms went; these URLs did not.
  for (const hash of ['#/control/review', '#/control/nights', '#/control/merge', '#/control/anything/deeper']) {
    assert.equal(parseHash(hash).name, 'control', `${hash} fell off the router`);
  }
});

test('a trailing segment on any flat screen is ignored rather than fatal', () => {
  assert.equal(parseHash('#/settings/notifications').name, 'settings');
  assert.equal(parseHash('#/timeline/2026-08').name, 'timeline');
  assert.equal(parseHash('#/skills/some-skill').name, 'skills');
});

test('a hash nobody recognises is the dashboard, not a blank screen', () => {
  for (const hash of ['#/nonsense', '#/p', '#//', '#/?x=1', 'garbage']) {
    assert.equal(parseHash(hash).name, 'dashboard', `${hash} should fall back`);
  }
});

test('a null or undefined hash does not throw', () => {
  assert.equal(parseHash(null).name, 'dashboard');
  assert.equal(parseHash(undefined).name, 'dashboard');
});

// ---- B. the terminal, and its three optional parameters --------------------

test('the terminal carries cwd, attach and brief, each independently optional', () => {
  assert.deepEqual(parseHash('#/terminal'),
    { name: 'terminal', cwd: undefined, attach: undefined, brief: undefined });
  assert.deepEqual(parseHash('#/terminal?cwd=%2Fhome%2Fbailey%2Fstack'),
    { name: 'terminal', cwd: '/home/bailey/stack', attach: undefined, brief: undefined });
  assert.deepEqual(parseHash('#/terminal?attach=stack-term-bf2fb4ec'),
    { name: 'terminal', cwd: undefined, attach: 'stack-term-bf2fb4ec', brief: undefined });
  assert.deepEqual(parseHash('#/terminal?cwd=%2Fsrv&attach=stack-term-a&brief=1'),
    { name: 'terminal', cwd: '/srv', attach: 'stack-term-a', brief: true });
});

test('brief is ONLY the literal 1 — anything else is absent, not false', () => {
  // It is a tri-state on the Route type (`brief?: boolean`), and an explicit
  // `false` and an absent value are different things to the screen that reads it.
  for (const v of ['0', 'true', 'yes', '']) {
    assert.equal(parseHash(`#/terminal?brief=${v}`).brief, undefined, `brief=${v}`);
  }
  assert.equal(parseHash('#/terminal?brief=1').brief, true);
});

test('a cwd with a space survives the round trip', () => {
  const cwd = '/home/bailey/my projects/stack';
  assert.equal(parseHash(hrefTo.terminal(cwd)).cwd, cwd);
});

// ---- C. the public showcase ------------------------------------------------

test('a share link carries a slug and a token, both decoded', () => {
  assert.deepEqual(parseHash('#/share/stack/abc123'),
    { name: 'share', slug: 'stack', token: 'abc123' });
});

test('a share link stops at a query string rather than swallowing it', () => {
  assert.equal(parseHash('#/share/stack/abc123?x=1').token, 'abc123');
});

test('a share slug with an encoded slash comes back with its slash', () => {
  assert.deepEqual(parseHash('#/share/my%2Fproject/tok'),
    { name: 'share', slug: 'my/project', token: 'tok' });
});

// ---- D. a project, its tab and its highlight -------------------------------

test('a project with no tab leaves the tab undefined, not blank', () => {
  assert.deepEqual(parseHash('#/p/stack'),
    { name: 'detail', id: 'stack', tab: undefined, highlight: undefined });
});

test('a project with a tab, and with a highlight on it', () => {
  assert.deepEqual(parseHash('#/p/stack/quality'),
    { name: 'detail', id: 'stack', tab: 'quality', highlight: undefined });
  assert.deepEqual(parseHash('#/p/stack/roadmap?hl=497'),
    { name: 'detail', id: 'stack', tab: 'roadmap', highlight: '497' });
});

test('an empty hl is absent, not an empty highlight', () => {
  assert.equal(parseHash('#/p/stack/roadmap?hl=').highlight, undefined);
});

test('other query parameters do not disturb hl', () => {
  assert.equal(parseHash('#/p/stack/roadmap?foo=1&hl=497&bar=2').highlight, '497');
});

test('THE ARM ORDER IS PART OF THE CONTRACT: a project may be called "terminal"', () => {
  // Every flat screen is matched on a prefix before `/p/` is tried, so the
  // ones that could collide are worth naming.
  for (const slug of ['terminal', 'settings', 'control', 'skills', 'timeline', 'share', 'p']) {
    const r = parseHash(`#/p/${slug}/quality`);
    assert.equal(r.name, 'detail', `#/p/${slug} stopped being a project`);
    assert.equal(r.id, slug);
  }
});

// ---- E. the round trip -----------------------------------------------------
//
// hrefTo builds the links and parseHash reads them; if the two ever disagree,
// every anchor in the app points somewhere its own router cannot resolve.

test('every flat href parses back to the screen it names', () => {
  assert.equal(parseHash(hrefTo.dashboard).name, 'dashboard');
  assert.equal(parseHash(hrefTo.timeline).name, 'timeline');
  assert.equal(parseHash(hrefTo.control).name, 'control');
  assert.equal(parseHash(hrefTo.settings).name, 'settings');
  assert.equal(parseHash(hrefTo.skills).name, 'skills');
});

test('a slug carrying anything a user can type survives the round trip', () => {
  for (const id of [
    'stack', 'my project', 'a/b', 'a?b', 'a#b', 'a&b=c', '100%', 'проект', 'emoji-🐛',
  ]) {
    const r = parseHash(hrefTo.detail(id, 'quality'));
    assert.equal(r.name, 'detail', `${id} fell off the router`);
    assert.equal(r.id, id, `${id} did not survive`);
    assert.equal(r.tab, 'quality', `${id} lost its tab`);
  }
});

test('a highlight carrying the same survives it too', () => {
  // THE PERCENT SIGNS ARE THE POINT OF THIS LIST. `hl` is read through
  // URLSearchParams, which already decodes it; a second decodeURIComponent on
  // top threw a URIError out of the router for "100%" — a blank screen for that
  // URL with nothing to say why — and turned a real "%2F" into a slash. A
  // corpus without a `%` in it passed the whole time.
  for (const hl of [
    '497', 'BUG-12', 'a b', 'a/b', 'a?b', 'a&b', 'a#b', 'c4f8d83',
    '100%', 'a%b', '50%25', 'a%2Fb', 'C:%5Ctmp', '%', '%%',
  ]) {
    assert.equal(parseHash(hrefTo.detail('stack', 'roadmap', hl)).highlight, hl, `hl=${hl}`);
  }
});

test('a hand-typed hl is decoded exactly once, like every other query value', () => {
  // The invariant behind the test above, stated directly so a "helpful" extra
  // decode cannot be added back without failing here. `cwd` and `attach` on the
  // terminal arm have always been read this way; `hl` was the odd one out.
  assert.equal(parseHash('#/p/stack/roadmap?hl=a%2Fb').highlight, 'a/b');
  assert.equal(parseHash('#/p/stack/roadmap?hl=100%25').highlight, '100%');
  assert.equal(parseHash('#/terminal?cwd=%2Fa%2Fb').cwd, '/a/b');
});

test('a malformed percent escape does not take the whole app down', () => {
  // The failure mode, asserted as a failure mode: whatever this returns, it
  // must RETURN. A throw here escapes useState(parse) and blanks the screen.
  for (const hash of [
    '#/p/stack/roadmap?hl=%', '#/p/stack/roadmap?hl=%zz',
    '#/p/%/quality', '#/p/%zz', '#/share/%/tok', '#/share/stack/%zz',
  ]) {
    assert.doesNotThrow(() => parseHash(hash), `${hash} threw out of the router`);
  }
  // …and what it renders is the page the URL asked for, with a slug that will
  // simply not be found — never the dashboard, which would read as "that
  // project is gone" rather than "that link is malformed".
  assert.equal(parseHash('#/p/%/quality').name, 'detail');
  assert.equal(parseHash('#/p/%/quality').id, '%');
  assert.equal(parseHash('#/share/%/tok').name, 'share');
});

test('a terminal href with all three parameters parses back to all three', () => {
  const href = hrefTo.terminal('/home/bailey/my stack', 'stack-term-a1b2', true);
  assert.deepEqual(parseHash(href),
    { name: 'terminal', cwd: '/home/bailey/my stack', attach: 'stack-term-a1b2', brief: true });
});

test('an href with no optional parts carries no query string at all', () => {
  // A bare `#/terminal?` would still parse, but it is the thing that ends up in
  // the address bar and in the user's bookmarks.
  assert.equal(hrefTo.terminal(), '#/terminal');
  assert.equal(hrefTo.detail('stack'), '#/p/stack');
  assert.equal(hrefTo.detail('stack', 'quality'), '#/p/stack/quality');
});

test('hrefTo.detail leaves the tab alone — it is the SCREEN that aliases them', () => {
  // The legacy spellings (`bugs`/`audit` → Quality, `tips`/`notes`/`futures` →
  // Overview) are resolved by ProjectDetail's own map, not here, so the router
  // hands a tab through verbatim however old it is. This pins the boundary:
  // an unknown tab must REACH the screen for the screen to be able to alias it.
  for (const tab of ['bugs', 'audit', 'tips', 'notes', 'futures', 'something-new']) {
    assert.equal(parseHash(`#/p/stack/${tab}`).tab, tab, `${tab} was swallowed by the router`);
  }
});
