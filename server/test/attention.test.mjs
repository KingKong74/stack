// What is waiting on the human, and where two sessions are about to collide —
// tested against the REAL exports and the shapes the relay actually hands them.
//
//   node server/test/attention.test.mjs      # exits non-zero on any failure
//
// Both functions are pure precisely so this needs no database and no host. The
// cases that matter are the absences: no daemon must read as "we don't know",
// never as "all clear", because both render as an empty list and only one of
// them is honest about it.
import { computeAttention, computeConflicts } from '../src/routes/control.js';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const NOW = Date.parse('2026-08-01T12:00:00Z');
const minsAgo = (m) => NOW - m * 60_000;

const projects = [
  { slug: 'stack', name: 'Stack', reviewCount: 3 },
  { slug: 'bkos-landing', name: 'BKOS Landing', reviewCount: 0 },
  { slug: 'reliquary', name: 'Reliquary', reviewCount: 1 },
];

const blocked = (fp, question, detail, since) => ({
  question, detail, title: 'Bash command', options: [], yes: 1, fingerprint: fp, since,
});

// ---- computeAttention ------------------------------------------------------

{
  const rows = computeAttention({
    detached: [
      { name: 'stack-term-a1', cwd: 'stack', blocked: blocked('aaaaaaaaaaaaaaaa', 'Do you want to proceed?', 'rm -rf build', minsAgo(2)) },
      { name: 'stack-term-b2', cwd: 'reliquary', blocked: blocked('bbbbbbbbbbbbbbbb', 'Do you want to make this edit to shelf.ts?', 'src/shelf.ts', minsAgo(41)) },
      { name: 'stack-term-c3', cwd: 'stack', blocked: null },
    ],
    jobs: [
      { id: 7, kind: 'resume', status: 'paused', slug: 'stack', name: 'Stack', itemId: 235, itemTitle: 'Descriptive branch names', detail: 'usage limit', notBefore: new Date(minsAgo(-90)).toISOString(), when: 'in 1h' },
      { id: 8, kind: 'nightly', status: 'queued', slug: 'stack', name: 'Stack' },
      { id: 9, kind: 'manual', status: 'running', slug: 'stack', name: 'Stack' },
    ],
    projects,
    now: NOW,
  });

  check('every source lands', rows.length, 5);
  check('permission outranks everything', rows.slice(0, 2).map((r) => r.kind), ['permission', 'permission']);
  check('longest-blocked first', rows[0].tmux, 'stack-term-b2');
  check('then paused, then review', rows.slice(2).map((r) => r.kind), ['paused', 'review', 'review']);
  check('biggest review queue first', rows.slice(3).map((r) => r.count), [3, 1]);
  check('a permission row resolves its project from the cwd', rows[0].name, 'Reliquary');
  check('the question is carried verbatim', rows[1].text, 'Do you want to proceed?');
  check('and so is what it is about', rows[1].detail, 'rm -rf build');
  check('the fingerprint is the answer handle', rows[1].fingerprint, 'aaaaaaaaaaaaaaaa');
  check('a nightly job is not a paused session', rows.filter((r) => r.jobId === 8).length, 0);
  check('a running job is not a paused session', rows.filter((r) => r.jobId === 9).length, 0);
}

check('no daemon, no jobs, nothing reviewed — an empty list',
  computeAttention({ detached: [], jobs: [], projects: [{ slug: 'x', name: 'X', reviewCount: 0 }], now: NOW }), []);

{
  // A resume job the queue has already re-queued is still a paused session:
  // it is standing by for a window that has not opened, not working.
  const rows = computeAttention({
    detached: [], projects: [],
    jobs: [{ id: 1, kind: 'resume', status: 'queued', slug: 's', name: 'S', detail: 'limit' }],
    now: NOW,
  });
  check('a re-queued resume still counts', rows.map((r) => r.kind), ['paused']);
}

{
  // The autopilot's worktree is named for the JOB, not the project.
  const rows = computeAttention({
    detached: [{ name: 'stack-term-z', cwd: '/home/bailey/.stack-autopilot/stack-item-112', blocked: blocked('c'.repeat(16), 'Do you want to proceed?', '', minsAgo(1)) }],
    jobs: [], projects, now: NOW,
  });
  check('a worktree path still finds its project', rows[0].name, 'Stack');
}

