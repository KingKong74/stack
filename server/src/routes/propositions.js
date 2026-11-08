// PROPOSITIONS — proposed packages of work (new milestones, slices and items)
// that sit in the board's Propositions column until the owner decides. Mounted
// at /api/projects/:slug/propositions; the screen is web/src/detail/Propositions.tsx
// and the table's header is in schema.sql.
//
// WHY A TABLE OF ITS OWN, and not artifacts or held roadmap rows: a held row
// is already a roadmap row (homeOf puts it in Auto-ideas, and a sign-off makes
// it runnable), so a proposal made of them would be a second home for the same
// work. An artifact body is Markdown, and the acceptance contract needs nodes
// with stable keys. One row per proposal, its hierarchy as cleaned JSONB, and
// a key → real-row map is the smallest thing that holds all of that.
//
// The rules, each load-bearing:
//
//  1. AGENTS MAY ONLY PROPOSE. `POST /` upserts by `sourceKey` and is the one
//     route the agent manual names. Accept and dismiss are the OWNER's, the
//     same contract as a verdict: nothing in the automation calls them.
//  2. A PROPOSAL IS NOT WORK. No node is a roadmap_items row until an accept
//     creates it, so Ready, sprints, lanes, plan runs and progress cannot see
//     it. Accept never writes ready_*, never commits a slice to a sprint and
//     never makes a milestone current: a new milestone is born 'planned'.
//  3. ACCEPT IS ATOMIC AND IDEMPOTENT. The row is locked FOR UPDATE, the whole
//     selection is validated (an item needs its slice, a slice its milestone,
//     each selected or already accepted) before anything is written, and a key
//     already in `accepted` is skipped, never created twice.
//  4. DISMISSAL STICKS. A dismissed row stays as the tombstone, and a re-POST
//     of its sourceKey is refused out loud (409, `dismissed: true`).
//  5. AN OWNER'S EDIT WINS. Once PATCHed (`edited_at`), an agent re-POST that
//     would change the content is refused: the agent proposes a new sourceKey.
//  6. EVERYTHING IN IT IS UNTRUSTED TEXT. Every field is capped; a link is an
//     artifact or item id checked against THIS project, or an http(s) URL the
//     client draws as text (the root rule on agent-authored links).

import { Router } from 'express';
import { q, pool } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { numericId } from '../params.js';
import { cleanDate } from '../shape.js';
import { BUCKETS, cleanSpec } from '../util.js';
import { createItem } from './roadmap.js';

export const propositions = Router({ mergeParams: true });
propositions.param('id', numericId);
propositions.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

export const CAPS = { milestones: 6, slices: 20, items: 40, total: 200, links: 30 };
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const text = (v, cap) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, cap);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// A link: {kind:'artifact'|'item', id, label} or {kind:'url', url, label}. Ids
// are checked later, in one query each, against this project.
function rawLinks(v) {
  return (Array.isArray(v) ? v : []).slice(0, CAPS.links).map((l) => {
    const label = text(l?.label, 200);
    const kind = String(l?.kind || (l?.url ? 'url' : '')).toLowerCase();
    if (kind === 'url') {
      const url = text(l?.url, 2000);
      return /^https?:\/\/[^\s]+$/i.test(url) ? { kind, url, label } : null;
    }
    if (kind === 'artifact' || kind === 'item') {
      const id = Number(l?.id);
      return Number.isInteger(id) && id > 0 ? { kind, id, label } : null;
    }
    return null;
  }).filter(Boolean);
}

