// The run ledger's shared shapes (shape.js `agentReads` / `runCore`).
//
//   node server/test/run-shape.test.mjs      # exits non-zero on any failure
//
// Four routes used to shape autopilot_runs rows by hand. This pins the shared
// replacement to what those copies emitted, edge for edge — the originals are
// transcribed below so the equivalence is checkable, not asserted. The edges
// are where the copies had already drifted: node-postgres hands back BIGINT and
// NUMERIC as STRINGS, and '' vs null carries meaning here ("no pass ran" is not
// "nothing found").
import { agentReads, runCore } from '../src/shape.js';

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL  ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok    ${label}`);
};

// --- the four originals, transcribed from the pre-refactor call sites -------
const origReviewJsItem = (row) => ({
  reviewVerdict: row.review_verdict || '',
  reviewNote: row.review_note || '',
  reviewFindings: row.review_findings ?? null,
  architectVerdict: row.architect_verdict || '',
  architectNote: row.architect_note || '',
  architectObs: Array.isArray(row.architect_obs) ? row.architect_obs : [],
});
const origControlJs = (r) => ({
  reviewVerdict: r.review_verdict || '',
  reviewNote: r.review_note || '',
  reviewFindings: r.review_findings == null ? null : Number(r.review_findings),
  architectVerdict: r.architect_verdict || '',
  architectNote: r.architect_note || '',
  architectObs: Array.isArray(r.architect_obs) ? r.architect_obs : [],
});

// node-postgres reality: BIGINT/NUMERIC arrive as strings, INT as numbers,
// JSONB already parsed, and every nullable column can be null.
const rows = [
  { label: 'a full row',
    r: { review_verdict: 'concerns', review_note: 'n', review_findings: 2,
         architect_verdict: 'drifting', architect_note: 'a', architect_obs: ['x', 'y'],
         branch: 'auto/item-1-x', outcome: 'landed', commits: 3,
         tokens: '145000', cost_usd: '1.25', checks_failing: 0, summary: 's' } },
  { label: 'no pass ran (all null)',
    r: { review_verdict: null, review_note: null, review_findings: null,
         architect_verdict: null, architect_note: null, architect_obs: null,
         branch: null, outcome: 'no-commits', commits: 0,
         tokens: '0', cost_usd: '0.00', checks_failing: null, summary: '' } },
  { label: 'clean with zero findings (0 must survive, not become null)',
    r: { review_verdict: 'clean', review_note: 'fine', review_findings: 0,
         architect_verdict: 'aligned', architect_note: '', architect_obs: [],
         branch: 'auto/x', outcome: 'landed', commits: 1,
         tokens: '900', cost_usd: '0.01', checks_failing: 0, summary: '' } },
  { label: 'a row predating the columns (undefined, not null)',
    r: { branch: 'auto/y', outcome: 'landed', commits: 2, tokens: '10', cost_usd: '0.1' } },
];

console.log('--- agentReads matches every original ---');
for (const { label, r } of rows) {
  check(`${label} · vs review.js/autopilot.js`, agentReads(r), origReviewJsItem(r));
  check(`${label} · vs control.js`, agentReads(r), origControlJs(r));
}

console.log('\n--- runCore: the coercions that actually matter ---');
const c = runCore(rows[0].r);
check('BIGINT string → number', c.tokens, 145000);
check('NUMERIC string → number', c.costUsd, 1.25);
check('checksFailing 0 stays 0', c.checksFailing, 0);
check('agent reads are folded in', c.reviewVerdict, 'concerns');
const n = runCore(rows[1].r);
check('null checks_failing → null (not 0)', n.checksFailing, null);
check('null branch → empty string', n.branch, '');
check('zero tokens → 0', n.tokens, 0);
const u = runCore(rows[3].r);
check('missing agent columns → no-pass-ran markers', [u.reviewVerdict, u.reviewFindings, u.architectObs], ['', null, []]);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
