#!/usr/bin/env node
// Tests for the shared risk-tier helpers (#262 deriving a tier at plan time).
// Run: node scripts/risk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_TIERS, cleanRiskTier, cleanRiskReason, riskLabel } from './lib/risk.mjs';

// --- RISK_TIERS ---

test('RISK_TIERS: exactly low/normal/high, in that order', () => {
  assert.deepEqual(RISK_TIERS, ['low', 'normal', 'high']);
});

// --- cleanRiskTier ---
// This is the gate in front of a lever that can merge code to main unread, so
// its whole job is to refuse anything it is not certain of.

test('cleanRiskTier: the three tiers pass through unchanged', () => {
  assert.equal(cleanRiskTier('low'), 'low');
  assert.equal(cleanRiskTier('normal'), 'normal');
  assert.equal(cleanRiskTier('high'), 'high');
});

test('cleanRiskTier: case and surrounding whitespace are tolerated', () => {
  assert.equal(cleanRiskTier(' LOW '), 'low');
  assert.equal(cleanRiskTier('High'), 'high');
});

test('cleanRiskTier: every unclear answer becomes normal, the tier that changes nothing', () => {
  assert.equal(cleanRiskTier(undefined), 'normal');
  assert.equal(cleanRiskTier(null), 'normal');
  assert.equal(cleanRiskTier(''), 'normal');
  // Near-misses must NOT be read as 'low' — widening the match to catch a
  // near-miss is exactly the guess that would auto-merge something nobody
  // tiered, so these have to fall back to 'normal' just like garbage does.
  assert.equal(cleanRiskTier('lowish'), 'normal');
  assert.equal(cleanRiskTier('Low risk'), 'normal');
  assert.equal(cleanRiskTier('medium'), 'normal');
  assert.equal(cleanRiskTier('critical'), 'normal');
  assert.equal(cleanRiskTier(0), 'normal');
  assert.equal(cleanRiskTier({}), 'normal');
  assert.equal(cleanRiskTier([]), 'normal');
});

// --- cleanRiskReason ---

test('cleanRiskReason: trims surrounding whitespace', () => {
  assert.equal(cleanRiskReason('  touches the auth path  '), 'touches the auth path');
});

test('cleanRiskReason: undefined/null/empty/whitespace all become an empty string', () => {
  assert.equal(cleanRiskReason(undefined), '');
  assert.equal(cleanRiskReason(null), '');
  assert.equal(cleanRiskReason(''), '');
  assert.equal(cleanRiskReason('   '), '');
});

test('cleanRiskReason: internal newlines collapse to a single space', () => {
  // The reason lands in a one-line note and a one-line log entry, so a
  // multi-line answer must not break either.
  assert.equal(cleanRiskReason('touches auth\n\nand billing'), 'touches auth and billing');
  assert.equal(cleanRiskReason('line one\n  \n  line two'), 'line one line two');
});

test('cleanRiskReason: caps at 300 characters', () => {
  const long = 'x'.repeat(500);
  const cleaned = cleanRiskReason(long);
  assert.equal(cleaned.length, 300);
});

// --- riskLabel ---

test('riskLabel: tier plus reason joined by an em dash', () => {
  assert.equal(riskLabel('normal', 'because X'), 'normal — because X');
});

test('riskLabel: empty reason renders as the bare tier, no dangling dash', () => {
  // This is the case the helper exists for.
  assert.equal(riskLabel('normal', ''), 'normal');
});

test('riskLabel: undefined reason renders as the bare tier too', () => {
  assert.equal(riskLabel('normal', undefined), 'normal');
});
