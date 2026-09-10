// The gateway reachability probe (#481), against a throwaway HTTP server on an
// ephemeral port — no gateway, no network, no host state.
//
//   node server/test/omniroute-probe.test.mjs      # exits non-zero on any failure
//
// What this pins is the half of `probeOmniRoute` that is easy to get wrong and
// impossible to notice: the REASON. A probe that answers `{reachable:false}`
// and nothing else turns "the gateway is not running" into "Stack is broken",
// which is the same failure CLAUDE.md's fail-SILENT rule is about — the reader
// mistakes absence for good news, or for their own mistake. So every unreachable
// case below asserts what it SAYS, not just that it said no.
//
// The timeout case is the other one worth a test: a host that accepts the
// connection and then goes quiet must cost the caller `timeoutMs`, not the
// session. A regression there hangs the limit prompt, which is exactly when the
// owner is least able to wait.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// A fake HOME so the resolver cannot pick up the real ~/.stack/env — every base
// URL in this file comes from process.env, which wins that chain anyway, but a
// test that depends on the host having no config is a test that fails on one
// machine and passes on another.
const fakeHome = mkdtempSync(join(tmpdir(), 'stack-omniroute-probe-'));
process.env.HOME = fakeHome;
delete process.env.USERPROFILE;

const { probeOmniRoute, availableProvidersLive } = await import('../../terminal/model-switch.mjs');

// Stand up a server that answers however the current test wants, and hand back
// its base URL. `mode` is read per request so one server covers every case.
let mode = 'ok';
const server = createServer((req, res) => {
  if (mode === 'hang') return;               // accept, never answer
  if (mode === 'error') { res.writeHead(500); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

try {
  // ---- 200: the gateway is up ------------------------------------------
  process.env.OMNIROUTE_BASE_URL = base;
  mode = 'ok';
  check('200: reachable', await probeOmniRoute(), { reachable: true, baseUrl: base, reason: '' });

  // The probe must hit /api/health specifically — the liveness path is the one
  // endpoint the gateway serves UNAUTHENTICATED. Probing /v1/models instead
  // would report a running gateway as down on every host without a key.
  let hitPath = '';
  const spy = createServer((req, res) => { hitPath = req.url; res.writeHead(200); res.end('{}'); });
  await new Promise((r) => spy.listen(0, '127.0.0.1', r));
  process.env.OMNIROUTE_BASE_URL = `http://127.0.0.1:${spy.address().port}`;
  await probeOmniRoute();
  check('200: probes the unauthenticated liveness path', hitPath, '/api/health');
  await new Promise((r) => spy.close(r));

  // ---- 500: answering, but not well ------------------------------------
  process.env.OMNIROUTE_BASE_URL = base;
  mode = 'error';
  const err = await probeOmniRoute();
  check('500: not reachable', err.reachable, false);
  check('500: the reason names the status', err.reason, 'gateway answered HTTP 500');

  // ---- refused: nothing is listening -----------------------------------
  // A port we opened and closed, so it is genuinely free rather than merely
  // unlikely. Not a low port: undici blocks those with a "bad port" that never
  // reaches the socket, which would test the wrong branch.
  const dead = createServer(() => {});
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  process.env.OMNIROUTE_BASE_URL = `http://127.0.0.1:${deadPort}`;
  const refused = await probeOmniRoute();
  check('refused: not reachable', refused.reachable, false);
  check('refused: the reason is the syscall, not "fetch failed"', refused.reason, 'ECONNREFUSED');

  // A down gateway is not in the live list, and the list still carries WHY.
  const live = await availableProvidersLive();
  check('refused: the gateway is not offered', live.providers.map((p) => p.key), []);
  check('refused: the live list carries the reason', live.gateway.reason, 'ECONNREFUSED');

  // ---- hung: accepted, then silence ------------------------------------
  process.env.OMNIROUTE_BASE_URL = base;
  mode = 'hang';
  const t0 = Date.now();
  const hung = await probeOmniRoute({ timeoutMs: 300 });
  const elapsed = Date.now() - t0;
  check('hung: not reachable', hung.reachable, false);
  check('hung: the reason names the timeout', hung.reason, 'no answer within 300ms');
  check('hung: gave up inside a second, rather than hanging', elapsed < 1000, true);

  // ---- up: the gateway leads the list ----------------------------------
  mode = 'ok';
  const upLive = await availableProvidersLive();
  check('up: the gateway is offered', upLive.providers.map((p) => p.key), ['omniroute']);
  check('up: and it is first, being the one entry that needs no key',
    upLive.providers[0].key, 'omniroute');
} finally {
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.();
  rmSync(fakeHome, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
