#!/usr/bin/env node
// Tests for web/src/lib/feature.ts — the pure Trees-room derivation that turns
// a project's claims, branches and worktrees into one row per feature (#365).
// Run: node --experimental-strip-types scripts/feature.test.mjs
//
// feature.ts is TypeScript and lives under web/, outside this repo's Node
// module graph, so two things are needed beyond a plain import: strip-types
// (to run the .ts source at all) and a resolve hook, because feature.ts
// imports its sibling as `./branch` with no extension — a spelling bare Node
// ESM cannot resolve on disk. The hook below teaches the loader to try
// `.ts` on an extensionless relative specifier; nothing else is patched.
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

// Must be a dynamic import: a static import of feature.ts would resolve its
// own `./branch` specifier during the link phase, before the hook above (a
// module-body statement) has run.
const featureUrl = new URL('../web/src/lib/feature.ts', import.meta.url);
const { buildFeatures, worktreesUnseen } = await import(featureUrl.href);

// --- fixtures ---------------------------------------------------------

let seq = 0;
function mkProject(overrides = {}) {
  seq += 1;
  return {
    slug: overrides.slug || `proj-${seq}`,
    name: overrides.name || `Project ${seq}`,
    tint: null,
    status: 'live',
    automode: false,
    progress: 0,
    lastPush: '',
    autopilotArea: '',
    areas: [],
    live: null,
    claims: [],
    branches: [],
    worktrees: [],
    worktreesWhen: null,
    reviewCount: 0,
    bugs: { serious: 0, open: 0 },
    blockers: [],
    nextPick: null,
    lastAuto: null,
    ...overrides,
  };
}

function mkClaim(overrides = {}) {
  return {
    id: '1', title: 'A claim', branch: '',
    planTotal: 0, planDone: 0,
    bucket: 'must', tier: null, risk: '', area: '',
    builtNote: '', reviewTag: '', reviewedAt: null,
    claimedWhen: '',
    ...overrides,
  };
}

function mkBranchRep(overrides = {}) {
  return {
    branch: '', itemId: '', itemTitle: '',
    ...overrides,
  };
}

function mkWorktree(overrides = {}) {
  return {
    path: '', name: '', branch: '', head: '',
    subject: '', committedAt: null, when: '',
    dirty: 0, ahead: 0, unpushed: null,
    main: false, prunable: false,
    itemId: '', itemTitle: '',
    ...overrides,
  };
}

function featureFor(features, itemId) {
  return features.find((f) => f.itemId === itemId);
}

// --- the five stages ----------------------------------------------------

test('feature stages: claimed / building / built / pushed / landed each select correctly', () => {
  const project = mkProject({
    slug: 'five-stage',
    claims: [
      mkClaim({ id: '1', branch: 'feat/1-a', title: 'Claimed only' }),
      mkClaim({ id: '2', branch: 'feat/2-b', title: 'Building now' }),
      mkClaim({ id: '3', branch: 'feat/3-c', title: 'Built locally' }),
      mkClaim({ id: '4', branch: 'feat/4-d', title: 'Pushed to origin' }),
      mkClaim({ id: '5', branch: 'feat/5-e', title: 'Landed' }),
    ],
    branches: [
      mkBranchRep({ branch: 'feat/4-d', itemId: '4', ahead: 5 }),
      mkBranchRep({ branch: 'feat/5-e', itemId: '5', ahead: 0 }),
    ],
    worktrees: [
      mkWorktree({ branch: 'feat/3-c', itemId: '3', ahead: 2 }),
    ],
  });
  const fleet = [
    { jobId: 'j1', slug: 'five-stage', itemId: '2', branch: 'feat/2-b' },
  ];

  const features = buildFeatures([project], fleet);
  assert.equal(featureFor(features, '1').stage, 'claimed');
  assert.equal(featureFor(features, '2').stage, 'building');
  assert.equal(featureFor(features, '3').stage, 'built');
  assert.equal(featureFor(features, '4').stage, 'pushed');
  assert.equal(featureFor(features, '5').stage, 'landed');
});

test('a fleet worker (building) beats a pushed branch report', () => {
  const project = mkProject({
    slug: 'build-beats-push',
    claims: [mkClaim({ id: '9', branch: 'feat/9-x' })],
    branches: [mkBranchRep({ branch: 'feat/9-x', itemId: '9', ahead: 7 })],
  });
  const fleet = [{ jobId: 'j', slug: 'build-beats-push', itemId: '9', branch: 'feat/9-x' }];
  const features = buildFeatures([project], fleet);
  assert.equal(featureFor(features, '9').stage, 'building');
});

// --- regressions for the two false positives fixed above ----------------

