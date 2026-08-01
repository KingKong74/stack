#!/usr/bin/env node
// stack-seed-galaxy.mjs — give an existing idea funnel its first shape (#312).
//
// The Polaris galaxy draws stars, planets and moons, but a project that has
// been collecting futures since before the galaxy existed has no shape at all:
// every idea is loose, so the sky is a ring of dots around the north star and
// says nothing you couldn't read off the list. This turns the tagging you
// already did into that shape, once.
//
//   stack seed-galaxy [--slug stack] [--run] [--min 2]
//
// DRY BY DEFAULT — it prints the plan and writes nothing until --run. Unlike
// seed-checks, this writes into human-authored content: it CREATES a star per
// theme and RE-PARENTS your ideas under it, and an adoption has no undo beyond
// dragging it back by hand. So the default is to show you first.
//
// What it does, and deliberately does not do:
//  • A theme becomes a STAR — a new idea named after the theme, carrying the
//    same `area` so the list groups it with its own planets. The members of
//    that theme become its PLANETS. Star names are the theme text with one
//    capital; rename any of them inline in the rail, they are ordinary rows.
//  • Themes come from `area` tags, plus any "Prefix: …" shared by enough
//    untagged titles — five ideas all starting "Roles:" are a theme whether or
//    not anyone tagged them.
//  • A theme below --min members is left alone. One idea is not a system.
//  • NOTHING already shaped is touched: an idea that is already a star, or
//    already orbits something, is skipped. So this is idempotent, and it can
//    never undo a shape you made by hand.
//  • MOONS are never invented. Nothing in a flat funnel says which idea is a
//    piece of which other idea; that is a judgement, and it belongs to you.
//  • MAGNITUDE is never invented either — it stays null ("not sized yet")
//    rather than the sky claiming an estimate nobody gave.
//  • A seeded star inherits its members' verdict ONLY when they agree
//    unanimously. A mixed theme leaves its star unjudged, where it turns up in
//    the judge queue like any other unjudged idea.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PREFIX_MIN = 3;   // untagged titles sharing a "Prefix:" become a theme at this many

// "mission control" -> "Mission control". One capital, nothing else: the theme
// text is what you typed, and guessing at title case mangles names like "devx".
const starName = (theme) => theme.charAt(0).toUpperCase() + theme.slice(1);

// Themes from the funnel: every non-empty `area`, plus "Prefix: …" families
// among the ideas nobody tagged.
export function themesOf(futures, min) {
  const groups = new Map();
  const push = (key, f) => {
    const arr = groups.get(key);
    if (arr) arr.push(f); else groups.set(key, [f]);
  };
  const untagged = [];
  for (const f of futures) {
    if (f.area) push(f.area, f);
    else untagged.push(f);
  }
  const byPrefix = new Map();
  for (const f of untagged) {
    const m = /^([A-Za-z][\w ]{1,24}):\s+\S/.exec(f.title);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const arr = byPrefix.get(key);
    if (arr) arr.push(f); else byPrefix.set(key, [f]);
  }
  for (const [key, items] of byPrefix) {
    if (items.length >= PREFIX_MIN && !groups.has(key)) groups.set(key, items);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length >= min)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([theme, items]) => ({ theme, items }));
}

// The verdict a theme's members agree on, or '' when they don't. Silence is
// the honest answer for a mixed theme — the star is then yours to judge.
export const sharedVerdict = (items) => {
  const first = items[0]?.alignment || '';
  return first && items.every((f) => (f.alignment || '') === first) ? first : '';
};

