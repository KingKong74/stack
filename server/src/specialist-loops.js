// Observation-only eligibility, before the existing queue claim gates. Creating
// a policy never arms it. An unknown spend/host state is a hold, never zero.
export const LOOP_RESERVE_TOKENS = 60000;
export function loopUsage(jobs) {
  let spent = 0, attempts = 0, unknown = false, active = false;
  for (const j of jobs) {
    attempts++;
    if (['queued', 'claimed', 'running'].includes(j.status)) { active = true; spent += LOOP_RESERVE_TOKENS; continue; }
    let result; try { result = JSON.parse(j.advice || 'null'); } catch { /* unknown */ }
    if (result?.skipped) continue;
    const u = result?.usage;
    if (!u || !['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(k => typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0) || !Object.keys(u).length) { unknown = true; continue; }
    spent += ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((n, k) => n + Number(u[k] || 0), 0);
  }
  return { attempts, spent: unknown ? null : spent, active };
}
export function specialistLoopHold(policy, { head, connected, globalHold = '', usage, now = Date.now(), manualProof = false, failures = 0 } = {}) {
  if (!policy.enabled) return 'disabled';
  if (globalHold) return globalHold;
  if (!connected) return 'host availability is unknown';
  if (!manualProof) return 'a successful manual diagnostic is required';
  if (!/^[a-f0-9]{40}$/.test(head || '')) return 'host revision is unknown';
  if (policy.last_head === head) return 'no new commit since the last pass';
  if (usage?.active) return 'a previous diagnostic is still queued or running';
  if (failures >= 3) return 'three recent failures; inspect the evidence before resuming';
  if (policy.last_trigger_at && now - Date.parse(policy.last_trigger_at) < Number(policy.interval_minutes) * 60000) return 'cooldown';
  if (!usage || usage.spent === null) return 'diagnostic usage is unknown';
  if (usage.attempts >= policy.max_runs_day) return 'daily run cap reached';
  if (usage.spent + LOOP_RESERVE_TOKENS > policy.max_tokens_day) return 'daily token budget has no room for the next pass reservation';
  return '';
}
