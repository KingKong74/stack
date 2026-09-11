#!/usr/bin/env node
// Tests for web/src/lib/branch.ts — the CLIENT's half of the branch convention
// (#363), and the one MIRROR in this repo that nothing was holding in step.
// Run: node --experimental-strip-types scripts/branch.test.mjs
//
// Same loader shim as scripts/spine.test.mjs: branch.ts is TypeScript living
// under web/, outside this repo's module graph, and imports its siblings with
// no extension. See that file's header for why both pieces are needed.
//
// WHY THIS FILE EXISTS. CLAUDE.md says it out loud: `scripts/lib/lane.mjs` is
// the canonical namer AND parser, `web/src/lib/branch.ts` is its client twin,
// and the two are "kept in step by discipline, not a shared test". Discipline
// is what a repo has instead of a test until somebody writes one. The packages
// genuinely cannot import each other — one is host-side CJS-adjacent ESM run by
// `./stack`, the other is bundled into the browser — so the copy is real and
// permanent, and the only thing that can hold it together is an assertion that
// reads BOTH. Section C is that assertion; A and B pin what the client half
// does that the host half has no opinion about.
//
// The two rules with actual teeth, both from CLAUDE.md:
//
//   • THE OLD FLAT `auto/item-N-<slug>` SPELLING MUST KEEP PARSING FOREVER.
//     Those branches are on origin and in live `claimed_by` strings, so a
//     reader that knows only the new form reports a WORKING FLEET AS EMPTY —
//     a total loss of signal that looks exactly like a quiet night.
//   • A LEGACY LANE'S KIND IS `''`, NEVER `feat`. The old spelling genuinely
//     does not record what sort of change it carries, and a ledger that
//     guesses a label the branch never claimed is worse than one that shows it
//     unlabelled.
//
// And the merge state's own version of the NULL-verdict rule: `unprobed` is not
// `clean`. That one is section B.
//
// VALIDATED BY MUTATION. Six regressions were introduced into branch.ts on
// purpose and this file run against each:
//
//   a legacy lane guesses `feat`                → 2 fails
//   `unprobed` folded into `clean`              → 2 fails
//   the legacy spelling stops parsing           → 4 fails
//   a kind dropped from the client's list alone → 7 fails  (the drift, section C)
//   a tone becomes a literal hex                → 1 fail
//   `behind` checked before `conflict`          → 2 fails
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

const clientUrl = new URL('../web/src/lib/branch.ts', import.meta.url);
const {
  parseBranch, mergeStateOf, isMergeable, LANE_KINDS, KIND_HINT, KIND_TONE,
  MERGE_STATES, MERGE_STATE_META,
} = await import(clientUrl.href);

// The HOST's copy — the canonical one, imported here and nowhere else in the
// client's world, purely so the two can be compared.
const { parseBranch: hostParse, LANE_KINDS: HOST_KINDS, isLaneBranch } =
  await import(new URL('./lib/lane.mjs', import.meta.url).href);

// ---- A. what the client reads off a branch name ---------------------------

test('the current convention: <kind>/<id>-<summary>', () => {
  assert.deepEqual(parseBranch('feat/271-mission-control'),
    { kind: 'feat', itemId: 271, bugKey: '', summary: 'mission-control', legacy: false });
});

test('a bug lane carries a KEY and no item id, upper-cased', () => {
  assert.deepEqual(parseBranch('fix/bug-12-terminal-hangs'),
    { kind: 'fix', itemId: null, bugKey: 'BUG-12', summary: 'terminal-hangs', legacy: false });
});

test('a bug lane and the roadmap item of the same number never collide', () => {
  const bug = parseBranch('fix/bug-42-x');
  const item = parseBranch('feat/42-x');
  assert.equal(bug.itemId, null);
  assert.equal(bug.bugKey, 'BUG-42');
  assert.equal(item.itemId, 42);
  assert.equal(item.bugKey, '');
});

test('every one of the eight kinds parses', () => {
  for (const k of LANE_KINDS) {
    assert.equal(parseBranch(`${k}/7-x`).kind, k, `${k} did not parse`);
  }
});

test('a kind with no id still tells the ledger the kind', () => {
  assert.deepEqual(parseBranch('ui/merge-room'),
    { kind: 'ui', itemId: null, bugKey: '', summary: 'merge-room', legacy: false });
});

test('a lane with no summary is still a lane', () => {
  assert.deepEqual(parseBranch('chore/88'),
    { kind: 'chore', itemId: 88, bugKey: '', summary: '', legacy: false });
});

test('THE LEGACY FLAT SPELLING STILL RESOLVES ITS ITEM', () => {
  // The rule with the most to lose: these branches are on origin and named in
  // live `claimed_by` strings. A reader that cannot see them reports a working
  // fleet as empty.
  const p = parseBranch('auto/item-271-mission-control');
  assert.equal(p.itemId, 271);
  assert.equal(p.summary, 'mission-control');
  assert.equal(p.legacy, true);
});

