#!/usr/bin/env node
// stack-seed-checks.mjs — the regression suite, as code (#261).
//
// Stack's checks ARE its test suite: HTTP tests run against the live app from
// the Quality tab. Before this, the suite was one probe of the site root, so
// "checks green" carried no information — which is why the #212 auto-merge gate
// could never honestly fire and every verdict fell to a human.
//
// The suite lives here rather than only in the database so it is reviewable,
// diffable and re-seedable. Idempotent: checks are matched BY NAME, so a
// re-run updates definitions in place and never duplicates a row. Nothing is
// ever deleted — a check added by hand survives every re-seed.
//
//   stack seed-checks [--slug stack] [--dry] [--run]
//   node scripts/stack-seed-checks.mjs --dry
//
// --dry prints what would change and writes nothing. --run fires the suite
// afterwards and prints the result table (exit 1 if anything is red).
//
// DESIGN RULES for anything added here:
//  • Assert CONTRACTS, not data. `progress` must exist; it must not equal 81.
//    A check that goes red because the board changed is worse than no check.
//  • Equality assertions only on code invariants (health's `ok`, a 401, a 404).
//  • READ-ONLY. A check runs on every Run-all and every autopilot night, so a
//    mutating check would write junk into real trackers forever. Write paths
//    are deliberately NOT covered — see the note printed at the end.
//  • `auth: true` for anything behind the bearer gate. The server attaches its
//    own token, and only to this project's own origin (see routes/checks.js).
//  • The probe runs INSIDE the server container, so the URL has to be reachable
//    from there: the project's public site_url, or a compose-internal host.
//  • The #291 UI smoke check is NOT here. Everything in this file is an HTTP
//    probe the server itself runs; the smoke harness drives a real browser on
//    the HOST and takes ~90 seconds, so it can never be one of these. Its row
//    is planted by the harness's own first POST /report, not seeded — see
//    checks.external in schema.sql and routes/checks.js.
//  • The FEATURE is derived from the name's `<Area> — ` prefix (FEATURE_BY_PREFIX
//    below), so a new check is grouped by being named the way the rest are. Pass
//    `feature:` explicitly only when the prefix is not the right group. The
//    label is not part of what a check tests, so re-grouping one never clears
//    its result or its history.
//  • Renaming a check ORPHANS the old row (name is the identity), and this file
//    will never delete it. If a rename is because the thing it asserted moved
//    or went away, delete the old row from the Quality page in the same change —
//    otherwise it sits red forever asserting something that is gone (BUG-11).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---- the suite ----------------------------------------------------------
// `name` is the identity — renaming a check creates a new one and orphans the
// old. ORIGIN is the project's own site URL, the only origin the server will
// attach its token to.
function suiteFor(slug, ORIGIN) {
  const u = (path) => `${ORIGIN}${path}`;
  return [
    // -- the front door, and the auth gate that protects everything else.
    //    These carry no token: that they behave unauthenticated IS the assertion.
    { name: 'Site up', url: ORIGIN, contains: '<div id="root">' },
    { name: 'Health — the only public route', url: u('/api/health'), json_path: 'ok', json_expect: 'true' },
    { name: 'Auth gate closed — overview', url: u('/api/overview'), expect_status: 401 },
    { name: 'Auth gate closed — settings', url: u('/api/settings'), expect_status: 401 },
    { name: 'Auth gate closed — project detail', url: u(`/api/projects/${slug}`), expect_status: 401 },
    { name: 'Public showcase rejects a bad token', url: u(`/api/public/${slug}/not-a-real-token`), expect_status: 404 },

    // -- the cross-project read layer
    { name: 'Overview — status totals', url: u('/api/overview'), auth: true, json_path: 'totals.byStatus' },
    { name: 'Overview — resume-card flag', url: u('/api/overview'), auth: true, json_path: 'keepResumeCard' },
    { name: 'Overview — contribution graph', url: u('/api/overview'), auth: true, json_path: 'graph.0.date' },
    // BUG-2 — the deck's own five keys. Every one of them renders as EMPTY when
    // it is absent, and empty is the good-news shape: no resume card, no
    // parallel work, nothing to verify, no blockers. A key that stops being
    // served takes a whole section of the dashboard away and looks calm doing
    // it, which is the same fail-silent rule CLAUDE.md states for attention[]
    // and for a NULL review verdict. `resume` is nullable and asserted anyway:
    // a check fails on a MISSING path, never on a null one, so "no session
    // yet" passes and "the key is gone" does not.
    { name: 'Overview — the resume card', url: u('/api/overview'), auth: true, json_path: 'resume' },
    { name: 'Overview — branch claims', url: u('/api/overview'), auth: true, json_path: 'claims' },
    { name: 'Overview — the review queue', url: u('/api/overview'), auth: true, json_path: 'review.total' },
    { name: 'Overview — blockers', url: u('/api/overview'), auth: true, json_path: 'blockers' },
    { name: 'Overview — roadmap rollup buckets', url: u('/api/overview'), auth: true, json_path: 'roadmap.buckets' },
    { name: 'Overview — bugs by project', url: u('/api/overview'), auth: true, json_path: 'bugs.byProject' },
    // #255 — the plan sweep's two halves of the contract: the switch the Now
    // room writes, and the coverage the Plan room reads. Asserting the PATH
    // exists (not a value) is the point — the numbers change every night.
    { name: 'Settings — plan sweep switch', url: u('/api/settings'), auth: true, json_path: 'autopilotPlanSweep' },
    // #287 — the host daemon reads this every 10 minutes to decide what to
    // terminate. If the field stops being served the daemon fails safe and
    // reaps nothing, which is silent — hence a check rather than trust.
    { name: 'Settings — idle session timeout', url: u('/api/settings'), auth: true, json_path: 'termIdleHours' },
    // #208 — the preview sweep's contract. `work` is what the host polls every
    // minute; if its shape breaks, previews silently stop being torn down and
    // public URLs outlive their expiry, which is the failure that matters most.
    { name: 'Previews — the sweep feed', url: u('/api/previews/work'), auth: true, json_path: 'start' },
    // #229 — the worktree register. Usually empty (most sessions are not
    // running in a worktree), so this asserts the route answers rather than
    // asserting a count.
    { name: 'Worktrees — registry', url: u('/api/worktrees'), auth: true, expect_status: 200 },
    // The answer channel's front door. A bad fingerprint must be REFUSED with
    // a 400 rather than relayed — the host's re-read is the real guard, but a
    // server that forwarded anything shaped like a request would put the whole
    // weight of "do not type a stray keystroke into a live session" on a
    // websocket round trip that may not happen.
    { name: 'Terminal — a malformed prompt answer is refused', method: 'POST',
      url: u('/api/terminal/answer'), auth: true, expect_status: 400,
      req_body: '{"name":"stack-term-nope","fingerprint":"not-a-fingerprint","choice":"approve"}' },
    // #361 — the tab agents. The registry is the SERVER's, and three tabs
    // read it to decide whether to render their ✧ surfaces at all, so a
    // payload that stops carrying it doesn't error — it quietly reads as
    // "no switches", and every agent surface renders on regardless of what
    // the owner set. Assert the shape, never a state: `enabled` is a switch
    // the owner is meant to flip, so a check on its VALUE would go red the
    // moment the feature was used as intended. The `tab` binding is the one
    // thing that is not supposed to move.
    { name: 'Agents — the registry is served', url: u('/api/agents'), auth: true, json_path: 'agents.0.key' },
    { name: 'Agents — each one names its tab', url: u('/api/agents'), auth: true, json_path: 'agents.0.tab' },
    // Agent 0 is the CURATOR — the only agent left, and the index moved when
    // the Auditor was culled with the tab consoles. This check twice pinned an
    // index rather than a name: it read `agents.0.ops.0.op` while agent 0 was
    // the op-less Auditor and spent its life asserting that a documented empty
    // list was not empty. The Curator's ops are CLOSED and code-defined, so
    // the only thing that can empty them is a commit that should be revisiting
    // this line anyway.
    { name: 'Agents — the ops list is served', url: u('/api/agents'), auth: true, json_path: 'agents.0.ops.0.op' },
    // #364 moved the tab agents onto Claude on the host, so what frames this
    // room is whether the DAEMON is on the line — not whether a key exists.
    // `geminiReady` went out of the payload deliberately; this check kept
    // asserting it and only failed once the suite was actually seeded, which
    // is the argument for seeding a check in the same commit that adds it.
    { name: 'Agents — the host flag frames the room', url: u('/api/agents'), auth: true, json_path: 'hostReady' },
    { name: 'Agents — auth gate closed', url: u('/api/agents'), expect_status: 401 },
    // #418 — the app-wide readiness map the corner ＋ reads. It fails the way
    // every readiness read fails: SILENTLY. A payload that stops carrying
    // `curator.opsReady` leaves the dock unable to tell "switched off" from
    // "backend down", and the ✧ that should have said which one just stops
    // being drawn — a feature disappearing with nothing anywhere to notice.
    // `opsReady` and not `enabled`, for the reason the block above gives: the
    // switch is the owner's to flip, the SHAPE is the contract.
    { name: 'Agents — the app-wide readiness map', url: u('/api/agents/state'), auth: true, json_path: 'curator.opsReady' },
    { name: 'Agents — readiness names the Gemini-backed ops', url: u('/api/agents/state'), auth: true, json_path: 'curator.opsGemini' },
    { name: 'Agents — state gate closed', url: u('/api/agents/state'), expect_status: 401 },
    // The per-project read the tabs actually use — a different route with its
    // own shape, and the one whose absence hides the switch rather than the
    // feature.
    { name: 'Project — tab agent state', url: u(`/api/projects/${slug}`), auth: true, json_path: 'agents.curator.enabled' },
    { name: 'Search — grouped counts', url: u('/api/search?q=roadmap'), auth: true, json_path: 'counts.total' },
    { name: 'Search — empty query is empty', url: u('/api/search?q='), auth: true, json_path: 'counts.total', json_expect: '0' },
    // BUG-2 — ⌘K's counts and its RESULTS are two different keys, and only the
    // counts were pinned. A payload that kept `counts` and lost `groups` reads
    // as "17 matches" over an empty palette.
    { name: 'Search — the grouped results', url: u('/api/search?q=roadmap'), auth: true, json_path: 'groups' },
    { name: 'Timeline — daily graph', url: u('/api/timeline'), auth: true, json_path: 'graph.0.date' },
    { name: 'Timeline — 3-day window', url: u('/api/timeline?days=3&graph=0'), auth: true, json_path: 'windowDays' },
    { name: 'Settings — session defaults', url: u('/api/settings'), auth: true, json_path: 'sessionDefaults' },
    // BUG-2 — the settings that CHANGE BEHAVIOUR (the table in CLAUDE.md).
    // Each is read by something that fails open or closed on it, and a missing
    // field is read as its default by every consumer: `autopilotEnabled` is the
    // arm switch, `autoRecord` decides whether the SessionEnd hook records at
    // all, and `accessPinSet` is whether PIN sign-in is even offered.
    { name: 'Settings — the arm switch', url: u('/api/settings'), auth: true, json_path: 'autopilotEnabled' },
    { name: 'Settings — hook auto-record', url: u('/api/settings'), auth: true, json_path: 'autoRecord' },
    { name: 'Settings — assist fields', url: u('/api/settings'), auth: true, json_path: 'assistFields' },
    { name: 'Settings — PIN sign-in available', url: u('/api/settings'), auth: true, json_path: 'accessPinSet' },

    // -- projects and their collections
    { name: 'Projects — list', url: u('/api/projects'), auth: true, json_path: '0.slug' },
    { name: 'Project — computed progress', url: u(`/api/projects/${slug}`), auth: true, json_path: 'progress' },
    { name: 'Project — roadmap buckets', url: u(`/api/projects/${slug}`), auth: true, json_path: 'roadmap.must' },
    { name: 'Project — unknown slug 404s', url: u('/api/projects/no-such-project-xyz'), auth: true, expect_status: 404 },
    // The terminal's "Jump back in" debrief — a per-project resume view
    // distinct from the autopilot's night debrief. `commits` is the field
    // only this route owns.
    { name: 'Project — resume debrief', url: u(`/api/projects/${slug}/debrief`), auth: true, json_path: 'commits' },
    { name: 'Bugs — collection', url: u(`/api/projects/${slug}/bugs`), auth: true, json_path: '0.id' },
    // #278 — the Quality page's two contract additions. `checkId` is the bug↔check
    // link the merged page renders both ways; the path only has to EXIST (it is
    // null on a hand-filed bug, which is the common case).
    { name: 'Bugs — bug↔check link present', url: u(`/api/projects/${slug}/bugs`), auth: true, json_path: '0.checkId' },
    { name: 'Project — Gemini readiness flag', url: u(`/api/projects/${slug}`), auth: true, json_path: 'geminiReady' },
    // #279 — per-check history. Asserting only 200 on purpose: the payload is
    // keyed by check id, so any path assertion would name a specific check and
    // go red the day that check is renamed or retired.
    { name: 'Checks — per-check history', url: u(`/api/projects/${slug}/checks/history?limit=5`), auth: true },
    { name: 'Roadmap — collection', url: u(`/api/projects/${slug}/roadmap`), auth: true, json_path: 'must' },
    { name: 'Checks — collection', url: u(`/api/projects/${slug}/checks`), auth: true, json_path: '0.name' },
    { name: 'Tips — app-wide library', url: u('/api/tips'), auth: true, json_path: '0.name' },
    // The agent spawn-and-customisation engine's read surface. The built-in
    // profiles merge in from code and can't all be deleted, so a non-empty
    // keyed `profiles` list is the real invariant — not which one sorts
    // first, which shifts the moment a custom profile's key sorts earlier.
    // The URL is /api/agent-profiles, NOT /api/agents: those are two different
    // things that arrived under the same word (agents.js's header says so). The
    // check named the surface registry and asserted the SPAWN catalogue's shape,
    // so it had been red on a working route.
    { name: 'Agents — profile catalogue', url: u('/api/agent-profiles'), auth: true, json_path: 'profiles.0.key' },

    // -- the automation spine: the payloads the fleet itself depends on
    { name: 'Autopilot — run ledger', url: u(`/api/projects/${slug}/autopilot/runs`), auth: true, json_path: '0.outcome' },
    { name: 'Autopilot — job queue', url: u('/api/autopilot/jobs'), auth: true, json_path: '0.kind' },
    // #243 — the advice lane's front door. A read-only pass is queued and read
    // through /api/autopilot/jobs/:id/advice; a nonexistent job must 404 rather
    // than 200 with a hollow body, which is the whole assertion.
    { name: 'Autopilot — advice route 404s an unknown job', url: u('/api/autopilot/jobs/999999999/advice'), auth: true, expect_status: 404 },
    // #243 — jobShape()'s new field. Depends, like the check above it, on at
    // least one job ever having been queued. `adviceReady` is a boolean and
    // false is the common value, so existence (not truth) is the assertion —
    // the field is part of the job payload's contract, and losing it would go
    // unnoticed with no visible error.
    { name: 'Autopilot — job payload carries advice state', url: u('/api/autopilot/jobs'), auth: true, json_path: '0.adviceReady' },
    { name: 'Autopilot — schedule', url: u('/api/autopilot/schedule'), auth: true, expect_status: 200 },

    // -- one semantic check: what a path assertion cannot express (#261 step 3).
    //    Degrades silently when Gemini has no key.
    {
      name: '✧ Overview reads like a healthy deck',
      url: u('/api/overview'), auth: true, feature: 'The read layer',
      semantic: 'this JSON describes at least one software project with activity, and contains no error or exception message',
    },
  ];
}

