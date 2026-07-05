// Server-side Gemini helper — the in-app half of Stack's one sanctioned
// external-AI exception (the CLI review script is the other). Reads
// GEMINI_API_KEY / GEMINI_MODEL from the server environment; when the key is
// absent every Gemini-backed route reports itself unavailable rather than
// erroring. The key is never logged and never appears in any response.
//
// Design rule for every caller: Gemini PROPOSES, the human DISPOSES — return
// suggestions for the UI to offer, never write model output into state.

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Default temperature is env-tunable (GEMINI_TEMPERATURE); callers can still
// override any generationConfig field per call via opts.generation.
const defaultTemperature = () => {
  const t = parseFloat(process.env.GEMINI_TEMPERATURE || '');
  return Number.isFinite(t) ? t : 0.2;
};

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

// One bounded generateContent call, JSON-mode. Returns the parsed object or
// throws with a short, key-free message.
export async function askGemini(prompt, { timeoutMs = 25_000, generation = {} } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Gemini is not configured on this server.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL())}:generateContent`,
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
    if (!res.ok) throw new Error(`Gemini API error (${res.status}).`);
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
