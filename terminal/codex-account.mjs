// Read-only Codex account metadata. Never starts a thread or invokes a model.
// The CLI owns authentication; no credential files or tokens leave this process.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function readCodexAccount({ spawnProcess = spawn, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnProcess('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let done = false;
    let models = [];
    let limits = null;
    let modelDone = false;
    let limitDone = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (method, id, params = {}) => child.stdin.write(`${JSON.stringify({ method, ...(id === null ? {} : { id }), params })}\n`);
    child.on('error', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    lines.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 0) {
          if (msg.error) return finish(null);
          send('initialized', null);
          send('model/list', 1, { limit: 100, includeHidden: false });
          send('account/rateLimits/read', 2);
        } else if (msg.id === 1) {
          models.push(...(Array.isArray(msg.result?.data) ? msg.result.data : []).filter((m) => typeof m.model === 'string').map((m) => ({ id: m.model, label: m.displayName || m.model })));
          if (msg.result?.nextCursor) send('model/list', 1, { limit: 100, cursor: msg.result.nextCursor, includeHidden: false });
          else modelDone = true;
        } else if (msg.id === 2) {
          limits = parseCodexLimits(msg.result);
          limitDone = true;
        }
        if (modelDone && limitDone) finish({ models, limits });
      } catch { finish(null); }
    });
    send('initialize', 0, { clientInfo: { name: 'stack_terminal', version: '1.0.0' } });
  });
}

export function parseCodexLimits(result) {
  const buckets = result?.rateLimitsByLimitId || (result?.rateLimits ? { codex: result.rateLimits } : {});
  const rows = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    for (const window of ['primary', 'secondary']) {
      const w = bucket?.[window];
      if (typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
      const mins = w.windowDurationMins;
      const duration = mins === 10080 ? 'Week' : mins === 300 ? 'Session · 5h' : mins > 0 ? `${mins} min` : window;
      rows.push({ key: `${key}:${window}`, name: `${bucket.limitName || 'Codex'} · ${duration}`, pct: Math.max(0, Math.min(100, w.usedPercent)), resetAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null });
    }
  }
  return rows.length ? rows : null;
}

export function createCodexAccount({ read = readCodexAccount, now = Date.now } = {}) {
  let cache = null;
  let at = 0;
  let attempted = -Infinity;
  let pending;
  function get() {
    if (!pending && now() - attempted >= 60_000) {
      attempted = now();
      pending = Promise.resolve().then(read).then((value) => {
        if (value) { cache = value; at = now(); }
      }).catch(() => {}).finally(() => { pending = null; });
    }
    return cache && now() - at < 600_000 ? cache : null;
  }
  return { get };
}
