// Risk-tier helpers — shared by stack-autopilot.mjs and stack-risk-backfill.mjs
// (#212 the tiers themselves, #262 deriving one at plan time).

export const RISK_TIERS = ['low', 'normal', 'high'];

// #262 — a derived tier is only worth having if it is trustworthy, so anything
// the model didn't say clearly becomes 'normal': the tier that changes nothing.
// Never widen this to guess at a near-miss — 'lowish' meaning low is exactly the
// guess that would auto-merge something nobody tiered.
export function cleanRiskTier(v) {
  const t = String(v || '').trim().toLowerCase();
  return RISK_TIERS.includes(t) ? t : 'normal';
}

// The reason, trimmed to one storable line ('' when there is none).
export function cleanRiskReason(v) {
  return String(v || '').replace(/\s*\n+\s*/g, ' ').trim().slice(0, 300);
}

// "normal" or "normal — because …" — the reason clause disappears when empty,
// so a tier with no prose never renders a dangling dash.
export function riskLabel(risk, reason) {
  return reason ? `${risk} — ${reason}` : risk;
}
