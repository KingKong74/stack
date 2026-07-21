// Real Plan usage limits — the same numbers Claude Code shows in-app under
// /usage — read from the account's OAuth usage endpoint with the credentials
// the CLI already keeps at ~/.claude/.credentials.json (#195). This replaces
// guessing limits from transcript token counts: the terminal strip can show
// the session (5h) and weekly windows as true percentages with real reset
// times, exactly as the app does.
//
// The token is read fresh on every fetch (the CLI rotates it as it refreshes)
// and never logged. Zero dependencies, pure stdlib + global fetch; every
// failure path — no credentials file, expired token, offline host — degrades
// to null so the daemon simply omits plan data from its frames.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_MS = 60_000;      // refresh at most once a minute
const STALE_MS = 10 * 60_000; // stop serving data older than this

export function createPlanUsage({ credsPath } = {}) {
  const PATH = credsPath || join(homedir(), '.claude', '.credentials.json');
  let cache = null;    // last good parsed payload
  let fetchedAt = 0;   // when it landed
  let inFlight = null; // dedupe concurrent refreshes

  function token() {
    try {
      const t = JSON.parse(readFileSync(PATH, 'utf8'))?.claudeAiOauth?.accessToken;
      return typeof t === 'string' && t ? t : null;
    } catch { return null; }
  }

  // The API's limits[] rows carry percent + resets_at per window; the older
  // five_hour/seven_day blocks are kept as a fallback shape.
  function parse(j) {
    const windows = { session: null, week: null, weekModel: null };
    let activeResetAt = null;
    for (const l of Array.isArray(j?.limits) ? j.limits : []) {
      const at = Date.parse(l?.resets_at || '') || null;
      const w = { pct: Math.round(Number(l?.percent) || 0), resetAt: at };
      if (l?.kind === 'session') windows.session = w;
      else if (l?.kind === 'weekly_all') windows.week = w;
      else if (l?.kind === 'weekly_scoped') {
        windows.weekModel = { ...w, model: l?.scope?.model?.display_name || '' };
      }
      // is_active flags the binding scope, NOT exhaustion (it's true at 46%);
      // a limit is only in force once its window is actually spent.
      if (w.pct >= 100 && at && (!activeResetAt || at < activeResetAt)) activeResetAt = at;
    }
    if (!windows.session && j?.five_hour) {
      windows.session = {
        pct: Math.round(Number(j.five_hour.utilization) || 0),
        resetAt: Date.parse(j.five_hour.resets_at || '') || null,
      };
    }
    if (!windows.week && j?.seven_day) {
      windows.week = {
        pct: Math.round(Number(j.seven_day.utilization) || 0),
        resetAt: Date.parse(j.seven_day.resets_at || '') || null,
      };
    }
    if (!windows.session && !windows.week) return null;
    return { ...windows, activeResetAt };
  }

  async function refresh() {
    const t = token();
    if (!t) return null;
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${t}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const parsed = parse(await res.json());
      if (parsed) { cache = parsed; fetchedAt = Date.now(); }
      return parsed;
    } catch { return null; }
  }

  // Fire-and-forget refresh when the cache has gone cold; always returns the
  // freshest data at most STALE_MS old (or null) without ever blocking the
  // caller — usage frames are built synchronously on the daemon's tick.
  function get() {
    if (Date.now() - fetchedAt >= CACHE_MS && !inFlight) {
      inFlight = refresh().finally(() => { inFlight = null; });
    }
    return cache && Date.now() - fetchedAt < STALE_MS ? cache : null;
  }

  return { get, refresh };
}
