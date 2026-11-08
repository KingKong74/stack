// What a Swarm tile shows for a session it is not attached to: the last few
// lines of the pane the host captured with its advertisement. Pure, so the
// narrowing is testable without a relay (server/test/term-preview.test.mjs).
//
// Capped on BOTH axes, because this rides in every GET /terminal/detached for
// every session and a pane can be a wall of build output: at most `lines` lines,
// each at most 240 characters. Blank runs collapse to one blank line, and
// trailing blanks (the empty prompt area below a claude box) are dropped, so the
// tile ends on the last thing that was actually said.
export function previewLines(tail, lines = 14) {
  const out = [];
  for (const raw of String(tail || '').split('\n')) {
    const l = raw.replace(/\s+$/, '').slice(0, 240);
    if (!l && (!out.length || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.slice(-lines);
}

// A session's own branch (`term/<key>`, terminal/session-worktree.mjs) and the
// jail-relative project it was cut from. Anything else collapses to '', which
// reads as "the checkout itself" — the same as a session that never had one.
export const cleanBranch = (b) => (typeof b === 'string' && /^[A-Za-z0-9._/-]{1,120}$/.test(b) ? b : '');
export const cleanProject = (p) => (typeof p === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(p) && !p.split('/').includes('..') ? p : '');
