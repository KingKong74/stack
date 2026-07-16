// Bearer gate + PIN credentials. Two credential classes pass the gate:
//   • API_TOKEN — the operator's shared token (hooks, CLI, the original path)
//   • an issued device token — minted by POST /api/auth/login after a correct
//     access PIN; only its sha256 is stored (auth_tokens), so a DB leak spills
//     nothing usable. Changing/clearing the PIN deletes every row.
// The tool sits behind Tailscale / Cloudflare in practice, so this is a second
// layer rather than the only one.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { q } from './db.js';

const TOKEN = process.env.API_TOKEN || '';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Constant-time equality via sha256 (normalises length for timingSafeEqual).
const same = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

// PIN at rest: "scrypt$<salt>$<hash>".
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin, stored) {
  try {
    const [scheme, salt, hex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return false;
    const a = scryptSync(pin, salt, 32);
    const b = Buffer.from(hex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// The bare credential check (either class), usable outside express — the
// web-terminal relay validates websocket frames with this.
export async function tokenValid(token) {
  if (!TOKEN || !token) return false;
  if (same(token, TOKEN)) return true;
  try {
    // One statement checks and stamps: a live device token bumps last_used_at.
    const { rows } = await q(
      'UPDATE auth_tokens SET last_used_at = now() WHERE token_hash = $1 RETURNING id',
      [sha256(token)]
    );
    if (rows.length) return true;
  } catch { /* fall through to false */ }
  return false;
}

export async function requireToken(req, res, next) {
  if (!TOKEN) {
    // Fail closed: if the operator forgot to set a token, don't silently run open.
    return res.status(500).json({ error: 'API_TOKEN is not configured on the server.' });
  }
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (await tokenValid(token)) return next();
  return res.status(401).json({ error: 'Invalid or missing token.' });
}