export async function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(`--${n}`);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const slug = arg('slug') || 'stack';
  const min = Math.max(2, Number(arg('min')) || 2);
  const DRY = !flag('run');

  // Token + API base from ~/.stack/env — never printed, like every other tool here.
  let API; let TOKEN;
  try {
    const env = readFileSync(join(homedir(), '.stack', 'env'), 'utf8');
    const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    API = (get('STACK_API') || '').replace(/\/$/, '');
    TOKEN = get('STACK_TOKEN');
  } catch {
    process.stderr.write('Could not read ~/.stack/env — is this the Stack host?\n');
    return 1;
  }
  if (!API || !TOKEN) {
    process.stderr.write('STACK_API or STACK_TOKEN missing from ~/.stack/env.\n');
    return 1;
  }

  const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return null; }
  };
  const base = `/api/projects/${encodeURIComponent(slug)}/futures`;

  const all = await api('GET', base);
  // Already shaped = already yours. Only the loose, unjudged-by-the-galaxy
  // ideas are candidates, so a re-run after you have moved things is a no-op.
  const loose = all.filter((f) => !f.isStar && f.parentId == null);
  const shaped = all.length - loose.length;

  const themes = themesOf(loose, min);
  if (!themes.length) {
    process.stdout.write(`${all.length} ideas, ${shaped} already shaped — no theme has ${min}+ loose members.\n`
      + 'Nothing to seed. Tag some ideas with an area, or promote a star by hand in the rail.\n');
    return 0;
  }

  const byTitle = new Map(all.map((f) => [f.title.toLowerCase(), f]));
  let stars = 0; let planets = 0; let promoted = 0;   // promoted = a star taken OUT of the loose pool

  for (const { theme, items } of themes) {
    const name = starName(theme);
    const verdict = sharedVerdict(items);
    let star = byTitle.get(name.toLowerCase());

    if (star && !star.isStar && star.parentId == null) {
      // A row already carries the theme's name — promote that rather than
      // creating a second one wearing the same title.
      process.stdout.write(`★ ${name}  (promoting the existing idea #${star.id})\n`);
      if (!DRY) star = await api('PATCH', `${base}/${star.id}`, { isStar: true });
      stars++; promoted++;
    } else if (!star) {
      process.stdout.write(`★ ${name}  (new star${verdict ? `, ${verdict}` : ', unjudged'})\n`);
      if (!DRY) {
        star = await api('POST', base, {
          title: name,
          note: `The ${theme} system. Seeded from the ${items.length} ideas already tagged "${theme}" — `
            + 'rename it, judge it, or dissolve it back into loose ideas from the rail.',
        });
        await api('PATCH', `${base}/${star.id}`, { isStar: true, area: theme, ...(verdict ? { alignment: verdict } : {}) });
      }
      stars++;
    } else {
      process.stdout.write(`★ ${name}  (already a star, #${star.id})\n`);
    }

    for (const f of items) {
      if (star && f.id === star.id) continue;      // a promoted star is not its own planet
      process.stdout.write(`  ● #${f.id} ${f.title.slice(0, 66)}\n`);
      if (!DRY) await api('PATCH', `${base}/${f.id}`, { parentId: star.id });
      planets++;
    }
  }

  // What is left loose: the candidates, less the ones that became planets and
  // the ones PROMOTED into stars. A newly created star was never in the pool,
  // so it is not subtracted — counting it would under-report what stays loose.
  const left = loose.length - planets - promoted;
  process.stdout.write(`\n${DRY ? '[dry] ' : ''}${stars} star${stars === 1 ? '' : 's'} `
    + `(${stars - promoted} new, ${promoted} promoted), ${planets} planet${planets === 1 ? '' : 's'}. `
    + `${left} idea${left === 1 ? '' : 's'} stay loose — `
    + 'on the north star\'s shells if judged, in the drift belt if not.\n');
  if (DRY) process.stdout.write('\nNothing was written. Re-run with --run to apply.\n');
  else process.stdout.write('\nMoons are yours to make: select a planet in the rail and adopt pieces into it.\n');
  return 0;
}

// Direct run (node scripts/stack-seed-galaxy.mjs) as well as `stack seed-galaxy`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => {
    process.stderr.write(`seed-galaxy failed: ${e.message}\n`);
    process.exit(1);
  });
}
