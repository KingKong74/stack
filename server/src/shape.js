// Row -> client shape mappers. The frontend types (web/src/types.ts) are the
// contract; these keep every route returning the same shapes so store.ts stays
// a thin mapping layer.

import { relativeTime } from './util.js';

export function bugShape(row) {
  return {
    id: row.bug_key,
    title: row.title,
    severity: row.severity,
    status: row.status,
    meta: `reported ${relativeTime(row.created_at) || 'recently'}`,
    linkRef: row.link_ref || null,
    source: row.source, // 'hook' | 'manual' — drives the "auto" cue
  };
}

export function roadmapItemShape(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note || '',
    done: row.done,
    bucket: row.bucket,
    source: row.source,
  };
}

// Group flat roadmap rows (already ordered by bucket, position) into the
// MoSCoW shape the UI renders.
export function groupRoadmap(rows) {
  const out = { must: [], should: [], could: [], wont: [] };
  for (const r of rows) {
    if (out[r.bucket]) out[r.bucket].push(roadmapItemShape(r));
  }
  return out;
}

export function futureShape(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note || '',
    when: relativeTime(row.created_at) || 'just now',
    source: row.source,
  };
}

export function noteShape(row) {
  return {
    id: row.id,
    text: row.text,
    colour: row.colour,
    when: relativeTime(row.created_at) || 'just now',
    source: row.source,
  };
}

// A session row mapped to the activity-feed shape: hash, branch, summary, tags,
// relative time. The hash is the commit the push landed on, so a bug's linkRef
// (also the commit) matches an activity row's hash and the chip resolves.
export function activityShape(row) {
  return {
    hash: row.commit_hash || '—',
    branch: row.branch || 'main',
    when: relativeTime(row.created_at) || 'just now',
    summary: row.summary || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
  };
}

// Per-week push count helper input is just a number; metaLine/progress are
// computed by the caller (they need cross-table data).
export function projectListShape(p, { progress, metaLine, pushesThisWeek }) {
  return {
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle || '',
    tint: p.tint || null,
    status: p.status,
    progress,
    metaLine,
    pinned: p.pinned,
    siteUrl: p.site_url || '',
    repo: p.repo || '',
    repoUrl: p.repo_url || '',
    pushesThisWeek,
  };
}

export function projectDetailShape(p, { progress, metaLine, pushesThisWeek, activity, bugs, roadmap, notes, futures, keepResumeCard }) {
  const latest = activity[0];
  return {
    ...projectListShape(p, { progress, metaLine, pushesThisWeek }),
    keepResumeCard: keepResumeCard !== false, // global flag; false hides the resume card
    summary: p.summary || '',
    currentPhase: p.current_phase || '',
    northStar: p.north_star || '',
    inProgress: Array.isArray(p.in_progress) ? p.in_progress : [],
    nextUp: Array.isArray(p.next_up) ? p.next_up : [],
    workingWell: Array.isArray(p.working_well) ? p.working_well : [],
    blockers: Array.isArray(p.blockers) ? p.blockers : [],
    directives: Array.isArray(p.directives) ? p.directives : [],
    ref: latest ? latest.hash : '',
    when: latest ? latest.when : relativeTime(p.last_session_at) || '',
    activity,
    bugs,
    roadmap,
    notes,
    futures: futures || [],
  };
}
