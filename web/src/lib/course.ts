// COURSE AND ACTIVITY'S WORDING, pure (tested by scripts/course.test.mjs).
//
// AN ACTIVITY SLIP IS HEADED BY THE IDEA OF THE PUSH, not by the session's
// sign-off (owner, 2026-11-11). The idea is the commit's subject line, which
// the hooks send as `headline`; the long summary only shows when a slip is
// opened. A row older than the column has no headline, so it falls back to the
// summary's first sentence, capped: never the whole paragraph.

const HEADLINE_MAX = 90;

/** "fix(board): the receipt floats" → "The receipt floats". */
export function stripConventional(subject: string): string {
  const s = subject.trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Sentences, split at a stop followed by a capital, digit, quote or backtick. */
export function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`'"(“‘])/)
    .map((x) => x.trim()).filter(Boolean);
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** The one line that heads an Activity slip. */
export function slipHeadline(a: { headline?: string; summary: string }): string {
  const h = stripConventional(a.headline || '');
  if (h) return clip(h, HEADLINE_MAX);
  const first = sentences(a.summary)[0] || '';
  return first ? clip(first.replace(/[.!]$/, ''), HEADLINE_MAX) : 'No summary was posted for this push';
}

/** A next-up line as a title and its detail: the first sentence heads it. */
export function splitStep(step: string): { title: string; detail: string } {
  const [first = '', ...rest] = sentences(step);
  return { title: first.replace(/\.$/, ''), detail: rest.join(' ') };
}

/** Claude's first prompt for "Resume in Terminal". */
export function resumeBrief(project: string, step: string, summary: string): string {
  return [
    `Resume work on ${project}. The step picked from the last checkpoint:`,
    '',
    step,
    '',
    summary ? `Where the last session left off: ${summary}` : '',
    'Read the SessionStart context first. Check the branch claims before you start.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
}