test('regression A: a claimed item with a fresh worktree at ahead:0 and no branch report is claimed, not landed', () => {
  const project = mkProject({
    slug: 'regression-a',
    claims: [mkClaim({ id: 'A1', branch: 'feat/10-a1' })],
    worktrees: [mkWorktree({ branch: 'feat/10-a1', itemId: 'A1', ahead: 0 })],
  });
  const features = buildFeatures([project], []);
  const f = featureFor(features, 'A1');
  assert.equal(f.stage, 'claimed');
  assert.notEqual(f.stage, 'landed');
});

test('regression B: no entry in claims[] but a branch report at ahead:5 is pushed, not landed', () => {
  const project = mkProject({
    slug: 'regression-b',
    claims: [],
    branches: [mkBranchRep({ branch: 'feat/11-b1', itemId: 'B1', ahead: 5 })],
  });
  const features = buildFeatures([project], []);
  const f = featureFor(features, 'B1');
  assert.equal(f.stage, 'pushed');
  assert.notEqual(f.stage, 'landed');
});

test('a genuinely landed case: branch report ahead:0, no tree commits', () => {
  const project = mkProject({
    slug: 'genuinely-landed',
    branches: [mkBranchRep({ branch: 'feat/12-c1', itemId: 'C1', ahead: 0 })],
  });
  const features = buildFeatures([project], []);
  assert.equal(featureFor(features, 'C1').stage, 'landed');
});

// --- flags are independent of stage --------------------------------------

test('a pushed feature that is also dirty keeps stage pushed and gains the dirty flag', () => {
  const project = mkProject({
    slug: 'pushed-and-dirty',
    branches: [mkBranchRep({ branch: 'feat/13-d1', itemId: 'D1', ahead: 5 })],
    worktrees: [mkWorktree({ branch: 'feat/13-d1', itemId: 'D1', ahead: 1, dirty: 3 })],
  });
  const features = buildFeatures([project], []);
  const f = featureFor(features, 'D1');
  assert.equal(f.stage, 'pushed');
  assert.ok(f.flags.includes('dirty'), `expected 'dirty' in ${JSON.stringify(f.flags)}`);
});

test('worktrees: null yields no no-tree/prunable flags and the slug comes back from worktreesUnseen', () => {
  const project = mkProject({
    slug: 'unseen-trees',
    claims: [mkClaim({ id: 'E1', branch: 'feat/14-e1' })],
    worktrees: null,
  });
  const features = buildFeatures([project], []);
  const f = featureFor(features, 'E1');
  assert.ok(!f.flags.includes('no-tree'), `unexpected 'no-tree' in ${JSON.stringify(f.flags)}`);
  assert.ok(!f.flags.includes('prunable'), `unexpected 'prunable' in ${JSON.stringify(f.flags)}`);
  assert.deepEqual(worktreesUnseen([project]), ['unseen-trees']);
});

test('worktrees: [] with a claimed item does yield no-tree', () => {
  const project = mkProject({
    slug: 'seen-empty-trees',
    claims: [mkClaim({ id: 'F1', branch: 'feat/15-f1' })],
    worktrees: [],
  });
  const features = buildFeatures([project], []);
  const f = featureFor(features, 'F1');
  assert.ok(f.flags.includes('no-tree'), `expected 'no-tree' in ${JSON.stringify(f.flags)}`);
  assert.deepEqual(worktreesUnseen([project]), []);
});

// --- one union, not three rows -------------------------------------------

test('a claim, a branch report and a worktree describing the same item produce exactly one feature', () => {
  const project = mkProject({
    slug: 'one-union',
    claims: [mkClaim({ id: 'G1', branch: 'feat/16-g1' })],
    branches: [mkBranchRep({ branch: 'feat/16-g1', itemId: 'G1', ahead: 3 })],
    worktrees: [mkWorktree({ branch: 'feat/16-g1', itemId: 'G1', ahead: 3 })],
  });
  const features = buildFeatures([project], []);
  const matches = features.filter((f) => f.slug === 'one-union' && f.itemId === 'G1');
  assert.equal(matches.length, 1, `expected exactly one feature, got ${matches.length}`);
});

// --- sort ------------------------------------------------------------------

test('the sort is deterministic: building always sorts first', () => {
  const project = mkProject({
    slug: 'sort-order',
    claims: [
      mkClaim({ id: 'H1', branch: 'feat/20-h1' }),
      mkClaim({ id: 'H2', branch: 'feat/21-h2' }),
    ],
    branches: [
      mkBranchRep({ branch: 'feat/21-h2', itemId: 'H2', ahead: 4 }),
    ],
  });
  const fleet = [{ jobId: 'j', slug: 'sort-order', itemId: 'H1', branch: 'feat/20-h1' }];
  const features = buildFeatures([project], fleet);
  assert.equal(features[0].stage, 'building');
  assert.equal(features[0].itemId, 'H1');
});