// THE TREE, cleaned. Keys are the proposer's when valid, otherwise derived
// from position; a duplicate key is refused, because it is what acceptance
// is keyed by.
export function cleanTree(raw) {
  const seen = new Set();
  const keyOf = (v, fallback) => {
    const k = KEY_RE.test(String(v ?? '')) ? String(v) : fallback;
    if (seen.has(k)) throw bad(`Duplicate key "${k}" in the proposition.`);
    seen.add(k);
    return k;
  };
  const ms = Array.isArray(raw?.milestones) ? raw.milestones : [];
  if (ms.length > CAPS.milestones) throw bad(`At most ${CAPS.milestones} milestones per proposition.`);
  let total = 0;
  const milestones = ms.map((m, mi) => {
    const mk = keyOf(m?.key, `m${mi + 1}`);
    const existing = Number(m?.milestoneId);
    const node = {
      key: mk,
      name: text(m?.name, 120),
      goal: text(m?.goal, 20000),
      targetOn: cleanDate(m?.targetOn),
      milestoneId: Number.isInteger(existing) && existing > 0 ? existing : null,
      slices: [],
    };
    if (!node.name && node.milestoneId === null) throw bad(`Milestone ${mi + 1} needs a name (or a milestoneId).`);
    const sl = Array.isArray(m?.slices) ? m.slices : [];
    if (sl.length > CAPS.slices) throw bad(`At most ${CAPS.slices} slices per milestone.`);
    node.slices = sl.map((s, si) => {
      const sk = keyOf(s?.key, `${mk}.s${si + 1}`);
      const title = text(s?.title, 200);
      if (!title) throw bad(`Slice ${si + 1} of "${node.name || mk}" needs a title.`);
      const its = Array.isArray(s?.items) ? s.items : [];
      if (its.length > CAPS.items) throw bad(`At most ${CAPS.items} items per slice.`);
      total += its.length;
      return {
        key: sk, title,
        spec: text(s?.spec, 50000),
        areas: [...new Set((Array.isArray(s?.areas) ? s.areas : [])
          .map((a) => text(a, 40).toLowerCase()).filter(Boolean))].slice(0, 20),
        links: rawLinks(s?.links),
        items: its.map((it, ii) => {
          const ik = keyOf(it?.key, `${sk}.i${ii + 1}`);
          const t = text(it?.title, 300);
          if (!t) throw bad(`Item ${ii + 1} of slice "${title}" needs a title.`);
          const kind = String(it?.kind ?? '').trim().toLowerCase();
          const bucket = String(it?.bucket ?? '').trim().toLowerCase();
          return {
            key: ik, title: t,
            kind: kind === 'story' || kind === 'task' ? kind : '',
            note: text(it?.note, 4000),
            bucket: BUCKETS.includes(bucket) ? bucket : '',
            area: text(it?.area, 40).toLowerCase(),
            spec: cleanSpec(it?.spec),
            dependsOn: [...new Set((Array.isArray(it?.dependsOn) ? it.dependsOn : []).map(String))].slice(0, 20),
            links: rawLinks(it?.links),
          };
        }),
      };
    });
    return node;
  });
  if (total > CAPS.total) throw bad(`At most ${CAPS.total} items per proposition.`);
  // A dependency names another item in THIS proposition; anything else is dropped.
  const itemKeys = new Set(milestones.flatMap((m) => m.slices.flatMap((s) => s.items.map((i) => i.key))));
  for (const m of milestones) for (const s of m.slices) for (const i of s.items) {
    i.dependsOn = i.dependsOn.filter((k) => k !== i.key && itemKeys.has(k));
  }
  return { milestones };
}

// Every artifact/item id a link names, kept only when it is in this project.
async function checkLinks(db, projectId, tree, links) {
  const all = [links, ...tree.milestones.flatMap((m) => m.slices.flatMap((s) => [s.links, ...s.items.map((i) => i.links)]))];
  const want = (kind) => [...new Set(all.flat().filter((l) => l.kind === kind).map((l) => l.id))];
  const ok = async (table, ids) => (ids.length
    ? new Set((await db(`SELECT id FROM ${table} WHERE project_id = $1 AND id = ANY($2::int[])`, [projectId, ids])).rows.map((r) => r.id))
    : new Set());
  const arts = await ok('artifacts', want('artifact'));
  const items = await ok('roadmap_items', want('item'));
  const keep = (l) => l.kind === 'url' || (l.kind === 'artifact' ? arts.has(l.id) : items.has(l.id));
  const prune = (xs) => xs.filter(keep);
  for (const m of tree.milestones) for (const s of m.slices) {
    s.links = prune(s.links);
    for (const i of s.items) i.links = prune(i.links);
  }
  return prune(links);
}

async function checkArtifact(db, projectId, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number(raw);
  const { rows } = Number.isInteger(id) && id > 0
    ? await db('SELECT id FROM artifacts WHERE id = $1 AND project_id = $2', [id, projectId]) : { rows: [] };
  if (!rows.length) throw bad(`artifactId ${raw} is not an artifact in this project.`);
  return id;
}

