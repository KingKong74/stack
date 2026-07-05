import { q } from './db.js';

// Resolve a project row by slug for the per-project collection routers.
// Soft-deleted projects resolve to null (their collections 404 while deleted).
// Returns the row or null.
export async function projectBySlug(slug) {
  const { rows } = await q('SELECT * FROM projects WHERE slug = $1 AND deleted_at IS NULL', [slug]);
  return rows[0] || null;
}
