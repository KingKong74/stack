// The agent spawn-and-customisation engine — pure core, no database and no
// side effects. Today the only subagent Stack ever spawns is hardcoded in
// scripts/stack-autopilot.mjs (see executorAgent() there): one profile, one
// shape, JSON-stringified straight into `claude --agents`. This module
// generalises that into a small catalogue of named PROFILES a spawn can pick
// from, while keeping the executor's exact wording as the built-in default —
// nothing that already works changes shape.
//
// Kept dependency-free on purpose: unit 2 (the routes) and unit 3 (the
// runner) both need to reuse this logic without dragging Postgres into a
// pure test, and server/test/agent-profiles.test.mjs asserts against this
// file directly.
//
// The one invariant worth stating up front: a spawn always gets at least one
// building agent (see resolveSpawn below). Everything else here exists to
// serve that without ever landing on zero.

// The tools a profile may be granted. A profile's `tools` array is validated
// against this list by name, never against an open string.
export const KNOWN_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch']);

// The building set the executor profile — and the default for any profile
// that does not name its own tools — gets. Matches the full write access the
// old hardcoded executorAgent() always granted.
const BUILDING_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);

// Two starter profiles, shipped so a fresh install has something to spawn.
// `model: ''` means "inherit the spawn's executor model" — resolved at
// compose time, never baked in here, so a global model change moves every
// profile that has not opted out of it.
export const BUILTIN_PROFILES = Object.freeze([
  {
    key: 'executor',
    name: 'Executor',
    // Copied verbatim from executorAgent() in scripts/stack-autopilot.mjs —
    // do not reword either string without updating that file too.
    description: 'The executor — a cheaper model that does the building. Delegate each commit-sized unit of work to it with the exact files, the intended change and how to verify.',
    prompt: 'You are the executor working under a director model on one unit of work in a git worktree. '
      + 'Do exactly what you are asked and nothing more: no refactors nobody asked for, no scope you were not given. '
      + 'Read what you need, make the change, run whatever verifies it, and report back BRIEFLY — what you changed, '
      + 'what you verified, and anything you could not do. Do not commit; the director commits. '
      + 'If the instruction is ambiguous or wrong, say so in your report instead of guessing.',
    model: '',
    tools: [...BUILDING_TOOLS],
    builtin: true,
    enabled: true,
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    description: 'The reviewer — reads the change and reports what is wrong with specifics. It never writes: no Edit or Write tool, so nothing it says can land without a human or the executor acting on it.',
    prompt: 'You are the reviewer reading one change in a git worktree. '
      + 'Read the diff and the files it touches, check it against what it claims to do, and report back BRIEFLY — '
      + 'what is wrong, with the specific file and line, and what is missing. Do not fix anything and do not edit any '
      + 'file; you have no write access and nothing you say should assume you used it. '
      + 'If the change looks right, say so plainly rather than inventing a finding.',
    model: '',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    builtin: true,
    enabled: true,
  },
]);

const KEY_RE = /^[a-z][a-z0-9-]{1,39}$/;

// Validates and normalises one profile. Throws a plain-sentence Error on any
// rejection — those messages become HTTP 400 bodies in the routes unit, so
// they have to read as something a human can act on, not a code.
export function normaliseProfile(input) {
  const src = input && typeof input === 'object' ? input : {};

  const rawKey = typeof src.key === 'string' ? src.key.trim().toLowerCase() : '';
  if (!KEY_RE.test(rawKey)) {
    throw new Error('a profile key must start with a letter and contain only lowercase letters, digits and hyphens, 2-40 characters long');
  }

  const name = typeof src.name === 'string' && src.name.trim() ? src.name.trim() : rawKey;
  const description = typeof src.description === 'string' ? src.description.trim() : '';

  const prompt = typeof src.prompt === 'string' ? src.prompt.trim() : '';
  if (!prompt) {
    throw new Error('a profile needs a prompt — an agent with no prompt is not a customisation, it is a blank');
  }

  const model = typeof src.model === 'string' ? src.model.trim() : '';

  let tools;
  if (src.tools === undefined) {
    tools = [...BUILDING_TOOLS];
  } else {
    if (!Array.isArray(src.tools) || src.tools.length === 0) {
      throw new Error('a profile needs at least one tool — an empty tools array can do nothing and is a silent no-op, not a customisation');
    }
    for (const t of src.tools) {
      if (!KNOWN_TOOLS.includes(t)) {
        throw new Error(`unknown tool "${t}" — known tools are ${KNOWN_TOOLS.join(', ')}`);
      }
    }
    // Dedupe, preserving KNOWN_TOOLS order rather than input order.
    const requested = new Set(src.tools);
    tools = KNOWN_TOOLS.filter((t) => requested.has(t));
  }

  const enabled = typeof src.enabled === 'boolean' ? src.enabled : true;

  return { key: rawKey, name, description, prompt, model, tools, enabled };
}

