#!/usr/bin/env node
// Stack — the SKILL TREE's host half (roadmap #228).
//
// The server holds the library; this makes the host's disk match it and reports
// back what is really there. Run from the dispatcher's tick (every ~5 minutes,
// stamped) or by hand: `node scripts/stack-skills.mjs [--dry]`.
//
// Skills live at <root>/skills/<name>/SKILL.md — `~/.claude` for global ones,
// `<repo>/.claude` for a project's. That is the layout Claude Code reads, so it
// is the layout this writes; nothing here invents a Stack-specific location.
//
// THE RULE THIS RESTS ON: Stack only ever writes or removes skills IT PLANTED.
// Each managed directory carries a `.stack-managed` marker file (invisible to
// Claude, which only reads SKILL.md), and a skill without that marker is
// REPORTED and never touched — not written over, not deleted, not disabled. A
// tool that manages your files has to be trustworthy about the ones it did not
// create, and "I found it in a directory I manage" is not consent.
//
// Fails SAFE in the #287 sense rather than the arm-switch sense: an unreachable
// API, a missing token or a malformed payload does NOTHING. This deletes files.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadStackEnv, logStderr } from '../hook/stack-post.mjs';

// loadStackEnv fills process.env (it returns nothing) — same use as the dispatcher.
loadStackEnv();
const API = (process.env.STACK_API || '').replace(/\/+$/, '');
const TOKEN = process.env.STACK_TOKEN || '';
// Same convention as the dispatcher: repos are $STACK_AUTOPILOT_ROOT/<slug>.
const REPO_ROOT = process.env.STACK_AUTOPILOT_ROOT || homedir();
const MARKER = '.stack-managed';
const BODY_CAP = 16_000;

const log = (msg) => logStderr(`skills ${new Date().toISOString()} · ${msg}`);

const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
};

// Where a skill of a given scope lives on this host. Returns '' when the place
// does not exist — a project skill for a repo that was never cloned here has
// nowhere to go, and inventing the directory would scatter .claude folders
// around the filesystem.
const rootFor = (scope, slug) => {
  if (scope === 'project') {
    if (!slug || !/^[a-z0-9._-]+$/i.test(slug)) return '';
    const repo = join(REPO_ROOT, slug);
    return existsSync(join(repo, '.git')) ? join(repo, '.claude') : '';
  }
  return join(homedir(), '.claude');
};

// The frontmatter's description, for the report. Deliberately forgiving: this
// parses skills Stack did not write, so it reads the one field it needs and
// never fails on a shape it does not recognise.
const describe = (text) => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return '';
  const m = /^description:\s*(.*)$/m.exec(fm[1]);
  if (!m) return '';
  let v = m[1].trim();
  // A YAML block scalar or a folded multi-line value: take the following
  // indented lines too, which is how most real skills write a long description.
  if (!v || v === '>' || v === '|' || v === '>-' || v === '|-') {
    const after = fm[1].slice(m.index + m[0].length);
    v = after.split('\n').filter((l) => /^\s+\S/.test(l)).map((l) => l.trim()).join(' ');
  }
  return v.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000);
};

// Every skill directory under one root, managed or not.
const scanRoot = (root, scope, slug) => {
  const dir = join(root, 'skills');
  if (!existsSync(dir)) return [];
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(dir, e.name);
    const file = join(path, 'SKILL.md');
    if (!existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    out.push({
      name: e.name,
      scope,
      slug,
      path,
      managed: existsSync(join(path, MARKER)),
      description: describe(text),
      // The body without its frontmatter — what an unmanaged skill would be
      // adopted WITH, so the library gets the real thing rather than a stub.
      body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim().slice(0, BODY_CAP),
    });
  }
  return out;
};

