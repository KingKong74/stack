#!/usr/bin/env node
// Stack — the branch navigator (`stack tree`), phase 1: the textual tree.
//
// Renders a project's branch-and-idea structure as one navigable tree: the
// trunk (main) as the root, autopilot lanes (auto/item-N) and idea branches
// (idea/*) hanging off it, and merged branches folded back into the trunk.
// Every node carries a slot for its per-push Gemini take — a placeholder for
// now (wiring the stored gemini_note in is a later phase; this phase is the
// data model + rendering only).
//
// Everything comes from git — no API calls, no separate persistence, no key.
// Empty lane/idea groups render an example placeholder node so the tree's
// intended shape is always visible.
//
// Usage:
//   node scripts/stack-tree.mjs [--repo <path>] [--json]
//   ./stack tree [--repo <path>] [--json]        # via the root dispatcher
//
//   --repo <path>   the repository to read (default: the current directory)
//   --json          print the tree model as JSON instead of rendering it
//
// Zero dependencies. Exits non-zero only when the path isn't a git repo.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { git, projectFromGit } from '../hook/stack-post.mjs';

const GEMINI_TAKE_PLACEHOLDER = '[Gemini take: not yet wired]';

// ---------------------------------------------------------------------------
// The tree model — plain data, renderable as text now and richer views later.

function listRefs(repo) {
  // Use NUL-separated records so multi-line subjects and unusual branch names
  // (spaces, unicode) never confuse the parser (#113). Each record is still
  // tab-delimited internally; fields that git leaves empty produce empty strings.
  const raw = git(repo, [
    'for-each-ref', 'refs/heads', 'refs/remotes/origin',
    '--sort=-committerdate',
    // %00 between records so a newline in %(subject) doesn't split mid-record.
    '--format=%(refname)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)%00',
  ]);
  if (!raw) return [];
  const seen = new Map(); // short name → ref (local wins over remote)
  for (const record of raw.split('\0')) {
    const line = record.trim();
    if (!line) continue;          // trailing NUL produces an empty record — skip
    const [refname, hash, when, ...rest] = line.split('\t');
    // Guard: must be a real ref under a known namespace, with a hash.
    if (!refname || !hash) continue;
    const isLocal = refname.startsWith('refs/heads/');
    const isRemote = refname.startsWith('refs/remotes/origin/');
    if (!isLocal && !isRemote) continue;   // symbolic-ref or detached HEAD artefact
    const name = isLocal
      ? refname.slice('refs/heads/'.length)
      : refname.slice('refs/remotes/origin/'.length);
    if (!name || name === 'HEAD') continue; // skip origin/HEAD symbolic ref
    const existing = seen.get(name);
    // Local ref always wins; if we already have local, skip any remote duplicate.
    if (existing && (existing.local || !isLocal)) continue;
    seen.set(name, { name, refname, hash, when: when || '', subject: rest.join('\t'), local: isLocal });
  }
  return [...seen.values()];
}

