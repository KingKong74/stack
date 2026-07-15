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
  const label = String(req.body?.label || '').slice(0, 120) || null;
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
