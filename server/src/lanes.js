// #267 — area-disjoint picking, so parallel workers never collide.
//
// An "area lane" is a product area (roadmap_items.area) that some worker is
// currently building in. Two workers in the same area fight over the same
// files at merge time, so a lane admits one worker.
//
// A lane is scoped to ONE PROJECT, never the bare area string. "ui" in
// project stack and "ui" in some other project are different areas in
// different repos — their files cannot possibly collide, so treating the
// area alone as the key would block a project over a namesake tag in an
// unrelated one. That is the same "valid independent jobs incorrectly
// skipped" hazard the untagged-area exemption below guards against, just one
// axis over — so the key is always the pair (projectId, area).
//
//   - Normalise an area with (a || '').trim().toLowerCase().
//   - An untagged area ('') is NEVER a lane, in any project. It neither
//     occupies a lane nor can be blocked by one. This is deliberate and
//     load-bearing: without it every untagged item collapses into one giant
//     lane and the night deadlocks doing nothing.
//   - An area is OCCUPIED (within its project) when either (a) an open
//     roadmap item in that area carries a non-empty claimed_by — a parallel
//     worker's branch claim, live today whether or not the autopilot put it
//     there — or (b) an in-flight autopilot job (status claimed/running)
//     targets that area, either its own area filter or the area of the
//     roadmap item it is pinned to.
//   - A holder never blocks itself: when asking "may THIS job/item run",
//     ignore the claim it holds on its own pinned item.
//
// Pure, no DB, no imports from the app — callers (routes/autopilot.js,
// routes/control.js) build the `holders` list from their own queries.

export function normArea(a) {
  return (a || '').trim().toLowerCase();
}

// The composite lane key: one project's one area. '' (never a real key) for
// an untagged area, so a caller can test truthiness instead of re-deriving
// the untagged exemption itself.
export function laneKey(projectId, area) {
  const norm = normArea(area);
  return norm ? `${projectId}::${norm}` : '';
}

// holders: array of { projectId, area, by }-ish objects — a branch claim or
// an in-flight job's area target, scoped to the project it lives in.
// Untagged entries never occupy a lane.
export function occupiedAreas(holders) {
  const set = new Set();
  for (const h of holders || []) {
    const key = laneKey(h && h.projectId, h && h.area);
    if (key) set.add(key);
  }
  return set;
}

// Map of lane key (projectId::area) -> the first holder's label, so a caller
// can say WHO holds the lane (e.g. in a skip-reason message).
export function laneHolders(holders) {
  const map = new Map();
  for (const h of holders || []) {
    const key = laneKey(h && h.projectId, h && h.area);
    if (!key) continue;
    if (!map.has(key)) map.set(key, h && h.by);
  }
  return map;
}

// Is `area` held within `projectId`? Always false for an untagged area.
export function areaHeld(projectId, area, occupied) {
  const key = laneKey(projectId, area);
  if (!key) return false;
  return occupied.has(key);
}
