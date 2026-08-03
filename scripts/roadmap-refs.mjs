#!/usr/bin/env node
// roadmap-refs.mjs — what does "#228" actually say it is? (BUG-4)
//
//   node scripts/roadmap-refs.mjs [--slug stack] [--all] [--json]
//
// This repo cites roadmap items by number everywhere: CLAUDE.md's invariants,
// code comments, commit messages, the schema. Those numbers are load-bearing —
// a session reads "#228 — the skill tree" and goes looking at the wrong item —
// and nothing has ever checked one. #228 was cited both for the skill tree and
// for session kinds; only one of them can be right, and neither citation had
// any way to know.
//
// A number cannot be checked against intent, so this does the two things that
// CAN be checked, and says which is which:
//
//   MISSING — the id is above the highest the board has ever issued, so no
//             such item can ever have existed. That is a typo or an invention,
//             and it is the only thing here that exits 1.
//   STALE   — the id sits in a gap: an item that existed when it was cited and
//             has since been deleted. Worth knowing (the citation can no longer
//             be looked up) and NOT the citer's fault, so it does not fail.
//   SUSPECT — the id exists, but the citing line shares no word at all with
//             that item's title OR its note. A HEURISTIC, reported and never
//             failed on: terse prose is allowed to say "the #212 gate".
//
// Both halves print the item's real title next to the citing line, which is
// the whole point: seeing "#228 → Skills: sync a managed skill tree" beside a
// comment about session kinds ends the question in one glance.
//
// FAIL-SAFE: with no API on the line this checks NOTHING, and says so, and
// exits 0. A linter that cannot look must not report a clean run — but it must
// not fail a build over its own missing input either.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTS = /\.(md|js|mjs|ts|tsx|css|sql|sh)$/;

// #123 — one to four digits, and never part of a longer token. `\b` after the
// digits is what keeps `#211d19` (a hex colour) and `#123456` out.
const REF = /#(\d{1,4})\b/g;

// Words too common to count as agreement between a line and a title.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'its', 'for',
  'on', 'at', 'by', 'as', 'be', 'that', 'this', 'with', 'from', 'not', 'so', 'but', 'add', 'new']);

const words = (s) => new Set(
  String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
);

function readEnv() {
  try {
    const text = readFileSync(join(homedir(), '.stack', 'env'), 'utf8');
    const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    return { api: (get('STACK_API') || '').replace(/\/$/, ''), token: get('STACK_TOKEN') };
  } catch {
    return {};
  }
}

