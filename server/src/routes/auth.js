// POST /api/auth/login — the tokenless door: a correct access PIN mints a
// device token that the bearer gate accepts like API_TOKEN. Mounted OPEN
// (before requireToken), so it carries its own brakes: PIN sign-in 403s until
// a PIN is set in Settings, and failures rate-limit per IP.

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { q } from '../db.js';
import { readSettings } from '../settings.js';
import { verifyPin, sha256 } from '../auth.js';

export const auth = Router();

// Parse a friendly "Browser · Platform" label from a raw user-agent string.
// Falls back to the raw string (truncated) so old tokens with raw UA labels
// still display something sensible in the device list.
export function friendlyLabel(rawUA) {
  if (!rawUA) return null;
  const ua = String(rawUA).trim();

  // Browser detection — order matters: more specific first.
  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) browser = 'Chrome';
  else if (/Chromium\//.test(ua)) browser = 'Chromium';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari';

  // OS/platform detection.
  let platform = '';
  if (/iPhone/.test(ua)) platform = 'iPhone';
  else if (/iPad/.test(ua)) platform = 'iPad';
  else if (/Android/.test(ua)) platform = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) platform = 'Mac';
  else if (/Windows/.test(ua)) platform = 'Windows';
  else if (/Linux/.test(ua)) platform = 'Linux';

  if (browser && platform) return `${browser} · ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  // Raw UA, truncated to fit comfortably in the label column.
  return ua.slice(0, 60);
}

// 5 failed PINs per IP → 15-minute lockout. In-memory is right-sized: one
// user, one server process; a restart forgiving the count is acceptable.
const strikes = new Map();
const LIMIT = 5;
const LOCK_MS = 15 * 60_000;

auth.post('/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const s = strikes.get(ip);
  if (s && s.count >= LIMIT && Date.now() < s.until) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
  }

  const pin = String(req.body?.pin || '');
  // The client sends the raw navigator.userAgent; convert it to a friendly
  // "Browser · Platform" label so the device list is human-readable.
  const rawLabel = String(req.body?.label || '').slice(0, 512);
  const label = friendlyLabel(rawLabel);
  const settings = await readSettings();
  if (!settings.access_pin_hash) {
    return res.status(403).json({ error: 'PIN sign-in is not enabled — set an access PIN in Settings first.' });
  }
  if (!pin || !verifyPin(pin, settings.access_pin_hash)) {
    strikes.set(ip, { count: (s?.count || 0) + 1, until: Date.now() + LOCK_MS });
    return res.status(401).json({ error: 'Wrong PIN.' });
  }

  strikes.delete(ip);
  const token = randomBytes(32).toString('base64url');
  await q('INSERT INTO auth_tokens (token_hash, label) VALUES ($1, $2)', [sha256(token), label]);
  res.json({ token });
});
