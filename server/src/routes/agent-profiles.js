import { Router } from 'express';
import { q } from '../db.js';
import { KNOWN_TOOLS, normaliseProfile, mergeProfiles } from '../agent-profiles.js';

// The agent spawn-and-customisation surface — app-wide, no slug (a profile is
// a spawn-time choice, not a per-project one). Mounted at /api/agent-profiles. Reads
// and writes go through agents.js's pure engine: this file's only job is
// storage and the client shape.
//
// Two invariants:
//  - The `agent_profiles` table holds ONLY customisations. The two built-in
//    profiles ('executor', 'reviewer') live in code and are merged in at read
//    time by mergeProfiles(); a row here only exists once someone actually
//    overrides a builtin or adds a new profile.
//  - A builtin can never be DELETED, only RESET. The spawn path
//    (resolveSpawn) depends on 'executor' existing, so DELETE on a builtin
//    key drops its stored override, if any, and hands back the factory
//    profile rather than leaving nothing to spawn.
export const agentProfiles = Router();

// DB row -> the client/engine shape mergeProfiles() expects. `tools` comes
// back from pg already parsed (jsonb), but stay null-safe anyway.
function rowToProfile(row) {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    model: row.model,
    tools: row.tools || [],
    enabled: row.enabled,
  };
}

async function loadStored() {
  const { rows } = await q('SELECT * FROM agent_profiles ORDER BY key');
  return rows.map(rowToProfile);
}

// Upserts one normalised profile by key and returns the merged (builtin-aware)
// shape POST/PATCH hand back.
async function upsert(profile) {
  await q(
    `INSERT INTO agent_profiles (key, name, description, prompt, model, tools, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (key) DO UPDATE SET
       name = $2, description = $3, prompt = $4, model = $5, tools = $6, enabled = $7, updated_at = now()`,
    [profile.key, profile.name, profile.description, profile.prompt, profile.model, JSON.stringify(profile.tools), profile.enabled]
  );
  const stored = await loadStored();
  return mergeProfiles(stored).find((p) => p.key === profile.key);
}

// GET / -> the two builtins merged with any stored overrides.
agentProfiles.get('/', async (_req, res) => {
  const stored = await loadStored();
  res.json({ profiles: mergeProfiles(stored), knownTools: KNOWN_TOOLS });
});

// POST / -> create or fully replace a profile by key.
agentProfiles.post('/', async (req, res) => {
  let profile;
  try {
    profile = normaliseProfile(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const merged = await upsert(profile);
  res.status(201).json(merged);
});

// PATCH /:key -> partial update over the CURRENT effective profile (stored
// override if any, else the builtin with that key). This is what makes a
// builtin customisable: patching 'executor' writes its first row.
agentProfiles.patch('/:key', async (req, res) => {
  const key = String(req.params.key || '').trim().toLowerCase();
  const stored = await loadStored();
  const current = mergeProfiles(stored).find((p) => p.key === key);
  if (!current) return res.status(404).json({ error: `no such agent profile "${key}"` });

  let profile;
  try {
    profile = normaliseProfile({ ...current, ...req.body, key });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const merged = await upsert(profile);
  res.json(merged);
});

// DELETE /:key -> a custom profile is removed outright; a builtin's stored
// override is dropped and the factory profile comes back instead, because the
// spawn path always needs 'executor' to exist.
agentProfiles.delete('/:key', async (req, res) => {
  const key = String(req.params.key || '').trim().toLowerCase();
  const stored = await loadStored();
  const current = mergeProfiles(stored).find((p) => p.key === key);
  if (!current) return res.status(404).json({ error: `no such agent profile "${key}"` });

  await q('DELETE FROM agent_profiles WHERE key = $1', [key]);
  if (current.builtin) {
    const remaining = await loadStored();
    const reset = mergeProfiles(remaining).find((p) => p.key === key);
    return res.status(200).json(reset);
  }
  res.status(204).send();
});
