// The refine note's edit rules (#319), kept pure so the roadmap card's inline
// editor can be tested without a DOM. `normaliseRefine` deliberately mirrors
// what the server does to `refine_note` in server/src/routes/roadmap.js
// (trim, cap at REFINE_MAX, '' becomes NULL) — the client has to reshape a
// draft the same way the server will, or a save that round-trips through the
// server's own normalisation reads back as still-dirty.

export const REFINE_MAX = 2000;

export function normaliseRefine(text: string): string {
  return String(text || '').trim().slice(0, REFINE_MAX);
}

// Compares NORMALISED forms. A draft that differs from the original only in
// trailing whitespace, or only past the 2000-char cap, is NOT dirty — the
// server would reshape it to the same value, so treating it as a change would
// leave the card looking permanently unsaved (Save always enabled, never
// settling back to clean).
export function refineDirty(original: string, draft: string): boolean {
  return normaliseRefine(original) !== normaliseRefine(draft);
}

export type RefineSave = { kind: 'save'; text: string } | { kind: 'clear' } | { kind: 'none' };

export function planRefineSave(original: string, draft: string): RefineSave {
  if (!refineDirty(original, draft)) return { kind: 'none' };
  const normDraft = normaliseRefine(draft);
  if (normDraft === '' && normaliseRefine(original) !== '') return { kind: 'clear' };
  return { kind: 'save', text: normDraft };
}
