// Observed profile activity only: assignments and supplied profiles are not invocations.
// Session timestamps date the recorded session, not each individual delegation.
export const UTILISATION_SQL = `
WITH activity AS (
  SELECT a.key, p.slug, s.created_at AS at, CASE WHEN a.value ~ '^[0-9]{1,9}$' THEN a.value::bigint ELSE 0 END AS calls,
         0 AS diagnostics, 0 AS completed, 0 AS failed
    FROM sessions s JOIN projects p ON p.id = s.project_id
    CROSS JOIN LATERAL jsonb_each_text(s.agent_types) a
   WHERE p.deleted_at IS NULL AND s.created_at >= now() - interval '30 days'
     AND CASE WHEN a.value ~ '^[0-9]{1,9}$' THEN a.value::bigint > 0 ELSE false END
  UNION ALL
  SELECT j.specialist_spec->>'profileKey', p.slug, j.started_at, 0,
         1, (j.status = 'done')::int, (j.status = 'failed')::int
    FROM autopilot_jobs j JOIN projects p ON p.id = j.project_id
   WHERE p.deleted_at IS NULL AND j.kind = 'specialist'
     AND j.started_at >= now() - interval '30 days'
)
SELECT key, sum(calls) AS calls, sum(diagnostics) AS diagnostics,
       sum(completed) AS completed, sum(failed) AS failed,
       array_agg(DISTINCT slug ORDER BY slug) AS projects, max(at) AS last_at
  FROM activity WHERE key IS NOT NULL GROUP BY key`;

export function shapeUtilisation(rows) {
  return Object.fromEntries(rows.map(r => [r.key, {
    calls: Number(r.calls), diagnostics: Number(r.diagnostics),
    completed: Number(r.completed), failed: Number(r.failed),
    projects: r.projects, lastAt: r.last_at,
  }]));
}