test('…and its kind is EMPTY, never feat', () => {
  assert.equal(parseBranch('auto/item-271-x').kind, '',
    'the old spelling does not record a kind, and guessing one is worse than showing none');
});

test('the other legacy prefix (`lane/`) parses the same way', () => {
  assert.equal(parseBranch('lane/item-9-x').itemId, 9);
  assert.equal(parseBranch('lane/bug-3-x').bugKey, 'BUG-3');
});

test('a legacy BUG lane does claim fix, because the name says bug', () => {
  assert.deepEqual(parseBranch('auto/bug-12-terminal'),
    { kind: 'fix', itemId: null, bugKey: 'BUG-12', summary: 'terminal', legacy: true });
});

test('a legacy AUDIT lane claims test and keeps its date in the summary', () => {
  assert.deepEqual(parseBranch('auto/audit-2026-08-02'),
    { kind: 'test', itemId: null, bugKey: '', summary: 'audit-2026-08-02', legacy: true });
});

test('a collision suffix does not change what is read', () => {
  // #235 appends `-2`, `-3`… AFTER the summary, where every id parser already
  // stops reading, so a collision stays invisible to every reader.
  assert.equal(parseBranch('feat/271-mission-control-2').itemId, 271);
  assert.equal(parseBranch('chore/88-3').itemId, 88);
  assert.equal(parseBranch('fix/bug-12-terminal-2').bugKey, 'BUG-12');
});

test('case is not part of the convention', () => {
  const p = parseBranch('FEAT/42-Some-Thing');
  assert.equal(p.kind, 'feat', 'the kind comes back normalised');
  assert.equal(p.itemId, 42);
});

test('surrounding whitespace is trimmed, not parsed', () => {
  assert.equal(parseBranch('  feat/42-x  ').itemId, 42);
});

test('an unrelated branch says nothing rather than guessing', () => {
  for (const name of ['main', 'idea/some-idea', 'wip', '', null, undefined]) {
    const p = parseBranch(name);
    assert.equal(p.kind, '', `${name} claimed a kind`);
    assert.equal(p.itemId, null, `${name} claimed an item`);
    assert.equal(p.bugKey, '', `${name} claimed a bug`);
    assert.equal(p.legacy, false, `${name} claimed to be legacy`);
  }
});

test('a name that only LOOKS like a kind is not one', () => {
  assert.equal(parseBranch('feature/42-x').kind, '', 'feature is not feat');
  assert.equal(parseBranch('feat-42-x').kind, '', 'the slash is the separator, not a hyphen');
});

// ---- B. the four-valued merge state ---------------------------------------

test('UNPROBED IS NOT CLEAN — no probe ran is not no conflict found', () => {
  // The same rule as a NULL review_verdict, in the one derivation the merge
  // planning reads. Every shape of "the host did not tell us".
  assert.equal(mergeStateOf({}), 'unprobed');
  assert.equal(mergeStateOf({ mergeClean: null }), 'unprobed');
  assert.equal(mergeStateOf({ mergeClean: undefined }), 'unprobed');
  assert.equal(mergeStateOf({ mergeClean: null, behind: 4 }), 'unprobed',
    'being behind says nothing about whether it merges');
});

test('a conflict is a FACT the host reported, and outranks everything', () => {
  assert.equal(mergeStateOf({ mergeClean: false }), 'conflict');
  assert.equal(mergeStateOf({ mergeClean: false, behind: 0 }), 'conflict');
  assert.equal(mergeStateOf({ mergeClean: false, behind: 9 }), 'conflict',
    'order matters: a conflicting branch is not reported as merely behind');
});

test('clean means probed AND level; behind means probed and not level', () => {
  assert.equal(mergeStateOf({ mergeClean: true }), 'clean');
  assert.equal(mergeStateOf({ mergeClean: true, behind: 0 }), 'clean');
  assert.equal(mergeStateOf({ mergeClean: true, behind: 1 }), 'behind');
});

test('behind is MERGEABLE and unprobed is not', () => {
  // `behind` is a sub-state of mergeable: the probe already says the merge
  // succeeds, and what is missing is that nothing has built the branch against
  // the main it would land on — worth showing, not worth refusing.
  assert.equal(isMergeable('clean'), true);
  assert.equal(isMergeable('behind'), true);
  assert.equal(isMergeable('conflict'), false);
  assert.equal(isMergeable('unprobed'), false, 'an unprobed branch has never been asked');
});

test('every merge state is listed and every listed state is drawable', () => {
  // A state with no META entry renders as `undefined` — no label, no tone, and
  // no error anywhere to say so.
  const derived = new Set([
    mergeStateOf({}), mergeStateOf({ mergeClean: false }),
    mergeStateOf({ mergeClean: true }), mergeStateOf({ mergeClean: true, behind: 1 }),
  ]);
  assert.deepEqual([...derived].sort(), ['behind', 'clean', 'conflict', 'unprobed']);
  assert.deepEqual([...MERGE_STATES].sort(), ['behind', 'clean', 'conflict', 'unprobed']);
  for (const s of MERGE_STATES) {
    assert.ok(MERGE_STATE_META[s]?.label, `${s} has no label`);
    assert.ok(MERGE_STATE_META[s]?.tone, `${s} has no tone`);
    assert.ok(MERGE_STATE_META[s]?.hint, `${s} has no hint`);
  }
});