export async function syncSkills({ dry = false } = {}) {
  if (!API || !TOKEN) { log('no API/token in ~/.stack/env — nothing done'); return null; }

  let work;
  try { work = await api('GET', '/api/skills/work'); }
  catch (e) { log(`could not read the library (${e.message}) — nothing done`); return null; }
  if (!work || !Array.isArray(work.write) || !Array.isArray(work.keep)) {
    log('malformed work payload — nothing done');
    return null;
  }

  const installed = [];
  let wrote = 0;
  let removed = 0;

  // ---- write the enabled set ----------------------------------------------
  for (const s of work.write) {
    const root = rootFor(s.scope, s.slug);
    if (!root) continue;                     // nowhere to put it on this host
    const dir = join(root, 'skills', s.name);
    const file = join(dir, 'SKILL.md');
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* not there yet */ }
    // Refuse to write over a skill this host did not plant. The library row
    // stays uninstalled and the report shows the collision, which is a truer
    // answer than silently taking ownership of somebody's file.
    if (current && !existsSync(join(dir, MARKER))) {
      log(`skipped ${s.scope}/${s.name}: a skill of that name exists on disk and Stack did not write it`);
      continue;
    }
    if (current === s.content && s.installed) continue;   // steady state costs nothing
    if (dry) { log(`would write ${file}`); wrote++; continue; }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, s.content, 'utf8');
      writeFileSync(join(dir, MARKER), `stack skill #${s.id}\n`, 'utf8');
      installed.push(s.id);
      wrote++;
    } catch (e) { log(`could not write ${file}: ${e.message}`); }
  }

  // ---- remove what Stack planted and no longer wants -----------------------
  // Driven by the KEEP list, not by a diff against the last report: the server
  // does not know what is on disk, and a stale diff would delete a skill that
  // had only just been written.
  const keep = new Set(work.keep.map((k) => `${k.scope}:${k.slug || ''}:${k.name}`));
  const roots = [{ root: rootFor('global', ''), scope: 'global', slug: '' }];
  for (const k of work.keep) {
    if (k.scope !== 'project' || !k.slug) continue;
    if (roots.some((r) => r.slug === k.slug)) continue;
    const root = rootFor('project', k.slug);
    if (root) roots.push({ root, scope: 'project', slug: k.slug });
  }
  // Projects that had skills and no longer do still need sweeping, so any repo
  // the last report mentioned is revisited too.
  let previous = [];
  try { previous = (await api('GET', '/api/skills')).report?.skills ?? []; } catch { /* report is a nicety here */ }
  for (const p of previous) {
    if (p.scope !== 'project' || !p.slug || roots.some((r) => r.slug === p.slug)) continue;
    const root = rootFor('project', p.slug);
    if (root) roots.push({ root, scope: 'project', slug: p.slug });
  }

  for (const r of roots) {
    if (!r.root) continue;
    for (const found of scanRoot(r.root, r.scope, r.slug)) {
      if (!found.managed) continue;                                   // never ours to remove
      if (keep.has(`${found.scope}:${found.slug}:${found.name}`)) continue;
      if (dry) { log(`would remove ${found.path}`); removed++; continue; }
      try {
        // Belt and braces before an rm -rf: the marker must still be there and
        // the target must still be a directory. Cheap, and the failure mode it
        // guards against is unrecoverable.
        if (!existsSync(join(found.path, MARKER)) || !statSync(found.path).isDirectory()) continue;
        rmSync(found.path, { recursive: true, force: true });
        removed++;
      } catch (e) { log(`could not remove ${found.path}: ${e.message}`); }
    }
  }

  // ---- report what is actually there --------------------------------------
  const report = [];
  const seen = new Set();
  for (const r of roots) {
    if (!r.root || seen.has(r.root)) continue;
    seen.add(r.root);
    report.push(...scanRoot(r.root, r.scope, r.slug));
  }
  const detail = dry
    ? `dry run — ${wrote} to write, ${removed} to remove`
    : `${wrote} written, ${removed} removed, ${report.length} on disk`;
  if (!dry) {
    try { await api('POST', '/api/skills/report', { skills: report, installed, detail }); }
    catch (e) { log(`report failed (${e.message})`); }
  }
  log(detail);
  return { wrote, removed, onDisk: report.length, detail };
}

// The root `stack` dispatcher hands its main an argv ARRAY, so the flag is
// parsed here rather than in syncSkills — which stays an options-object API for
// the autopilot dispatcher that imports it.
export async function main(argv = []) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  await syncSkills({ dry: args.includes('--dry') });
  return 0;
}

const invoked = process.argv[1] && process.argv[1].endsWith('stack-skills.mjs');
if (invoked) {
  main(process.argv.slice(2)).catch((e) => { log(`failed: ${e.message}`); process.exit(1); });
}
