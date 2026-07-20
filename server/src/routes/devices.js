// GET /api/auth/devices  — list all auth_tokens (PIN-issued device tokens).
// DELETE /api/auth/devices/:id — revoke one token by its row id.
//
// Behind requireToken so only someone already authenticated can see or revoke
// devices. The presented bearer is used to mark `current: true` on the row
// that matches the caller's own token — compare sha256 only, never emit hashes.
//
// The API_TOKEN bearer has no row in auth_tokens (it's an env var), so current
// is false for any API_TOKEN-authed caller — that's correct.

import { Router } from 'express';
import { q } from '../db.js';
import { sha256 } from '../auth.js';
import { relativeTime } from '../util.js';

export const devices = Router();

// Extract the raw bearer from the request (already validated by requireToken).
function bearerFrom(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// Row → client shape. Never emit token_hash.
function deviceShape(row, callerHash) {
  return {
    id: row.id,
    label: row.label || null,
    lastUsed: relativeTime(row.last_used_at),
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    current: row.token_hash === callerHash,
  };
}

// GET /api/auth/devices
devices.get('/', async (req, res) => {
  const { rows } = await q(
    'SELECT id, token_hash, label, created_at, last_used_at FROM auth_tokens ORDER BY COALESCE(last_used_at, created_at) DESC'
  );
  const callerHash = sha256(bearerFrom(req));
  res.json(rows.map((r) => deviceShape(r, callerHash)));
});

// DELETE /api/auth/devices/:id
devices.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid device id.' });
  const { rowCount } = await q('DELETE FROM auth_tokens WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Device not found.' });
  res.status(204).end();
});