test('unprobed says so in its own words, because a reader will act on it', () => {
  assert.match(MERGE_STATE_META.unprobed.hint, /not clean/i);
});

// ---- the kind catalogues --------------------------------------------------

test('every kind has a hint and a tone, and no tone is a literal colour', () => {
  // styles.css owns the palette (CLAUDE.md: never an inline hex), and these
  // strings are handed straight to a style attribute.
  for (const k of LANE_KINDS) {
    assert.ok(KIND_HINT[k], `${k} has no hint`);
    assert.match(KIND_TONE[k], /^var\(--[a-z-]+\)$/, `${k}'s tone is not a token`);
  }
  assert.equal(Object.keys(KIND_HINT).length, LANE_KINDS.length, 'a hint for a kind that does not exist');
  assert.equal(Object.keys(KIND_TONE).length, LANE_KINDS.length);
});

// ---- C. THE MIRROR ---------------------------------------------------------
//
// The whole reason this file exists. `scripts/lib/lane.mjs` names the branches
// and `web/src/lib/branch.ts` reads them; if the two ever disagree about what a
// name means, the host cuts branches the browser cannot see, or the browser
// attributes work to the wrong item. Neither package can import the other, so
// this is the only thing standing between them.

const CORPUS = [
  'feat/271-mission-control', 'fix/bug-12-terminal-hangs', 'ui/merge-room',
  'refactor/9-tidy', 'perf/3-faster', 'test/audit-2026-08-02', 'docs/1-readme',
  'chore/88', 'chore/88-3', 'feat/271-mission-control-2', 'FEAT/42-Some-Thing',
  'auto/item-271-mission-control', 'auto/item-42', 'lane/item-9-x',
  'auto/bug-12-terminal', 'lane/bug-3-x', 'auto/audit-2026-08-02',
  'fix/bug-42-x', 'feat/42-x', 'feat/0-zero', 'feat/999999-big',
  'main', 'idea/some-idea', 'wip', '', 'feature/42-x', 'feat-42-x',
  '  feat/42-x  ', 'release/v2', 'hotfix/urgent',
];

test('both halves read the SAME kind, item, bug and legacy flag off every name', () => {
  for (const name of CORPUS) {
    const a = parseBranch(name);
    const b = hostParse(name);
    assert.deepEqual(
      { kind: a.kind, itemId: a.itemId, bugKey: a.bugKey, legacy: a.legacy },
      { kind: b.kind, itemId: b.itemId, bugKey: b.bugKey, legacy: b.legacy },
      `the two parsers disagree about "${name}"`,
    );
  }
});

test('and the same summary, for every name either of them calls a lane', () => {
  // Scoped to lane names on purpose — see the next test for the one place the
  // two deliberately differ, and why it is not a defect.
  for (const name of CORPUS) {
    if (!isLaneBranch(name)) continue;
    assert.equal(parseBranch(name).summary, hostParse(name).summary,
      `the two parsers disagree about the summary of "${name}"`);
  }
});

test('A KNOWN, INERT DIVERGENCE: a NON-lane name keeps its text on the client', () => {
  // The host returns summary '' for a name it does not recognise; the client
  // returns the name itself, so a branch that is not a lane can still be
  // LABELLED with something in a list. Recorded here rather than quietly
  // allowed, because it is inert only for as long as nothing reads `summary`
  // for a non-lane branch — `lib/spine.ts` is the sole consumer today and it
  // reads `.kind` alone. Align the two the moment anything renders one.
  assert.equal(hostParse('main').summary, '');
  assert.equal(parseBranch('main').summary, 'main');
  assert.equal(parseBranch('release/v2').summary, 'release/v2');
  // Whatever else moves, neither may ever claim a KIND for such a name.
  assert.equal(parseBranch('main').kind, '');
  assert.equal(hostParse('main').kind, '');
});

test('the two kind vocabularies are the same list in the same order', () => {
  // Order is load-bearing: both build their regex alternation from it, and a
  // kind present in one and not the other is a branch one half cannot parse.
  assert.deepEqual([...LANE_KINDS], [...HOST_KINDS]);
});

test('a name the host would CUT is a name the client can read back', () => {
  // The round trip that matters: lane.mjs names it, branch.ts reads it. Built
  // from the host's own vocabulary so a new kind cannot be added to one side
  // alone without this failing.
  for (const k of HOST_KINDS) {
    for (const [name, want] of [
      [`${k}/17-a-summary`, { kind: k, itemId: 17, bugKey: '' }],
      [`${k}/bug-17-a-summary`, { kind: k, itemId: null, bugKey: 'BUG-17' }],
    ]) {
      const p = parseBranch(name);
      assert.deepEqual({ kind: p.kind, itemId: p.itemId, bugKey: p.bugKey }, want,
        `the client cannot read back "${name}"`);
    }
  }
});
