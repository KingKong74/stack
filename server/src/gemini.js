// Server-side Gemini helper — the in-app half of Stack's one sanctioned
// external-AI exception (the CLI review script is the other). Reads
// GEMINI_API_KEY / GEMINI_MODEL from the server environment; when the key is
// absent every Gemini-backed route reports itself unavailable rather than
// erroring. The key is never logged and never appears in any response.
//
// Design rule for every caller: Gemini PROPOSES, the human DISPOSES — return
// suggestions for the UI to offer, never write model output into state.

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Free-tier quotas are PER MODEL (and small — 20/day on 2.5-flash as of
// mid-2026), so when the primary model is exhausted one retry against a
// different model usually keeps every ✧ surface alive. '' disables.
// The -latest alias, not a pinned version: Google retires old lite models for
// new users (gemini-2.5-flash-lite started 404ing), the alias tracks whatever
// is current.
const FALLBACK_MODEL = () =>
  process.env.GEMINI_FALLBACK_MODEL !== undefined
    ? process.env.GEMINI_FALLBACK_MODEL
    : 'gemini-flash-lite-latest';

// Default temperature is env-tunable (GEMINI_TEMPERATURE); callers can still
// override any generationConfig field per call via opts.generation.
const defaultTemperature = () => {
  const t = parseFloat(process.env.GEMINI_TEMPERATURE || '');
  return Number.isFinite(t) ? t : 0.2;
};

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

// The UI catalogue of Gemini models — the SINGLE source of truth for what may
// be offered, the same role EXECUTOR_CATALOGUE plays for the autopilot's model
// pickers in settings.js. '' = the server default. The Workbench's picker was
// its last reader and went with the canvas; the catalogue stays because
// `cleanModelAlias` is validated against the same idea of what a model id is,
// and re-deriving this list is the expensive part.
export const GEMINI_MODELS = [
  { model: '', label: 'Server default', note: 'whatever the server is configured with' },
  { model: 'gemini-2.5-pro', label: 'Pro', note: 'deepest read, smallest free quota' },
  { model: 'gemini-2.5-flash', label: 'Flash', note: 'balanced — the usual default' },
  { model: 'gemini-flash-latest', label: 'Flash (latest)', note: 'tracks the current flash release' },
  { model: 'gemini-flash-lite-latest', label: 'Lite', note: 'fastest, biggest free quota' },
];

// One bounded generateContent call against one model, JSON-mode. Throws with
// a short, key-free message; a 429 gets `quota = true` so the caller can try
// another model.
async function callModel(model, prompt, { timeoutMs, generation }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Gemini is not configured on this server.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: defaultTemperature(), ...generation },
        }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) {
      const err = new Error(`Gemini API error (${res.status}).`);
      if (res.status === 429) err.quota = true;
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Gemini returned a non-JSON answer.');
    }
  } catch (err) {
    throw err.name === 'AbortError' ? new Error('Gemini timed out.') : err;
  } finally {
    clearTimeout(timer);
  }
}

// The call every route makes. Tries the primary model; when its free-tier
// quota is exhausted, retries once on the fallback model (quotas are per
// model). Both exhausted → a 503-tagged error with a message worth showing
// (502 would be swallowed by Cloudflare in front of the deployment).
// `model` pins this one call to a model other than the server's. Two callers
// arrived at it independently: the tab agents (#361), since free-tier quotas
// are per model and one agent should not be able to eat another's, and the
// Workbench's own picker (#327, culled). '' or absent = the server's
// GEMINI_MODEL.
// Everything else about the fallback dance below is unchanged either way.
export async function askGemini(prompt, { timeoutMs = 25_000, generation = {}, model = '' } = {}) {
  const primary = model || MODEL();
  try {
    return await callModel(primary, prompt, { timeoutMs, generation });
  } catch (err) {
    if (!err.quota) throw err;
    const fallback = FALLBACK_MODEL();
    // Compare against the PRIMARY actually used, not MODEL() — otherwise an
    // override that picked the lite model (or the lite model itself as the
    // fallback) would retry itself and never actually fall back.
    if (!fallback || fallback === primary) throw quotaError();
    try {
      return await callModel(fallback, prompt, { timeoutMs, generation });
    } catch (err2) {
      // The primary's quota is the root cause whatever the fallback did —
      // surface that as the 503 rather than an opaque fallback error.
      throw quotaError(err2.quota ? '' : ` (the fallback also failed: ${err2.message})`);
    }
  }
}

// Quota errors travel as 503 (`httpStatus`) so the message survives the proxy
// chain — Cloudflare swallows origin 502 bodies. Other upstream failures keep
// the 502 the routes already send.
const quotaError = (detail = '') => {
  const err = new Error(
    `Gemini's free-tier quota is used up for now (it resets daily) — try again later.${detail}`
  );
  err.quota = true;
  err.httpStatus = 503;
  return err;
};