// ---- what each check is testing -----------------------------------------
//
// The Quality page groups the suite by `checks.feature`, and this is where the
// grouping is decided for Stack's own suite. It is derived rather than typed on
// every row, because every check here is already named `<Area> — <assertion>`
// and a second hand-maintained label would be one more thing to forget.
//
// Several prefixes deliberately share a feature: "which part of Stack is thin"
// is a coarser question than "which route is this", and a table of twenty
// one-check rows answers neither. A prefix that is not in the map lands in
// Ungrouped, which is a real answer and shows up as one row — never hidden.
const FEATURE_BY_PREFIX = {
  // the parts anyone can reach, and the gate that stops them
  'Site up': 'The front door',
  Health: 'The front door',
  'Auth gate closed': 'The front door',
  'Public showcase rejects a bad token': 'The front door',
  // the cross-project reads the dashboard and ⌘K are drawn from
  Overview: 'The read layer',
  Search: 'The read layer',
  Timeline: 'The read layer',
  // what actually runs the nights
  Autopilot: 'The automation spine',
  Terminal: 'The automation spine',
  Previews: 'The automation spine',
  Worktrees: 'The automation spine',
  // one project and everything hanging off it
  Projects: 'A project and its collections',
  Project: 'A project and its collections',
  Bugs: 'A project and its collections',
  Checks: 'A project and its collections',
  Roadmap: 'A project and its collections',
  Futures: 'A project and its collections',
  Tips: 'A project and its collections',
  // the switches and the specialists they switch
  Settings: 'Settings',
  Agents: 'The agents',
  Instructions: 'Instructions',
};
const featureFor = (name) => FEATURE_BY_PREFIX[String(name).split(' — ')[0]] || '';

