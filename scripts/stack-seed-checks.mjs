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
    { name: 'Control — autopilot config', url: u('/api/control'), auth: true, json_path: 'autopilot.maxItems' },
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
    { name: 'Control — plan coverage', url: u('/api/control'), auth: true, json_path: 'projects.0.planCoverage.unplanned' },
    { name: 'Control — per-project rows', url: u('/api/control'), auth: true, json_path: 'projects' },
    { name: 'Control — model catalogue', url: u('/api/control'), auth: true, json_path: 'models' },
    // The Roles room's run-level counters. `plan` is the one that carries a
    // rule rather than a number: a plan night commits nothing by design, so it
    // is counted apart from the advised/unadvised land rate. Losing the field
    // would fold plan nights back into that comparison and quietly score the
    // advisor as having failed to land runs it was never asked to land.
    { name: 'Control — roles run counters', url: u('/api/control'), auth: true, json_path: 'roles.runs.plan' },
    { name: 'Control — roles plan-night split', url: u('/api/control'), auth: true, json_path: 'roles.worth.advisedPlanRuns' },
    // The interactive half. `manual` is what makes the room readable while the
    // arm switch is off; `everyModel` is the merged receipt. Both are pure
    // reads over sessions the hook already records, so losing either is silent
    // — the room simply falls back to autopilot-only and looks correct.
    { name: 'Control — roles interactive sessions', url: u('/api/control'), auth: true, json_path: 'roles.manual.sessions' },
    { name: 'Control — roles delegation count', url: u('/api/control'), auth: true, json_path: 'roles.manual.agentCalls' },
    { name: 'Control — roles merged model receipt', url: u('/api/control'), auth: true, json_path: 'roles.everyModel' },
    // The delegated half, read from each subagent's OWN transcript. Losing it
    // is the silent failure that matters: the room keeps rendering main-loop
    // spend and looks complete while the larger half of every delegating
    // session goes unreported.
    { name: 'Control — roles subagent spend', url: u('/api/control'), auth: true, json_path: 'roles.manual.agentTokens' },
    { name: 'Control — roles priced delegations', url: u('/api/control'), auth: true, json_path: 'roles.manual.agentsRecorded' },
    // Turn 3 — whether the Refine dialog offers its ✦ draft at all. The button
    // is ABSENT without a key, so losing this field silently removes an
    // affordance rather than breaking one: the dialog still works and nobody
    // finds out the assist stopped being offered.
    { name: 'Review — the Gemini-ready flag', url: u('/api/review'), auth: true, json_path: 'geminiReady' },
    // The Now room's two host-fed signals. Both are ARRAYS that are usually
    // EMPTY — nothing is normally stopped and nobody is normally colliding —
    // which is exactly why they need a check: if the key stops being served,
    // the room renders "nothing is waiting on you" and looks entirely correct
    // while a session sits blocked on a permission prompt all night. Asserting
    // the path, not a count: the count is meant to be zero most of the time.
    { name: 'Control — what is waiting on you', url: u('/api/control'), auth: true, json_path: 'attention' },
    { name: 'Control — same-file collisions', url: u('/api/control'), auth: true, json_path: 'conflicts' },
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
    { name: 'Agents — the ops list is served', url: u('/api/agents'), auth: true, json_path: 'agents.0.ops.0.op' },
    { name: 'Agents — the key flag frames the room', url: u('/api/agents'), auth: true, json_path: 'geminiReady' },
    { name: 'Agents — auth gate closed', url: u('/api/agents'), expect_status: 401 },
    // The per-project read the tabs actually use — a different route with its
    // own shape, and the one whose absence hides the switch rather than the
    // feature.
    { name: 'Project — tab agent state', url: u(`/api/projects/${slug}`), auth: true, json_path: 'agents.auditor.enabled' },
    { name: 'Search — grouped counts', url: u('/api/search?q=roadmap'), auth: true, json_path: 'counts.total' },
    { name: 'Search — empty query is empty', url: u('/api/search?q='), auth: true, json_path: 'counts.total', json_expect: '0' },
    { name: 'Timeline — daily graph', url: u('/api/timeline'), auth: true, json_path: 'graph.0.date' },
    { name: 'Settings — session defaults', url: u('/api/settings'), auth: true, json_path: 'sessionDefaults' },

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
    { name: 'Futures — collection', url: u(`/api/projects/${slug}/futures`), auth: true, json_path: '0.title' },
    // #312 — the whole Polaris galaxy is derived from this field: no isStar and
    // every idea renders loose, with no star, no planet and no moon anywhere in
    // the sky. Existence only — false is the common value and a real answer.
    { name: 'Futures — galaxy shape field', url: u(`/api/projects/${slug}/futures`), auth: true, json_path: '0.isStar' },
    { name: 'Notes — collection', url: u(`/api/projects/${slug}/notes`), auth: true, expect_status: 200 },
    // The Workbench canvas. `cards` is the load-bearing key — the tab renders
    // nothing without it, and the read is also what BACKFILLS a card for any
    // note filed outside the canvas, so a green here means old notes are still
    // reachable. `polaris` is the pull picker's whole funnel — its onCanvas
    // flag is what stops an idea being pulled onto the canvas twice, and a
    // missing flag would read as "nothing is picked yet" for every idea.
    { name: 'Workbench — the canvas', url: u(`/api/projects/${slug}/workbench`), auth: true, json_path: 'cards' },
    { name: 'Workbench — the Polaris picker', url: u(`/api/projects/${slug}/workbench`), auth: true, json_path: 'polaris' },
    { name: 'Workbench — picker already-on-canvas flag', url: u(`/api/projects/${slug}/workbench`), auth: true, json_path: 'polaris.0.onCanvas' },
    { name: 'Checks — collection', url: u(`/api/projects/${slug}/checks`), auth: true, json_path: '0.name' },
    { name: 'Tips — app-wide library', url: u('/api/tips'), auth: true, json_path: '0.name' },

    // -- the automation spine: the payloads the fleet itself depends on
    { name: 'Autopilot — run ledger', url: u(`/api/projects/${slug}/autopilot/runs`), auth: true, json_path: '0.outcome' },
    { name: 'Autopilot — job queue', url: u('/api/autopilot/jobs'), auth: true, json_path: '0.kind' },
    { name: 'Autopilot — schedule', url: u('/api/autopilot/schedule'), auth: true, expect_status: 200 },

    // -- one semantic check: what a path assertion cannot express (#261 step 3).
    //    Degrades silently when Gemini has no key.
    {
      name: '✧ Overview reads like a healthy deck',
      url: u('/api/overview'), auth: true,
      semantic: 'this JSON describes at least one software project with activity, and contains no error or exception message',
    },
  ];
}

// Every field the API accepts, so an omitted key CLEARS rather than lingering
// from an older definition of the same check.
const FIELDS = ['url', 'method', 'expect_status', 'req_body', 'contains', 'json_path', 'json_expect', 'semantic', 'auth'];
const full = (c) => ({
  url: c.url, method: c.method || 'GET', expect_status: c.expect_status ?? 200,
  req_body: c.req_body || '', contains: c.contains || '',
  json_path: c.json_path || '', json_expect: c.json_expect || '',
  semantic: c.semantic || '', auth: !!c.auth,
});
// The API answers in camelCase; compare like-for-like before claiming a change.
const current = (row) => ({
  url: row.url, method: row.method, expect_status: row.expectStatus,
  req_body: row.reqBody, contains: row.contains,
  json_path: row.jsonPath, json_expect: row.jsonExpect,
  semantic: row.semantic, auth: !!row.auth,
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

  const extra = existing.filter((c) => !SUITE.some((s) => s.name === c.name));
  for (const c of extra) process.stdout.write(`· ${c.name} — not in the suite, left alone\n`);
  process.stdout.write(`\n${DRY ? '[dry] ' : ''}${created} created, ${updated} updated, `
    + `${same} unchanged, ${extra.length} left alone.\n`);

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