function trunkName(repo, refs) {
  // git symbolic-ref returns e.g. "origin/main" or exits non-zero (detached /
  // not set); either way git() returns the trimmed string or null — guard both.
  const headRaw = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const fromOrigin = headRaw && headRaw.trim() ? headRaw.trim().replace(/^origin\//, '') : null;
  for (const candidate of [fromOrigin, 'main', 'master']) {
    if (candidate && refs.some((r) => r.name === candidate)) return candidate;
  }
  return refs[0]?.name || null;
}

function classify(name) {
  if (/^auto\//.test(name)) return 'auto';
  if (/^idea(s)?\//.test(name)) return 'idea';
  return 'branch';
}

// Build the whole navigator model for one repository.
export function buildTree(repoPath) {
  const repo = resolve(repoPath || '.');
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  if (!root) return null;

  const refs = listRefs(root);
  const trunk = trunkName(root, refs);
  const trunkRef = refs.find((r) => r.name === trunk) || null;
  const project = projectFromGit(root);

  const node = (r, extra = {}) => ({
    name: r.name, hash: r.hash, when: r.when, subject: r.subject,
    local: r.local, geminiTake: null, ...extra,
  });

  const lanes = [], ideas = [], branches = [], merged = [];
  for (const r of refs) {
    if (r.name === trunk) continue;
    const counts = trunkRef
      ? git(root, ['rev-list', '--left-right', '--count', `${trunkRef.refname}...${r.refname}`])
      : '';
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [0, 0];
    const n = node(r, { ahead: ahead || 0, behind: behind || 0 });
    // No unique commits AND the trunk has moved on: the branch was absorbed —
    // it folds back into the trunk. Ahead 0 / behind 0 is instead a freshly
    // cut branch sitting at the trunk tip; that stays an open lane.
    if (trunkRef && n.ahead === 0 && n.behind > 0) { merged.push({ ...n, merged: true }); continue; }
    if (trunkRef && n.ahead === 0) n.fresh = true;
    ({ auto: lanes, idea: ideas, branch: branches })[classify(r.name)].push(n);
  }

  // Autopilot lanes read best in item order (auto/item-12 before auto/item-104).
  const itemNo = (n) => { const m = n.name.match(/(\d+)/); return m ? Number(m[1]) : Infinity; };
  lanes.sort((a, b) => itemNo(a) - itemNo(b));

  return {
    project: { slug: project.slug, name: project.name, repo: project.repo },
    trunk: trunkRef ? { ...node(trunkRef), trunk: true } : null,
    lanes, ideas, branches, merged,
  };
}

// ---------------------------------------------------------------------------
// Rendering — modest box-drawing, dimmed meta lines, no dependencies.

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (useColour ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (useColour ? `\x1b[1m${s}\x1b[0m` : s);

function nodeLines(n) {
  const meta = [n.hash, n.when];
  if (n.ahead) meta.push(`↑${n.ahead}`);
  if (n.behind) meta.push(`↓${n.behind}`);
  if (n.fresh) meta.push('at trunk tip');
  if (!n.local) meta.push('remote');
  const lines = [`${bold(n.name)}${n.trunk ? '  ◇ trunk' : ''}  ${dim(`· ${meta.join(' · ')}`)}`];
  if (n.subject) lines.push(dim(`“${n.subject}”`));
  lines.push(dim(n.geminiTake || GEMINI_TAKE_PLACEHOLDER));
  return lines;
}

function placeholderLines(example, hint) {
  return [`${example}  ${dim(`· placeholder — ${hint}`)}`, dim(GEMINI_TAKE_PLACEHOLDER)];
}

// Render one group of branch nodes under the trunk.
function renderGroup(out, indent, isLastGroup, title, items, empty) {
  out.push(`${indent}${isLastGroup ? '└─' : '├─'} ${title}`);
  const childIndent = `${indent}${isLastGroup ? '   ' : '│  '}`;
  const rows = items.length ? items.map(nodeLines) : [empty];
  rows.forEach((lines, i) => {
    const last = i === rows.length - 1;
    lines.forEach((line, j) => {
      const lead = j === 0 ? (last ? '└─ ' : '├─ ') : (last ? '     ' : '│    ');
      out.push(`${childIndent}${lead}${line}`);
    });
  });
}

export function renderTree(model) {
  const out = [];
  out.push(`${bold(model.project.name)} — branch navigator`);
  out.push('');
  if (!model.trunk) {
    out.push(dim('(no branches yet — commit something to grow a trunk)'));
    return out.join('\n');
  }
  nodeLines(model.trunk).forEach((line, i) => out.push(i === 0 ? `└─ ${line}` : `     ${line}`));
  out.push('   │');

  const groups = [
    ['⚑ autopilot lanes', model.lanes,
      placeholderLines('auto/item-N', 'no open autopilot lanes tonight')],
    ['✦ ideas', model.ideas,
      placeholderLines('idea/<feature-name>', 'branch as idea/<name> to grow one')],
  ];
  if (model.branches.length) groups.push(['branches', model.branches, null]);
  groups.push(['✓ folded into the trunk', model.merged,
    [dim('(none yet — merged branches fold back here)')]]);

  groups.forEach(([title, items, empty], i) => {
    renderGroup(out, '   ', i === groups.length - 1, title, items, empty);
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: stack tree [--repo <path>] [--json]\n');
    return 0;
  }
  const repoIdx = argv.indexOf('--repo');
  const repo = repoIdx >= 0 ? argv[repoIdx + 1] : process.cwd();
  if (repoIdx >= 0 && (!repo || repo.startsWith('--'))) {
    process.stderr.write('[stack] --repo needs a path\n');
    return 1;
  }
  const model = buildTree(repo);
  if (!model) {
    process.stderr.write(`[stack] not a git repository: ${resolve(repo)}\n`);
    return 1;
  }
  process.stdout.write(argv.includes('--json')
    ? JSON.stringify(model, null, 2) + '\n'
    : renderTree(model) + '\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