{
  const rows = computeAttention({
    detached: [{ name: 'stack-term-q', cwd: 'somewhere-else', blocked: blocked('d'.repeat(16), 'Do you trust the files in this folder?', '', minsAgo(1)) }],
    jobs: [], projects, now: NOW,
  });
  check('an unknown path says where it is rather than claiming a project',
    [rows[0].slug, rows[0].name], ['', '~/somewhere-else']);
}

// ---- computeConflicts ------------------------------------------------------

const sess = (id, cwd, lastAt, files, branch = 'main') =>
  ({ sessionId: id, cwd, branch, lastAt, dropped: 0, files });

{
  const conflicts = computeConflicts({
    edits: {
      at: NOW,
      sessions: [
        sess('s1', '/home/bailey/stack', minsAgo(1), [
          { path: 'server/src/schema.sql', at: minsAgo(2) },
          { path: 'web/src/store.ts', at: minsAgo(4) },
        ]),
        sess('s2', '/home/bailey/stack', minsAgo(3), [
          { path: 'server/src/schema.sql', at: minsAgo(6) },
          { path: 'server/src/db.js', at: minsAgo(7) },
        ]),
      ],
    },
    projects,
    now: NOW,
  });
  check('one shared file, one conflict', conflicts.length, 1);
  check('it names the file', conflicts[0].file, 'server/src/schema.sql');
  check('it names the project and branch', [conflicts[0].slug, conflicts[0].branch], ['stack', 'main']);
  check('it counts the sessions', conflicts[0].count, 2);
  check('and dates itself by the NEWEST of the two edits', conflicts[0].at, minsAgo(2));
}

check('no report at all is not an all-clear — it is nothing',
  computeConflicts({ edits: { at: 0, sessions: [] }, projects, now: NOW }), []);
check('a missing edits cache yields nothing',
  computeConflicts({ edits: null, projects, now: NOW }), []);

{
  // Same file, same path string, DIFFERENT checkouts — not a collision. Two
  // worktrees editing their own copy of schema.sql is the whole point of them.
  const conflicts = computeConflicts({
    edits: {
      at: NOW,
      sessions: [
        sess('s1', '/home/bailey/stack', minsAgo(1), [{ path: 'server/src/schema.sql', at: minsAgo(1) }]),
        sess('s2', '/home/bailey/.stack-autopilot/stack-item-112', minsAgo(1), [{ path: 'server/src/schema.sql', at: minsAgo(1) }]),
      ],
    },
    projects,
    now: NOW,
  });
  check('different checkouts do not collide', conflicts, []);
}

{
  // One session went home an hour ago. Its edits are history, not a collision.
  const conflicts = computeConflicts({
    edits: {
      at: NOW,
      sessions: [
        sess('s1', '/home/bailey/stack', minsAgo(1), [{ path: 'a.ts', at: minsAgo(1) }]),
        sess('s2', '/home/bailey/stack', minsAgo(70), [{ path: 'a.ts', at: minsAgo(70) }]),
      ],
    },
    projects,
    now: NOW,
  });
  check('a session that has left cannot conflict', conflicts, []);
}

{
  // Silent for eight minutes but not gone — a long tool call is still working.
  const conflicts = computeConflicts({
    edits: {
      at: NOW,
      sessions: [
        sess('s1', '/home/bailey/stack', minsAgo(1), [{ path: 'a.ts', at: minsAgo(1) }]),
        sess('s2', '/home/bailey/stack', minsAgo(8), [{ path: 'a.ts', at: minsAgo(12) }]),
      ],
    },
    projects,
    now: NOW,
  });
  check('quiet is not gone', conflicts.length, 1);
}

{
  const conflicts = computeConflicts({
    edits: {
      at: NOW,
      sessions: [
        sess('s1', '/home/bailey/stack', minsAgo(1), [{ path: 'a.ts', at: minsAgo(9) }, { path: 'b.ts', at: minsAgo(1) }]),
        sess('s2', '/home/bailey/stack', minsAgo(2), [{ path: 'a.ts', at: minsAgo(8) }, { path: 'b.ts', at: minsAgo(2) }]),
        sess('s3', '/home/bailey/stack', minsAgo(2), [{ path: 'b.ts', at: minsAgo(3) }]),
      ],
    },
    projects,
    now: NOW,
  });
  check('two files, newest collision first', conflicts.map((c) => c.file), ['b.ts', 'a.ts']);
  check('three on one file is a three-way', conflicts[0].count, 3);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