// Every field the API accepts, so an omitted key CLEARS rather than lingering
// from an older definition of the same check.
const FIELDS = ['url', 'method', 'expect_status', 'req_body', 'contains', 'json_path', 'json_expect', 'semantic', 'feature', 'auth'];
const full = (c) => ({
  url: c.url, method: c.method || 'GET', expect_status: c.expect_status ?? 200,
  req_body: c.req_body || '', contains: c.contains || '',
  json_path: c.json_path || '', json_expect: c.json_expect || '',
  semantic: c.semantic || '', feature: c.feature ?? featureFor(c.name), auth: !!c.auth,
});
// The API answers in camelCase; compare like-for-like before claiming a change.
const current = (row) => ({
  url: row.url, method: row.method, expect_status: row.expectStatus,
  req_body: row.reqBody, contains: row.contains,
  json_path: row.jsonPath, json_expect: row.jsonExpect,
  semantic: row.semantic, feature: row.feature || '', auth: !!row.auth,
});

export async function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(`--${n}`);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const slug = arg('slug') || 'stack';
  const DRY = flag('dry');
  const RUN = flag('run');

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

  const project = await api('GET', `/api/projects/${slug}`);
  const ORIGIN = (project.siteUrl || API).replace(/\/$/, '');
  if (!project.siteUrl) {
    process.stdout.write(`note: ${slug} has no site URL set — falling back to ${ORIGIN}\n\n`);
  }

  const SUITE = suiteFor(slug, ORIGIN);
  const existing = await api('GET', `/api/projects/${slug}/checks`);
  const byName = new Map(existing.map((c) => [c.name, c]));

  let created = 0; let updated = 0; let same = 0;
  for (const spec of SUITE) {
    const want = full(spec);
    const row = byName.get(spec.name);
    if (!row) {
      if (!DRY) await api('POST', `/api/projects/${slug}/checks`, { name: spec.name, ...want });
      process.stdout.write(`+ ${spec.name}\n`);
      created++;
      continue;
    }
    const have = current(row);
    const diff = FIELDS.filter((k) => String(want[k]) !== String(have[k]));
    if (!diff.length) { same++; continue; }
    if (!DRY) await api('PATCH', `/api/projects/${slug}/checks/${row.id}`, want);
    process.stdout.write(`~ ${spec.name}  (${diff.join(', ')})\n`);
    updated++;
  }

  // Checks the suite does not own. Nothing here is ever deleted — a check added
  // by hand is the owner's, and this file has no way to tell one from a row the
  // suite renamed away from. But a RED one has to be said loudly (BUG-11): a
  // payload key was once renamed, the new check was added under a new name and
  // the old row was left behind asserting a key that no longer existed. It failed every night for a fortnight, indistinguishable on
  // the Quality page from a real regression, and "left alone" is what this line
  // said about it each time. An unowned check that passes is somebody's extra
  // cover; an unowned check that fails is a claim nobody is maintaining.
  const extra = existing.filter((c) => !SUITE.some((s) => s.name === c.name));
  const stale = extra.filter((c) => c.lastStatus === 'fail');
  for (const c of extra) {
    const why = c.lastStatus === 'fail' ? ` — FAILING: ${c.lastError || 'no reason recorded'}` : '';
    process.stdout.write(`· ${c.name} — not in the suite, left alone${why}\n`);
  }
  process.stdout.write(`\n${DRY ? '[dry] ' : ''}${created} created, ${updated} updated, `
    + `${same} unchanged, ${extra.length} left alone.\n`);
  if (stale.length) {
    process.stdout.write(`\n${stale.length} check${stale.length === 1 ? '' : 's'} outside the suite `
      + `${stale.length === 1 ? 'is' : 'are'} RED. Nothing here will touch them: either fold the\n`
      + 'assertion into this file under its own name, or delete the row from the Quality\n'
      + 'page. A red check the suite does not own reads as a regression forever.\n');
  }

  let code = 0;
  if (RUN && !DRY) {
    process.stdout.write('\nrunning the suite…\n');
    const results = await api('POST', `/api/projects/${slug}/checks/run`, {});
    const pad = Math.max(...results.map((r) => r.name.length));
    for (const r of [...results].sort((a, b) => a.lastStatus.localeCompare(b.lastStatus) || a.name.localeCompare(b.name))) {
      process.stdout.write(`  ${r.lastStatus === 'pass' ? '✓' : '✗'} ${r.name.padEnd(pad)}  `
        + `${String(r.lastCode ?? '—').padEnd(4)} ${String(r.lastMs ?? '—').padStart(5)}ms  ${r.lastError || ''}\n`);
    }
    const failed = results.filter((r) => r.lastStatus !== 'pass');
    process.stdout.write(`\n${results.length - failed.length}/${results.length} passing.\n`);
    if (failed.length) code = 1;
  }

  process.stdout.write('\nNot covered on purpose: write paths that WRITE. Checks run on every Run-all and'
    + '\nevery autopilot night, so a mutating check would put junk into real trackers'
    + '\nforever. Covering those needs a disposable project — a separate item.'
    + '\n\nThe exception is a POST that must be REFUSED: it is a write path only in shape,'
    + '\nand the refusal is the whole assertion. /api/terminal/answer is checked that way'
    + '\nbecause it is the one route that can type into a live session — its argument'
    + '\nvalidation failing open is not something a read could ever notice.\n');
  return code;
}

// Direct run (node scripts/stack-seed-checks.mjs) as well as `stack seed-checks`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => {
    process.stderr.write(`seed-checks failed: ${e.message}\n`);
    process.exit(1);
  });
}