// The proposal type the tile wears, derived rather than claimed.
const kindOf = (tree) => (tree.milestones.some((m) => m.milestoneId === null) ? 'milestone'
  : tree.milestones.some((m) => m.slices.length) ? 'slices' : 'empty');

const nodesOf = (tree) => tree.milestones.flatMap((m) => [
  { key: m.key, type: 'milestone', existing: m.milestoneId !== null },
  ...m.slices.flatMap((s) => [{ key: s.key, type: 'slice' }, ...s.items.map((i) => ({ key: i.key, type: 'item' }))]),
]);

export function propositionShape(r) {
  const tree = r.tree && Array.isArray(r.tree.milestones) ? r.tree : { milestones: [] };
  const accepted = r.accepted && typeof r.accepted === 'object' ? r.accepted : {};
  const count = (type) => nodesOf(tree).filter((n) => n.type === type && !n.existing).length;
  const real = nodesOf(tree).filter((n) => !n.existing);
  return {
    id: r.id,
    sourceKey: r.source_key,
    title: r.title,
    outcome: r.outcome || '',
    purpose: r.purpose || '',
    kind: kindOf(tree),
    status: r.status,
    tree,
    links: Array.isArray(r.links) ? r.links : [],
    accepted,
    artifactId: r.artifact_id ?? null,
    proposedBy: r.proposed_by || '',
    origin: r.origin && typeof r.origin === 'object' ? r.origin : {},
    counts: {
      milestones: count('milestone'), slices: count('slice'), items: count('item'),
      accepted: real.filter((n) => accepted[n.key]).length, total: real.length,
    },
    editedAt: r.edited_at || null,
    acceptedAt: r.accepted_at || null,
    dismissedAt: r.dismissed_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const sendErr = (e, res) => {
  if (e?.status !== 400) return false;
  res.status(400).json({ error: e.message });
  return true;
};

propositions.get('/', async (req, res) => {
  const { rows } = await q(
    `SELECT * FROM propositions WHERE project_id = $1
      ORDER BY (status = 'proposed') DESC, updated_at DESC, id DESC`, [req.project.id]);
  res.json(rows.map(propositionShape));
});

propositions.get('/:id', async (req, res) => {
  const { rows } = await q('SELECT * FROM propositions WHERE id = $1 AND project_id = $2', [Number(req.params.id), req.project.id]);
  if (!rows.length) return res.status(404).json({ error: 'No such proposition.' });
  res.json(propositionShape(rows[0]));
});

// POST / — create or update by sourceKey (the agent's door). 201 new, 200
// updated or unchanged, 409 dismissed or owner-edited.
propositions.post('/', async (req, res) => {
  const b = req.body ?? {};
  const sourceKey = text(b.sourceKey, 200);
  if (!sourceKey) return res.status(400).json({ error: 'A proposition needs a sourceKey (its stable identity, e.g. "artifact:6").' });
  const title = text(b.title, 200);
  if (!title) return res.status(400).json({ error: 'A proposition needs a title.' });
  let tree; let links; let artifactId;
  try {
    tree = cleanTree(b.tree ?? { milestones: b.milestones });
    if (!tree.milestones.length) throw bad('A proposition proposes at least one milestone (or slices under an existing milestoneId).');
    for (const m of tree.milestones) {
      if (m.milestoneId === null) continue;
      const { rows } = await q('SELECT id FROM milestones WHERE id = $1 AND project_id = $2', [m.milestoneId, req.project.id]);
      if (!rows.length) throw bad(`milestoneId ${m.milestoneId} is not a milestone in this project.`);
    }
    links = await checkLinks(q, req.project.id, tree, rawLinks(b.links));
    artifactId = await checkArtifact(q, req.project.id, b.artifactId);
  } catch (e) { if (sendErr(e, res)) return; throw e; }
  const outcome = text(b.outcome, 500);
  const purpose = text(b.purpose, 20000);
  const proposedBy = text(b.proposedBy, 120);
  const origin = { kind: text(b.origin?.kind, 40), sessionId: text(b.origin?.sessionId, 100), branch: text(b.origin?.branch, 200) };

  const { rows: cur } = await q('SELECT * FROM propositions WHERE project_id = $1 AND source_key = $2', [req.project.id, sourceKey]);
  const was = cur[0];
  if (was?.status === 'dismissed') {
    return res.status(409).json({ error: 'The owner dismissed this proposition. Do not propose it again.', dismissed: true, id: was.id });
  }
  const content = JSON.stringify([title, outcome, purpose, tree, links, artifactId]);
  if (was) {
    const same = JSON.stringify([was.title, was.outcome, was.purpose, was.tree, was.links, was.artifact_id]) === content;
    if (same) return res.status(200).json(propositionShape(was));
    if (was.edited_at) {
      return res.status(409).json({ error: 'The owner has edited this proposition, so it is theirs now. Propose changes under a new sourceKey.', edited: true, id: was.id });
    }
    const { rows } = await q(
      `UPDATE propositions SET title = $2, outcome = $3, purpose = $4, tree = $5::jsonb, links = $6::jsonb,
              artifact_id = $7, proposed_by = $8, origin = $9::jsonb, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [was.id, title, outcome, purpose, JSON.stringify(tree), JSON.stringify(links), artifactId, proposedBy, JSON.stringify(origin)]);
    return res.status(200).json(propositionShape(rows[0]));
  }
  const { rows } = await q(
    `INSERT INTO propositions (project_id, source_key, title, outcome, purpose, tree, links, artifact_id, proposed_by, origin)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb)
     ON CONFLICT (project_id, source_key) DO NOTHING RETURNING *`,
    [req.project.id, sourceKey, title, outcome, purpose, JSON.stringify(tree), JSON.stringify(links), artifactId, proposedBy, JSON.stringify(origin)]);
  if (!rows.length) {
    // A concurrent retry won the insert: answer with its row.
    const { rows: again } = await q('SELECT * FROM propositions WHERE project_id = $1 AND source_key = $2', [req.project.id, sourceKey]);
    return res.status(200).json(propositionShape(again[0]));
  }
  res.status(201).json(propositionShape(rows[0]));
});

// PATCH /:id — the owner's edit. Marks the row edited (rule 5). A node that
// was already accepted keeps its accepted reference whatever the edit says.
propositions.patch('/:id', async (req, res) => {
  const b = req.body ?? {};
  const { rows: cur } = await q('SELECT * FROM propositions WHERE id = $1 AND project_id = $2', [Number(req.params.id), req.project.id]);
  if (!cur.length) return res.status(404).json({ error: 'No such proposition.' });
  if (cur[0].status === 'dismissed') return res.status(409).json({ error: 'This proposition was dismissed.' });
  const sets = ['updated_at = now()', 'edited_at = now()'];
  const vals = [cur[0].id];
  const put = (sql, v) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
  try {
    if (b.title !== undefined) {
      const t = text(b.title, 200);
      if (!t) throw bad('A proposition needs a title.');
      put('title = ?', t);
    }
    if (b.outcome !== undefined) put('outcome = ?', text(b.outcome, 500));
    if (b.purpose !== undefined) put('purpose = ?', text(b.purpose, 20000));
    let tree = cur[0].tree;
    if (b.tree !== undefined) {
      tree = cleanTree(b.tree);
      for (const m of tree.milestones) {
        if (m.milestoneId === null) continue;
        const { rows } = await q('SELECT id FROM milestones WHERE id = $1 AND project_id = $2', [m.milestoneId, req.project.id]);
        if (!rows.length) throw bad(`milestoneId ${m.milestoneId} is not a milestone in this project.`);
      }
    }
    const links = await checkLinks(q, req.project.id, tree, b.links !== undefined ? rawLinks(b.links) : (cur[0].links || []));
    if (b.tree !== undefined) put('tree = ?::jsonb', JSON.stringify(tree));
    if (b.links !== undefined || b.tree !== undefined) put('links = ?::jsonb', JSON.stringify(links));
  } catch (e) { if (sendErr(e, res)) return; throw e; }
  const { rows } = await q(`UPDATE propositions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  res.json(propositionShape(await settle(rows[0])));
});

// A proposition whose every new node has been accepted leaves the lane.
async function settle(row, db = q) {
  const s = propositionShape(row);
  if (row.status === 'proposed' && s.counts.total > 0 && s.counts.accepted >= s.counts.total) {
    const { rows } = await db(`UPDATE propositions SET status = 'accepted', updated_at = now() WHERE id = $1 RETURNING *`, [row.id]);
    return rows[0];
  }
  return row;
}

// POST /:id/dismiss — the owner's no. Accepted work stays where it went.
propositions.post('/:id/dismiss', async (req, res) => {
  const { rows } = await q(
    `UPDATE propositions SET status = 'dismissed', dismissed_at = now(), updated_at = now()
      WHERE id = $1 AND project_id = $2 AND status <> 'accepted' RETURNING *`, [Number(req.params.id), req.project.id]);
  if (!rows.length) {
    const { rows: any } = await q('SELECT status FROM propositions WHERE id = $1 AND project_id = $2', [Number(req.params.id), req.project.id]);
    if (!any.length) return res.status(404).json({ error: 'No such proposition.' });
    return res.status(409).json({ error: 'Every part of this proposition was accepted; there is nothing left to dismiss.' });
  }
  res.json(propositionShape(rows[0]));
});

// The provenance line an accepted row carries.
const fromLine = (p) => `From proposition #${p.id} “${p.title}”${p.artifact_id ? ` (artifact #${p.artifact_id})` : ''}.`;

// POST /:id/accept {keys: [...], into?: {<milestoneKey>: <existing milestone id>}}
// — the owner's yes, for the selected nodes. See rule 3.
propositions.post('/:id/accept', async (req, res) => {
  const keys = [...new Set((Array.isArray(req.body?.keys) ? req.body.keys : []).map(String))];
  if (!keys.length) return res.status(400).json({ error: 'Pick at least one part to accept (keys).' });
  const into = req.body?.into && typeof req.body.into === 'object' ? req.body.into : {};
  const client = await pool.connect();
  const db = (t, p) => client.query(t, p);
  const fail = async (status, error) => { await client.query('ROLLBACK'); res.status(status).json({ error }); };
  try {
    await client.query('BEGIN');
    const { rows: cur } = await db('SELECT * FROM propositions WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [Number(req.params.id), req.project.id]);
    if (!cur.length) return await fail(404, 'No such proposition.');
    const p = cur[0];
    if (p.status === 'dismissed') return await fail(409, 'This proposition was dismissed.');
    const tree = cleanTree(p.tree);
    const accepted = { ...(p.accepted || {}) };
    const all = new Map();
    for (const m of tree.milestones) {
      all.set(m.key, { type: 'milestone', node: m });
      for (const s of m.slices) {
        all.set(s.key, { type: 'slice', node: s, parent: m });
        for (const i of s.items) all.set(i.key, { type: 'item', node: i, parent: s });
      }
    }
    const unknown = keys.filter((k) => !all.has(k));
    if (unknown.length) return await fail(400, `Not in this proposition: ${unknown.join(', ')}.`);
    const want = new Set(keys.filter((k) => !accepted[k]));
    // An existing-milestone target, from the tree or this accept's `into`.
    const target = async (m) => {
      const raw = into[m.key] ?? m.milestoneId;
      if (raw === undefined || raw === null || raw === '') return null;
      const id = Number(raw);
      const { rows } = Number.isInteger(id) && id > 0
        ? await db('SELECT id FROM milestones WHERE id = $1 AND project_id = $2', [id, req.project.id]) : { rows: [] };
      if (!rows.length) throw bad(`Milestone ${raw} is not a milestone in this project.`);
      return id;
    };
    // VALIDATE THE WHOLE SELECTION before any write.
    for (const k of want) {
      const n = all.get(k);
      if (n.type === 'item' && !want.has(n.parent.key) && !accepted[n.parent.key]) {
        return await fail(400, `“${n.node.title}” needs its slice “${n.parent.title}” accepted with it.`);
      }
      if (n.type === 'slice' && !want.has(n.parent.key) && !accepted[n.parent.key] && (await target(n.parent)) === null) {
        return await fail(400, `Slice “${n.node.title}” needs its milestone “${n.parent.name}” accepted with it.`);
      }
    }
    if (!want.size) { await client.query('ROLLBACK'); return res.json({ ...propositionShape(p), made: [] }); }

    const made = [];
    // Milestones first (new ones born 'planned', never current), then slices,
    // then items: parents always exist before children.
    for (const m of tree.milestones) {
      if (!want.has(m.key)) continue;
      const existing = await target(m);
      if (existing !== null) { accepted[m.key] = { type: 'milestone', id: existing, existing: true }; continue; }
      const { rows } = await db(
        `INSERT INTO milestones (project_id, name, goal, status, target_on, position)
         VALUES ($1, $2, $3, 'planned', $4, (SELECT COALESCE(MAX(position), -1) + 1 FROM milestones WHERE project_id = $1))
         RETURNING id`, [req.project.id, m.name, m.goal, m.targetOn]);
      accepted[m.key] = { type: 'milestone', id: rows[0].id };
      made.push({ key: m.key, type: 'milestone', id: rows[0].id });
    }
    for (const m of tree.milestones) for (const s of m.slices) {
      if (!want.has(s.key)) continue;
      let mid = accepted[m.key]?.id ?? null;
      if (mid === null) {
        mid = await target(m);
        accepted[m.key] = { type: 'milestone', id: mid, existing: true };
      }
      const spec = [s.spec, `_${fromLine(p)}_`].filter(Boolean).join('\n\n');
      const { rows } = await db(
        `INSERT INTO slices (project_id, milestone_id, title, spec, areas, position)
         VALUES ($1, $2, $3, $4, $5::jsonb, (SELECT COALESCE(MAX(position), -1) + 1 FROM slices WHERE milestone_id = $2))
         RETURNING id`, [req.project.id, mid, s.title, spec, JSON.stringify(s.areas)]);
      accepted[s.key] = { type: 'slice', id: rows[0].id };
      made.push({ key: s.key, type: 'slice', id: rows[0].id });
    }
    const madeItems = [];
    for (const m of tree.milestones) for (const s of m.slices) for (const i of s.items) {
      if (!want.has(i.key)) continue;
      // 'manual': the owner just accepted it, which is the sign-off. Ready
      // and sprint membership are untouched (createItem writes neither).
      const out = await createItem(db, req.project.id, {
        title: i.title, note: [i.note, fromLine(p)].filter(Boolean).join('\n\n'),
        kind: i.kind, bucket: i.bucket || undefined, area: i.area, spec: i.spec,
        sliceId: accepted[s.key].id, source: 'manual',
      });
      if (out.status >= 400) throw bad(`“${i.title}”: ${out.body.error}`);
      accepted[i.key] = { type: 'item', id: out.body.id };
      made.push({ key: i.key, type: 'item', id: out.body.id });
      madeItems.push(i);
    }
    // Dependencies become lines on the dependent's note, naming the real row
    // when it exists and the proposed title when it does not yet.
    const titleOf = new Map([...all].filter(([, n]) => n.type === 'item').map(([k, n]) => [k, n.node.title]));
    for (const i of madeItems) {
      if (!i.dependsOn.length) continue;
      const line = 'Depends on: ' + i.dependsOn.map((k) => (accepted[k] ? `#${accepted[k].id} ${titleOf.get(k)}` : `“${titleOf.get(k)}” (still proposed)`)).join('; ');
      await db(`UPDATE roadmap_items SET note = left(note || E'\\n\\n' || $2, 4000) WHERE id = $1`, [accepted[i.key].id, line]);
    }
    // The source artifact links to the work it became.
    const ids = made.filter((x) => x.type === 'item').map((x) => x.id);
    if (p.artifact_id && ids.length) {
      await db(
        `UPDATE artifacts SET links = (SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                 FROM jsonb_array_elements(links || $2::jsonb) v), updated_at = now()
          WHERE id = $1 AND project_id = $3`, [p.artifact_id, JSON.stringify(ids), req.project.id]);
    }
    const { rows: up } = await db(
      `UPDATE propositions SET accepted = $2::jsonb, accepted_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id, JSON.stringify(accepted)]);
    const row = await settle(up[0], db);
    await client.query('COMMIT');
    res.json({ ...propositionShape(row), made });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (sendErr(e, res)) return;
    throw e;
  } finally {
    client.release();
  }
});
