// The session-defaults catalogue Settings offers. Keys mirror the server's
// SESSION_DEFAULTS (server/src/settings.js); `line` is the sentence a session
// is handed, label/hint are what Settings shows.
export const DIRECTIVES: { key: string; label: string; hint: string; line: string }[] = [
  {
    key: 'lean',
    label: 'Reduce token usage',
    hint: 'Work lean — concise output, no re-reading unchanged files.',
    line: 'Keep token usage lean: concise output, no re-reading unchanged files, no exploratory tangents.',
  },
  {
    key: 'ship',
    label: 'Commit + push each unit',
    hint: 'Land every completed unit of work on the remote.',
    // Verbatim the server twin, permission included: a line without it has a
    // session stop to ask for what it was already granted.
    line: 'Commits are pre-authorised: commit and push after every completed unit of work — no need to ask.',
  },
  {
    key: 'checkpoint',
    label: 'Checkpoint on wrap-up',
    hint: 'Run /checkpoint before ending the session.',
    line: 'Run /checkpoint before wrapping up the session.',
  },
  {
    key: 'confirm',
    label: 'Confirm big changes',
    hint: 'Check in before contract/schema changes or deletions.',
    line: 'Check in before changing API contracts or the schema, or deleting anything.',
  },
  {
    key: 'verify',
    label: 'Verify before done',
    hint: 'Build + typecheck must pass before calling work done.',
    line: 'Run the build/typecheck and verify before declaring work done.',
  },
  {
    key: 'fly',
    label: 'Open a card for ad-hoc work',
    hint: 'Work you ask for in a session gets a ⚡ FLY roadmap card.',
    // VERBATIM the server twin's line (server/src/settings.js SESSION_DEFAULTS).
    line: 'If you are asked to build something that is not already a roadmap item, open a card for it first: '
      + 'POST /api/projects/<slug>/roadmap with {"source":"fly","session":"<your tmux session name>","title":…,"note":…}, '
      + 'bearer $STACK_TOKEN from ~/.stack/env. It is held out of the overnight runner until the owner signs it off, '
      + 'so it records the work without commissioning any. One card per piece of work, not per turn; skip it for trivia. '
      + 'A 409 with "dismissed":true means the owner deleted that card — do not post it again.',
  },
];
