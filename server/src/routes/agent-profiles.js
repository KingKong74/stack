import { Router } from 'express';
import { q } from '../db.js';
import { KNOWN_TOOLS, normaliseProfile, mergeProfiles, resolveSpawn } from '../agent-profiles.js';
import { readSettings } from '../settings.js';

// THE AGENTS SURFACE — app-wide, no slug (a profile is a spawn-time choice, not
// a per-project one). Mounted at /api/agent-profiles, read by Mission Control's
// Agents room. Reads and writes go through agent-profiles.js's pure engine:
// this file's only job is storage, the frame, and the client shape.
//
// IT IS THE ONLY AGENTS SURFACE SINCE #520. There was a second one — the
// tab-agent REGISTRY on /api/agents (#361), named agents.js, which two branches
// coined the same word for — and Mission Control's Agents tab used to draw
// THAT. The registry is culled and this took the tab. The paths are unchanged
// on purpose: see index.js's mount.
//
// WHAT THE ROOM NEEDS BEYOND THE CATALOGUE, and why each is here rather than
// composed in the browser:
//
//   • THE POLICY FRAME. A profile's `model: ''` inherits the spawn's EXECUTOR
//     model, so the catalogue cannot be read without it. Worse, and this is the
//     one a screen must say out loud: `--agents` is only passed when an ADVISOR
//     is set (scripts/stack-autopilot.mjs). With no advisor the runner still
//     calls resolveSpawn and then throws the answer away — every profile on
//     this screen is inert, and a room that drew switches over that would be
//     lying in the most expensive direction there is.
//   • THE SPAWN PREVIEW. resolveSpawn already answers "what does a run with no
//     requested profile actually get", including its own `reason` when it falls
//     back. The room shows the RESOLVED spawn rather than the catalogue,
//     because a catalogue of profiles nothing requests is this feature's
//     failure mode and the only way to see it is to resolve one.
//   • THE USE COUNT. How many open items would spawn each profile. The
//     executor's takes `agent_profile = ''` as well as its own key, because an
//     item naming no profile spawns the executor — counting only the explicit
//     assignments reports Stack's busiest subagent as its least used. No other
//     profile may claim the blanks. (routes/context.js counts the same way for
//     the same reason; the two queries are twins and neither can import the
//     other's handler.)
//
// Two storage invariants:
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

// GET / -> the builtins merged with any stored overrides, plus the frame the
// room cannot render honestly without (see the header).
agentProfiles.get('/', async (_req, res) => {
  const [stored, settings, useRows] = await Promise.all([
    loadStored(),
    readSettings(),
    q(
      `SELECT COALESCE(NULLIF(r.agent_profile, ''), 'executor') AS key, count(*)::int AS n
         FROM roadmap_items r JOIN projects p ON p.id = r.project_id
        WHERE p.deleted_at IS NULL AND NOT r.done AND NOT r.archived
        GROUP BY 1`
    ).then((r) => r.rows).catch(() => []),
  ]);
  const profiles = mergeProfiles(stored);
  const executorModel = settings.autopilot_executor_model || '';
  const advisorModel = settings.autopilot_advisor_model || '';
  // Exactly what a night with no requested profile resolves to. `requested` is
  // left unset on purpose: that is the ordinary case and the one worth showing.
  const spawn = resolveSpawn({ profiles, executorModel });
  res.json({
    profiles,
    knownTools: KNOWN_TOOLS,
    usage: Object.fromEntries(useRows.map((r) => [r.key, r.n])),
    policy: {
      executorModel,
      advisorModel,
      // THE FRAME, as one boolean the room can hang a warning on. False means
      // no profile on this screen ever spawns — see the header.
      spawnsAgents: Boolean(advisorModel),
    },
    defaultSpawn: { keys: spawn.keys, fallback: spawn.fallback, reason: spawn.reason },
  });
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
