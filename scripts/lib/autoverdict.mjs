// Auto-verdict (#263) — the pure rule that decides whether an overnight run is
// allowed to write its OWN review_tag. This extends the #212 auto-merge gate
// (stack-autopilot.mjs, risk-tiered auto-merge) one step further: where #212
// only queues the merge, this gate additionally lets a low-risk, all-green
// night skip the human's verdict click.
//
// Same fail-closed direction as everywhere else in Stack: every gate below is
// POSITIVE evidence. An ABSENT signal — no checks ran, no reviewer verdict, a
// declaration with nothing in it — is never treated as a green one, exactly
// the same rule as a NULL review_verdict/architect_verdict elsewhere in this
// codebase. When in doubt, this module says no and says why.

const PATH_RE = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+$/;
const WRAP_RE = /[`'"()[\]{}]/;
const TRAIL_PUNCT_RE = /[.,;:]/;

// Strips wrapping backticks/quotes/brackets/parens off both ends and any
// trailing sentence punctuation, then any trailing slash. Case is preserved —
// paths are case-sensitive on the filesystems Stack runs on.
function cleanToken(raw) {
  let s = raw;
  while (s.length && WRAP_RE.test(s[0])) s = s.slice(1);
  while (s.length && (WRAP_RE.test(s[s.length - 1]) || TRAIL_PUNCT_RE.test(s[s.length - 1]))) {
    s = s.slice(0, -1);
  }
  s = s.replace(/\/+$/, '');
  return s;
}

// Pulls the file paths an item DECLARES out of free text (a design note's
// "Interfaces: …" line, plan steps, whatever the caller joins in). A token
// only qualifies if it is path-shaped — contains at least one "/" once
// wrapping punctuation is stripped — so a bare word or a bare basename like
// `roadmap.js` never counts as a declaration. De-duplicated, capped at 60.
export function declaredFiles(text) {
  const out = [];
  const seen = new Set();
  const words = String(text || '').split(/\s+/);
  for (const raw of words) {
    if (!raw) continue;
    const cleaned = cleanToken(raw);
    if (!cleaned || !PATH_RE.test(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= 60) break;
  }
  return out;
}

// Which changed (repo-relative) paths are NOT covered by any declared token.
// Covered means exact match, or the changed path sits inside a declared
// directory (`changed.startsWith(d + '/')`) — nothing fuzzier than that on
// purpose: this gate must fail closed, not guess by basename. Empty `changed`
// returns [] — the caller treats "no changed files" as its own failure.
export function unconfined(changed, declared) {
  if (!Array.isArray(changed) || changed.length === 0) return [];
  const decl = Array.isArray(declared) ? declared : [];
  return changed.filter((c) => !decl.some((d) => c === d || c.startsWith(`${d}/`)));
}

// The whole gate, in one place. Returns { ok, evidence, missing } — ok is
// true only when every signal below is positively green; missing carries a
// reason per absent/failed signal, phrased for a night log; evidence is the
// one-line receipt spent on a passing verdict (empty string when ok is
// false — there is nothing to spend it on).
export function autoVerdict(ev) {
  const {
    risk, limitHit, refineRound, checksRan, checksFailing, reviewBugs,
  } = ev || {};
  const changed = Array.isArray(ev?.changed) ? ev.changed : [];
  const declared = Array.isArray(ev?.declared) ? ev.declared : [];

  const missing = [];

  if (risk !== 'low') missing.push(`not low risk (${risk})`);
  if (limitHit) missing.push('the run hit its limit');
  if (refineRound) missing.push('this is a refine round');
  if (!(checksRan > 0)) missing.push('no checks ran');
  if (checksFailing == null) {
    missing.push('check results unknown');
  } else if (checksFailing !== 0) {
    missing.push(`${checksFailing} check(s) failing`);
  }
  if (reviewBugs == null) {
    missing.push('no reviewer verdict');
  } else if (reviewBugs > 0) {
    missing.push(`the reviewer flagged ${reviewBugs} bug(s)`);
  }
  if (changed.length === 0) missing.push('nothing changed');
  if (declared.length === 0) missing.push('the item declares no files');

  const stray = unconfined(changed, declared);
  if (stray.length > 0) {
    const shown = stray.slice(0, 3).join(', ');
    const more = stray.length > 3 ? ` +${stray.length - 3} more` : '';
    missing.push(`the diff leaves the declared files (${shown}${more})`);
  }

  if (missing.length > 0) return { ok: false, evidence: '', missing };

  const bugWord = reviewBugs === 1 ? 'bug' : 'bugs';
  const evidence = [
    'low risk',
    `${checksRan} check(s) green`,
    `reviewer clean (${reviewBugs} ${bugWord})`,
    `${changed.length} file(s), all within the ${declared.length} declared`,
  ].join(' · ');

  return { ok: true, evidence, missing: [] };
}