export async function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(`--${n}`);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const slug = arg('slug') || 'stack';

  const { api, token } = readEnv();
  if (!api || !token) {
    process.stdout.write('No ~/.stack/env — nothing was checked. (This reports; it does not guess.)\n');
    return 0;
  }

  const get = async (path) => {
    const res = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : Object.values(body).flat().filter((x) => x && typeof x === 'object');
  };

  // TWO populations, because `#N` in this repo means either. The roadmap is
  // numbered into the 300s and the idea funnel only reaches 153, so most
  // citations are unambiguous — but under 153 an id can name one of each, and
  // saying "no such item" about a number that is a perfectly good future would
  // be the same false certainty this tool exists to remove.
  let items; let futures;
  try {
    [items, futures] = await Promise.all([
      get(`/api/projects/${slug}/roadmap`),
      get(`/api/projects/${slug}/futures`).catch(() => []),
    ]);
  } catch (e) {
    process.stdout.write(`Could not read ${slug}'s roadmap (${e.message}) — nothing was checked.\n`);
    return 0;
  }
  const byId = new Map(items.map((i) => [Number(i.id), i]));
  const futureById = new Map(futures.map((f) => [Number(f.id), f]));
  const maxId = Math.max(...byId.keys());

  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f && EXTS.test(f));

  const missing = [];
  const stale = [];
  const suspect = [];
  let cited = 0;
  for (const file of files) {
    let text;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((line, n) => {
      for (const m of line.matchAll(REF)) {
        const id = Number(m[1]);
        // Below the board's own numbering these are far more likely to be
        // ordinals, CSS or issue shorthand than roadmap items.
        if (id < 2 || id > maxId + 200) continue; // far above the board = not a citation
        cited++;
        const item = byId.get(id);
        const future = futureById.get(id);
        const where = { file, line: n + 1, text: line.trim().slice(0, 140) };
        if (!item) {
          // A valid idea number is not a dangling citation.
          if (!future) (id > maxId ? missing : stale).push({ id, ...where });
          continue;
        }
        // Scored against the item's title AND its note, because a note is
        // where the words a citing line actually uses live. Zero words in
        // common with either is the flag. Two sharper-sounding rules were
        // tried and thrown away: "no words in common with the TITLE" flagged
        // 405 of 1019 citations, and "some other item's title fits better"
        // flagged 212, almost all of them agreeing on nothing but "session"
        // or "run". A heuristic that cries wolf is the thing this repo keeps
        // refusing to ship.
        const a = words(line.replace(REF, ' '));
        const b = words(`${item.title} ${String(item.note || '').slice(0, 600)}`
          + (future ? ` ${future.title} ${String(future.note || '').slice(0, 300)}` : ''));
        const shared = [...b].filter((w) => a.has(w));
        if (b.size && shared.length === 0) {
          suspect.push({ id, title: item.title, alsoFuture: future ? future.title : null, ...where });
        }
      }
    });
  }

  if (flag('json')) {
    process.stdout.write(`${JSON.stringify({ cited, missing, stale, suspect }, null, 2)}\n`);
    return missing.length ? 1 : 0;
  }

  process.stdout.write(`${cited} citations across ${files.length} tracked files `
    + `(${byId.size} roadmap items to #${maxId}, ${futureById.size} ideas).\n\n`);

  if (missing.length) {
    process.stdout.write(`MISSING — ${missing.length} citation(s) name an id above #${maxId}, the highest the\n`
      + 'board has issued. No such item has ever existed:\n');
    for (const r of missing) process.stdout.write(`  ${r.file}:${r.line}  #${r.id}\n      ${r.text}\n`);
    process.stdout.write('\n');
  }

  if (stale.length) {
    const shownStale = flag('all') ? stale : stale.slice(0, 10);
    process.stdout.write(`STALE — ${stale.length} citation(s) name an item that has been deleted since.\n`
      + 'Nobody wrote these wrong; they just cannot be looked up any more:\n');
    for (const r of shownStale) process.stdout.write(`  ${r.file}:${r.line}  #${r.id}\n      ${r.text}\n`);
    if (shownStale.length < stale.length) {
      process.stdout.write(`  … ${stale.length - shownStale.length} more not shown — pass --all for the rest.\n`);
    }
    process.stdout.write('\n');
  }

  // Ranked before it is capped: a wrong id in CLAUDE.md or in the agent manual
  // is read by every session that starts here, and one in a generated Polaris
  // report is read by nobody. Same finding, different cost.
  const rank = (f) => (f === 'CLAUDE.md' ? 0 : f.startsWith('templates/') ? 1
    : f.startsWith('server/') || f.startsWith('web/') || f.startsWith('scripts/') || f.startsWith('hook/') ? 2
      : f.startsWith('polaris/') ? 4 : 3);
  suspect.sort((x, y) => rank(x.file) - rank(y.file) || x.file.localeCompare(y.file) || x.line - y.line);
  const show = flag('all') ? suspect : suspect.slice(0, 20);
  if (suspect.length) {
    process.stdout.write(`SUSPECT — ${suspect.length} citation(s) share no word with the item they name.\n`
      + 'A heuristic, and terse prose is allowed — read the pair and judge:\n');
    for (const r of show) {
      process.stdout.write(`  ${r.file}:${r.line}  #${r.id} is "${r.title}"`
        + `${r.alsoFuture ? ` (or the idea "${r.alsoFuture}")` : ''}\n      ${r.text}\n`);
    }
    if (show.length < suspect.length) {
      process.stdout.write(`  … ${suspect.length - show.length} more not shown — pass --all for the rest.\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(missing.length
    ? `${missing.length} citation(s) name an id the board never issued. Those are wrong, not stylistic.\n`
    : `Every citation names an id the board has issued (${stale.length} of them since deleted).\n`);
  return missing.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => {
    process.stderr.write(`roadmap-refs failed: ${e.message}\n`);
    process.exit(1);
  });
}
