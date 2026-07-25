#!/usr/bin/env node
// Stack — Google Calendar sync (#222).
//
// One-way push: reads Mission Control's autopilot schedule rows and creates
// (or updates) matching Google Calendar events so sessions are visible from
// any calendar app. Idempotency is via GCal extended properties — each event
// carries a private stackScheduleId tag, so re-running never duplicates.
//
// Prerequisites:
//   • PATCH /api/settings with gcalClientId, gcalClientSecret, gcalRefreshToken
//     and optionally gcalCalendarId (defaults to 'primary'). Those values come
//     from a Google Cloud OAuth2 client (Desktop app type). Run the one-time
//     consent flow outside this script (e.g. OAuth Playground) to get the
//     refresh token; this script only needs the long-lived refresh token.
//   • ~/.stack/env must have STACK_API=https://… and STACK_TOKEN=…
//
// Usage:
//   node scripts/stack-sync-gcal.mjs [--dry]
//
//   --dry   Print the planned events without calling Google.
//
// Exit codes: 0 = success (or --dry); 1 = fatal (missing config, auth fail).

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── env loading (same pattern as hook/stack-post.mjs) ─────────────────────

function loadStackEnv() {
  const f = join(homedir(), '.stack', 'env');
  if (!existsSync(f)) return;
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* ignore */ }
}

loadStackEnv();

const API   = (process.env.STACK_API   || '').replace(/\/$/, '');
const TOKEN = process.env.STACK_TOKEN;
const DRY   = process.argv.includes('--dry');

if (!API || !TOKEN) {
  console.error('[stack-sync-gcal] STACK_API and STACK_TOKEN must be set in ~/.stack/env');
  process.exit(1);
}

// ── helpers ────────────────────────────────────────────────────────────────

async function stackGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Stack API ${path} → ${r.status}: ${body}`);
    }
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

// Map getDay() integers (0=Sun … 6=Sat) to RRULE BYDAY abbreviations.
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// The host's local timezone — GCal needs a real IANA name, not an offset.
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Next calendar date (≥ today) that falls on one of the given weekday ints.
function nextOccurrence(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let d = 0; d < 7; d++) {
    const candidate = new Date(today);
    candidate.setDate(today.getDate() + d);
    if (days.includes(candidate.getDay())) return candidate;
  }
  return today; // fallback (shouldn't happen if days.length > 0)
}

// Build the ISO-8601 dateTime string with LOCAL_TZ semantics (no UTC offset
// conversion — let Google interpret it in the declared timeZone).
function localDateTime(date, hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const d = new Date(date);
  d.setHours(hh, mm, 0, 0);
  // toISOString() gives UTC; we want the *local* wall-clock reading.
  // Reconstruct from the local date parts so the string is unambiguous.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hh)}:${pad(mm)}:00`;
}

// Build a GCal event body from a schedule row.
function buildEventBody(row, durationMin) {
  const title = row.itemTitle
    ? `Stack autopilot — ${row.name}: ${row.itemTitle}`
    : `Stack autopilot — ${row.name}`;

  const desc = [
    `Project: ${row.name}`,
    row.itemTitle ? `Item: ${row.itemTitle}` : '',
    row.note ? `Note: ${row.note}` : '',
    '',
    `Managed by Stack. Schedule id: ${row.id}`,
  ].filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n').trim();

  let startDate;
  let recurrence;

  if (row.runDate) {
    // One-off — parse as LOCAL date to avoid UTC-midnight shifting the day.
    const [yr, mo, dy] = row.runDate.split('-').map(Number);
    startDate = new Date(yr, mo - 1, dy);
  } else {
    // Recurring — pick the next occurrence
    const days = Array.isArray(row.days) ? row.days : [];
    startDate = nextOccurrence(days);
    if (days.length > 0) {
      const byDay = days.map((d) => BYDAY[d]).filter(Boolean).join(',');
      recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${byDay}`];
    }
  }

  const startDt = localDateTime(startDate, row.atTime);
  // End time = start + durationMin
  const [hh, mm] = row.atTime.split(':').map(Number);
  const endMin   = hh * 60 + mm + durationMin;
  const endHH    = Math.floor(endMin / 60) % 24;
  const endMM    = endMin % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const endDate  = new Date(startDate);
  if (endMin >= 24 * 60) endDate.setDate(endDate.getDate() + 1);
  const endDt = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endHH)}:${pad(endMM)}:00`;

  const body = {
    summary: title,
    description: desc,
    start: { dateTime: startDt, timeZone: LOCAL_TZ },
    end:   { dateTime: endDt,   timeZone: LOCAL_TZ },
    extendedProperties: {
      private: { stackScheduleId: String(row.id), stackApp: 'stack' },
    },
  };
  if (recurrence) body.recurrence = recurrence;
  return body;
}

// ── Google OAuth2 ──────────────────────────────────────────────────────────

async function getAccessToken(creds) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type:    'refresh_token',
      }),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      throw new Error(`Token exchange failed (${r.status}): ${JSON.stringify(data)}`);
    }
    return data.access_token;
  } finally {
    clearTimeout(t);
  }
}

