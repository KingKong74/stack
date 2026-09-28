// The board's ⌨ RUN IN TERMINAL (#525): one click takes a To Do card to a
// claude tab that is already working it. Pure — the board does the writes.
//
// THE COLUMNS MOVE THEMSELVES, and that is why this is so small. `listFor` in
// server/src/lists.js derives a card's column from state it already carries:
// a claim is In Progress, a claim plus a `built_note` is In Review. So the
// board writes the claim before it opens the tab, and the brief asks the
// session to write the note when it has finished. Nothing here writes a
// column, and nothing ever ticks `done`: a session declaring its own work
// shipped is the judgement In Review exists for.
//
// THE CLAIM NAMES THE SESSION, `term:<tmux name>`, which is the spelling the
// checkpoint path already uses for a terminal session's claim (ingest.js). The
// board chooses the name, not the host, so that the claim can be written
// BEFORE anything spawns. The daemon accepts a browser-chosen name only if it
// passes `validName`, and this one always does.
//
// THE BRIEF SAYS THE CLAIM IS ITS OWN. SessionStart lists every claim and the
// agent manual says never to start an item claimed by another branch, so a
// session not told that `term:<its own name>` is itself would refuse its
// only job.
import type { RoadmapItem } from '../types';

/** A fresh tmux name, spelled the way the daemon's own `generateName('term')` spells it. */
export function newTermName(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return `stack-term-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export const termClaim = (tmux: string) => `term:${tmux}`;

// The card's note, capped. The host caps the whole brief too (launch-brief.mjs);
// this cap keeps the instructions after the note from being the part cut off.
const NOTE_MAX = 3000;

/** Claude's first prompt for a card run from the board. */
export function launchBrief(slug: string, item: Pick<RoadmapItem, 'id' | 'title' | 'note'>, tmux: string): string {
  const note = String(item.note || '').trim();
  const cut = note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}\n[note cut at ${NOTE_MAX} of ${note.length} characters; the full text is on the card]` : note;
  return [
    `Work Stack roadmap item #${item.id} in the ${slug} project: ${item.title}`,
    ...(cut ? ['', 'The card\'s note:', cut] : []),
    '',
    `This session was opened from the board's Run in terminal, and the item is claimed for it as \`${termClaim(tmux)}\`. That claim is yours: this is the session it names, so the SessionStart block listing it does not mean somebody else has the item.`,
    '',
    'Build it, verify it the way this repo\'s CLAUDE.md asks, and commit.',
    '',
    'When you have finished, record it so the card moves to In Review. Write the item\'s built_note (two or three plain sentences on what was built, where it lives and how you verified it), and leave claimed_by and done alone:',
    '',
    '  source ~/.stack/env',
    `  curl -s -X PATCH "$STACK_API/api/projects/${slug}/roadmap/${item.id}" -H "authorization: Bearer $STACK_TOKEN" -H 'content-type: application/json' -d '{"built_note":"…"}'`,
    '',
    'If you stop without building it, release it instead with {"claimed_by":""}, which sends the card back to To Do.',
  ].join('\n');
}