// Builds the object Claude Code's `--agents` flag takes:
// { [key]: { description, prompt, model, tools } }
export function composeAgents(profiles, { executorModel = '' } = {}) {
  const out = {};
  if (!Array.isArray(profiles)) return out;
  for (const p of profiles) {
    if (!p || p.enabled === false) continue;
    const model = (p.model && p.model.trim()) || (executorModel && executorModel.trim()) || undefined;
    out[p.key] = {
      description: p.description || '',
      prompt: p.prompt,
      model,
      tools: p.tools || [],
    };
  }
  return out;
}

// Decides which profiles ONE spawn gets, and composes them.
//
// THE INVARIANT: a spawn always gets at least one building agent. If nothing
// survives filtering — no profiles supplied at all (an unreachable API),
// every one disabled, or a requested key that does not exist — this falls
// back to the built-in executor profile and says so. A spawn with no
// executor subagent does not fail loudly; it silently makes the expensive
// director model do all the building itself, which is the most expensive
// arrangement there is. Failing to an executor is the fail-safe direction
// here, matching the rest of Stack's fail-safe/fail-open split.
export function resolveSpawn({ profiles, requested, executorModel = '' } = {}) {
  const pool = Array.isArray(profiles) ? profiles.filter((p) => p && p.enabled !== false) : [];
  const byKey = new Map(pool.map((p) => [p.key, p]));

  const requestedKeys = Array.isArray(requested) ? requested : requested ? [requested] : [];
  const validRequested = requestedKeys.filter((k) => byKey.has(k));

  let chosen = [];
  let reason = '';

  if (validRequested.length > 0) {
    // The resolved set is the requested profile(s) plus the executor profile
    // from the pool if present — the director always needs a builder.
    const seen = new Set();
    for (const k of validRequested) {
      if (!seen.has(k)) { chosen.push(byKey.get(k)); seen.add(k); }
    }
    const executorInPool = byKey.get('executor');
    if (executorInPool && !seen.has('executor')) {
      chosen.push(executorInPool);
      seen.add('executor');
    }
    const label = validRequested.map((k) => `"${k}"`).join(', ');
    reason = executorInPool && !validRequested.includes('executor')
      ? `requested profile ${label} plus executor`
      : `requested profile ${label}`;
  } else if (requestedKeys.length === 0 && byKey.has('executor')) {
    // No request at all — the ordinary case for most spawns. Default to the
    // executor alone rather than every enabled profile, so a custom profile
    // (a reviewer, say) only ever spawns when something actually asks for it.
    chosen = [byKey.get('executor')];
    reason = 'no profile requested — using the executor';
  }

  let fallback = false;
  if (chosen.length === 0) {
    chosen = [BUILTIN_PROFILES.find((p) => p.key === 'executor')];
    fallback = true;
    if (!Array.isArray(profiles) || profiles.length === 0) {
      reason = 'no profiles available — falling back to the built-in executor';
    } else if (requestedKeys.length > 0) {
      reason = `requested profile "${requestedKeys.join(', ')}" not found — falling back to the built-in executor`;
    } else if (pool.length === 0) {
      reason = 'every profile is disabled — falling back to the built-in executor';
    } else {
      reason = 'no executor profile available — falling back to the built-in executor';
    }
  }

  const agents = composeAgents(chosen, { executorModel });
  const keys = chosen.map((p) => p.key).sort();
  return { agents, keys, fallback, reason };
}

// Merges stored/custom profiles over BUILTIN_PROFILES by key. A stored
// profile with a builtin's key overrides that builtin's fields but keeps
// `builtin: true`, so the route can refuse to delete it and reset it instead;
// a stored profile with a new key stays `builtin: false`. Never mutates its
// input. Sorted by key.
export function mergeProfiles(stored) {
  const byKey = new Map(BUILTIN_PROFILES.map((p) => [p.key, { ...p }]));
  if (Array.isArray(stored)) {
    for (const s of stored) {
      if (!s || !s.key) continue;
      const isBuiltin = byKey.has(s.key);
      byKey.set(s.key, { ...s, builtin: isBuiltin });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
