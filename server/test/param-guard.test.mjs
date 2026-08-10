#!/usr/bin/env node
// A MALFORMED ROUTE PARAM MUST NOT KILL THE API.
//
// Found while testing #174: `DELETE /api/projects/stack/roadmap/undefined`
// terminated the whole server process. The route did `Number(req.params.id)`,
// pg rejected the NaN, and Express 4 does not catch a rejected promise from an
// async handler — so it surfaced as an unhandled rejection, which Node has
// treated as fatal since v15. One malformed URL from any authenticated caller
// took Stack down for every project until the container restarted, and it is
// reachable BY ACCIDENT: that is how it was found, from a test script
// interpolating an `undefined` id into a path.
//
// This walks every numeric-id router and asserts two things per route: a clean
// 400 (not a 500, and not a hang), and — the one that actually matters — the
// server is still answering afterwards.
//
// Needs a running server (it writes nothing, so the database need not be empty):
//   DATABASE_URL=… API_TOKEN=testtok PORT=4599 node server/src/index.js &
//   API=http://127.0.0.1:4599 TOKEN=testtok node server/test/param-guard.test.mjs

const API = process.env.API || 'http://127.0.0.1:4599';
const TOKEN = process.env.TOKEN || 'testtok';
const SLUG = process.env.SLUG || 'param-test';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const call = async (method, path) => {
  try {
    const r = await fetch(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(5000),
    });
    return r.status;
  } catch { return 0; }   // 0 = no answer at all (dead, or hanging)
};

const alive = async () => (await call('GET', '/api/health')) === 200;

// Seed a project so the routers get past their own slug lookup — otherwise a
// 404 would mask whether the param guard ran at all.
await fetch(`${API}/api/ingest`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    project: { slug: SLUG, name: 'Param test' },
    session: { session_id: 'param-seed', authored: true, commit_hash: 'aaa1111' },
  }),
});

check('the server is up before any of this', await alive(), true);

// Every router that coerces an :id, and the shapes a caller actually sends by
// accident: the JS stringification of an absent variable, a word, a float, a
// negative, an empty-ish path segment and a SQL-flavoured one.
const ROUTES = [
  ['DELETE', `/api/projects/${SLUG}/roadmap`],
  ['PATCH', `/api/projects/${SLUG}/roadmap`],
  ['DELETE', `/api/projects/${SLUG}/futures`],
  ['PATCH', `/api/projects/${SLUG}/futures`],
  ['DELETE', `/api/projects/${SLUG}/notes`],
  ['DELETE', `/api/projects/${SLUG}/checks`],
  ['PATCH', `/api/projects/${SLUG}/checks`],
  ['DELETE', `/api/projects/${SLUG}/workbench/cards`],
  ['DELETE', '/api/tips'],
  ['PATCH', '/api/tips'],
];
const BAD = ['undefined', 'null', 'NaN', 'abc', '1.5', '-3', '0', '3abc', '1%20OR%201'];

for (const [method, base] of ROUTES) {
  let worst = '';
  for (const bad of BAD) {
    const status = await call(method, `${base}/${bad}`);
    // 400 is the guard. 404 is fine too — some of these paths do not exist on
    // every router, and a route that is not there never reaches a handler.
    // A 500 means it blew up, and a 0 means it did not answer at all.
    if (status !== 400 && status !== 404 && !worst) worst = `${bad} → ${status}`;
  }
  check(`${method} ${base}/<malformed> is refused cleanly`, worst, '');
}

check('AND THE SERVER IS STILL ALIVE — the whole point', await alive(), true);

// A well-formed id still behaves: the guard must not have made every id route
// a 400. An id that does not exist is a 404, which proves the handler ran.
check('a well-formed but absent id still reaches the handler (404, not 400)',
  await call('DELETE', `/api/projects/${SLUG}/roadmap/999999`), 404);

check('the server is alive at the end too', await alive(), true);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
