import { Router } from 'express';
import { q } from '../db.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';
import { PRESENCE_TTL_MINUTES } from '../util.js';

// POST /api/triage — cross-project inbox triage assist (#76).
//
// Gathers the current review inbox (same query as overview's review block, but
// uncapped up to 40 items), asks Gemini for:
//   • clusters  — groups of near-duplicate items (by kind:slug:id ref)
//   • severityFlags — bugs whose severity looks wrong, with a suggested value
//   • suggestions — keep/dismiss lean per item with a one-line reason
//
// Returns annotations keyed by ref (kind:slug:id). NEVER writes state —
// Gemini annotates, the human disposes through the existing Keep/Dismiss
// handlers. 503 when GEMINI_API_KEY is absent.

export const triage = Router();

const TRIAGE_CAP = 40;

triage.post('/', async (_req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }

  // Same query as the overview's review block; we join projects to get the slug.
  // Soft-deleted projects are excluded via the JOIN.
  const { rows } = await q(`
    SELECT 'bug'     AS kind, p.slug, p.id AS project_id, b.bug_key AS ref,
           b.title, b.severity AS meta, b.created_at
      FROM bugs b JOIN projects p ON p.id = b.project_id AND p.deleted_at IS NULL
     WHERE b.source = 'hook' AND b.reviewed_at IS NULL
    UNION ALL
    SELECT 'roadmap', p.slug, p.id, r.id::text,
           r.title, r.bucket, r.created_at
      FROM roadmap_items r JOIN projects p ON p.id = r.project_id AND p.deleted_at IS NULL
     WHERE r.source = 'hook' AND r.reviewed_at IS NULL AND NOT r.done
    UNION ALL
    SELECT 'future',  p.slug, p.id, f.id::text,
           f.title, 'idea', f.created_at
      FROM futures f JOIN projects p ON p.id = f.project_id AND p.deleted_at IS NULL
     WHERE f.source = 'hook' AND f.reviewed_at IS NULL
    ORDER BY created_at DESC
    LIMIT $1
  `, [TRIAGE_CAP]);

  if (rows.length === 0) {
    return res.json({ clusters: [], severityFlags: [], suggestions: [], annotations: {} });
  }

  // Format the item list for Gemini. Ref format: kind:slug:id
  const itemLines = rows.map((r) =>
    `${r.kind}:${r.slug}:${r.ref} | ${r.kind} | ${r.slug} | ${r.title} | ${r.meta}`
  ).join('\n');

  const prompt = buildPrompt('triage', { ITEMS: itemLines });

  try {
    const answer = await askGemini(prompt, { timeoutMs: 35_000 });

    // Normalise — Gemini might omit arrays; treat missing as empty.
    const clusters = Array.isArray(answer?.clusters) ? answer.clusters : [];
    const severityFlags = Array.isArray(answer?.severityFlags) ? answer.severityFlags : [];
    const suggestions = Array.isArray(answer?.suggestions) ? answer.suggestions : [];

    // Build a flat annotations map keyed by ref for the client.
    // Each ref can carry: clusterLabel, currentSeverity, suggestedSeverity, severityReason,
    // action ('keep'|'dismiss'), reason.
    const annotations = {};

    for (const sug of suggestions) {
      const ref = String(sug?.ref || '').trim();
      if (!ref) continue;
      annotations[ref] = {
        ...annotations[ref],
        action: sug.action === 'keep' || sug.action === 'dismiss' ? sug.action : null,
        reason: String(sug.reason || '').slice(0, 120),
      };
    }

    for (const flag of severityFlags) {
      const ref = String(flag?.ref || '').trim();
      if (!ref) continue;
      annotations[ref] = {
        ...annotations[ref],
        currentSeverity: String(flag.current || ''),
        suggestedSeverity: String(flag.suggested || ''),
        severityReason: String(flag.reason || '').slice(0, 120),
      };
    }

    // Map each cluster item to its label.
    for (const cluster of clusters) {
      const label = String(cluster?.label || '').slice(0, 80);
      for (const ref of Array.isArray(cluster?.refs) ? cluster.refs : []) {
        const r = String(ref || '').trim();
        if (!r) continue;
        // A ref may appear in multiple clusters (unusual); comma-join the labels.
        annotations[r] = {
          ...annotations[r],
          clusterLabel: annotations[r]?.clusterLabel
            ? `${annotations[r].clusterLabel}; ${label}` : label,
        };
      }
    }

    res.json({ clusters, severityFlags, suggestions, annotations });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});