// ── GCal API helpers ───────────────────────────────────────────────────────

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';

async function gcalRequest(method, path, token, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${GCAL_BASE}${path}`, opts);
    const text = await r.text();
    if (!r.ok) throw new Error(`GCal ${method} ${path} → ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

// Find an existing event stamped with our stackScheduleId (returns event or null).
async function findExistingEvent(calId, scheduleId, token) {
  const qs = new URLSearchParams({
    privateExtendedProperty: `stackScheduleId=${scheduleId}`,
    maxResults: '1',
    singleEvents: 'false',
  });
  const data = await gcalRequest('GET', `/calendars/${encodeURIComponent(calId)}/events?${qs}`, token);
  return data?.items?.[0] || null;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  // 1. Fetch credentials and schedule rows from the Stack API.
  let creds, schedule;
  try {
    [creds, schedule] = await Promise.all([
      stackGet('/api/settings/gcal'),
      stackGet('/api/autopilot/schedule'),
    ]);
  } catch (err) {
    console.error(`[stack-sync-gcal] ${err.message}`);
    process.exit(1);
  }

  const { calendarId, autopilotMinutes } = creds;
  const durationMin = Number(autopilotMinutes) || 120;
  const enabled = schedule.filter((s) => s.enabled);

  console.log(`[stack-sync-gcal] ${enabled.length} enabled schedule row(s) → calendar "${calendarId}"${DRY ? ' [dry run]' : ''}`);

  if (!enabled.length) {
    console.log('[stack-sync-gcal] Nothing to sync.');
    return;
  }

  // 2. Build event payloads (and print in --dry mode).
  const events = enabled.map((row) => ({
    row,
    body: buildEventBody(row, durationMin),
  }));

  if (DRY) {
    for (const { row, body } of events) {
      console.log(`\n  Schedule ${row.id} (${row.slug}):`);
      console.log(`    summary:  ${body.summary}`);
      console.log(`    start:    ${body.start.dateTime} (${body.start.timeZone})`);
      console.log(`    end:      ${body.end.dateTime}`);
      if (body.recurrence) console.log(`    rrule:    ${body.recurrence[0]}`);
      else console.log(`    one-off:  ${row.runDate}`);
    }
    console.log('\n[stack-sync-gcal] Dry run complete — no events created.');
    return;
  }

  // 3. Get an access token.
  let accessToken;
  try {
    accessToken = await getAccessToken(creds);
    console.log('[stack-sync-gcal] Access token obtained.');
  } catch (err) {
    console.error(`[stack-sync-gcal] Auth failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Upsert each event.
  let created = 0, updated = 0, errors = 0;
  for (const { row, body } of events) {
    try {
      const existing = await findExistingEvent(calendarId, row.id, accessToken);
      if (existing) {
        await gcalRequest('PUT', `/calendars/${encodeURIComponent(calendarId)}/events/${existing.id}`, accessToken, body);
        console.log(`  updated  ${row.id} → ${existing.id}`);
        updated++;
      } else {
        const ev = await gcalRequest('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, accessToken, body);
        console.log(`  created  ${row.id} → ${ev.id}`);
        created++;
      }
    } catch (err) {
      console.error(`  error    ${row.id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n[stack-sync-gcal] Done — ${created} created, ${updated} updated, ${errors} error(s).`);
  if (errors) process.exit(1);
}

main();
