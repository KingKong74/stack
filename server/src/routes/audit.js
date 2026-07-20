import { Router } from 'express';
import { q } from '../db.js';
import { projectBySlug } from '../resolve.js';
import { fingerprint, oneOf, relativeTime, SEVERITIES } from '../util.js';
import { bugShape } from '../shape.js';
import { askGemini, geminiEnabled } from '../gemini.js';
import { buildPrompt } from '../prompts.js';

// Mounted at /api/projects/:slug/audit — the Testing panel's automated bug
// audit (#144). Two surfaces:
//   POST /        — Gemini reads the owner's audit brief, the check results,
//                   the tracked bugs and the live page, and reports suspected
//                   bugs. Findings land as review-inbox bug rows (source
//                   'hook', reviewed_at NULL) — the ONE sanctioned way Gemini
//                   output touches state: as suggestions the human keeps or
//                   dismisses, deduped by fingerprint and honouring tombstones.
//   GET  /prompt  — the Claude hand-off: the same context composed as a deep
//                   investigation prompt to paste into a Claude session (the
//                   web terminal's Claude mode, or any chat). No Gemini key
//                   needed — Claude runs on the owner's own subscription.
export const audit = Router({ mergeParams: true });

const FETCH_TIMEOUT_MS = 8000;
const BODY_CAP = 262144; // read at most 256KB of the live page
const MAX_FINDINGS = 6;

audit.use(async (req, res, next) => {
  const project = await projectBySlug(req.params.slug);
  if (!project) return res.status(404).json({ error: 'No such project.' });
  req.project = project;
  next();
});

// Fetch the live page and strip it to visible text (same treatment as the
// semantic check judge). Never throws — 'unavailable' is itself evidence.
async function fetchPageText(url) {
  if (!/^https?:\/\//i.test(url || '')) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'stack-audit/1.0' },
    });
    const body = (await res.text()).slice(0, BODY_CAP);
    const text = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
    return `(HTTP ${res.status}) ${text}`;
  } catch {
    return 'unavailable — the fetch failed or timed out';
  } finally {
    clearTimeout(timer);
  }
}

// Everything both prompts are grounded in, gathered once.
async function gatherContext(p) {
  const [checksR, bugsR, actR] = await Promise.all([
    q('SELECT * FROM checks WHERE project_id = $1 ORDER BY created_at', [p.id]),
    q(
      `SELECT bug_key, title, severity, status FROM bugs
        WHERE project_id = $1 AND status <> 'fixed'
        ORDER BY created_at DESC LIMIT 20`,
      [p.id]
    ),
    q(
      `SELECT commit_hash, branch, summary, created_at FROM sessions
        WHERE project_id = $1 ORDER BY created_at DESC LIMIT 6`,
      [p.id]
    ),
  ]);
  const page = await fetchPageText(p.site_url);
  return { checks: checksR.rows, bugs: bugsR.rows, activity: actR.rows, page };
}

const checkLine = (c) => {
  const expect = [
    `HTTP ${c.expect_status}`,
    c.contains ? `body contains "${c.contains}"` : '',
    c.semantic ? `looks right: ${c.semantic}` : '',
  ].filter(Boolean).join(', ');
  const result = c.last_status
    ? `${c.last_status}${c.last_error ? ` — ${c.last_error}` : ''} (${relativeTime(c.last_run_at) || 'recently'})`
    : 'never run';
  return `${c.name} (${c.url}) | ${expect} | ${result}`;
};

const contextVars = (p, ctx) => ({
  NAME: p.name,
  NORTH_STAR_LINE: p.north_star ? `North star: ${p.north_star}` : '',
  PHASE: p.current_phase || 'not recorded',
  TECH: Array.isArray(p.tech_stack) && p.tech_stack.length ? p.tech_stack.join(', ') : 'not recorded',
  BRIEF: (p.audit_context || '').trim() || 'none written — audit generally: availability, broken flows, errors on the page.',
  CHECKS: ctx.checks.length ? ctx.checks.map(checkLine).join('\n') : 'no checks configured',
  KNOWN_BUGS: ctx.bugs.length
    ? ctx.bugs.map((b) => `${b.bug_key} (${b.severity}, ${b.status}) ${b.title}`).join('\n')
    : 'none open',
  ACTIVITY: ctx.activity.length
    ? ctx.activity.map((a) => `${relativeTime(a.created_at) || 'recently'} [${a.branch || 'main'}] ${(a.summary || '').slice(0, 200)}`).join('\n')
    : 'none recorded',
  SITE_URL: p.site_url || '(no site URL set)',
  PAGE: p.site_url ? ctx.page : 'no site URL set — nothing fetched',
  MAX: MAX_FINDINGS,
});

// Land audit findings as review-inbox bugs: source 'hook' so they carry the
// auto cue and wait in the inbox until kept or dismissed. Dedup by fingerprint
// against EVERY existing bug (not just hook ones — a manually tracked bug must
// not come back as a suggestion) and honour tombstones. Returns per-finding
// outcomes for the UI.
async function landFindings(projectId, findings) {
  const out = [];
  const { rows: maxr } = await q(
    `SELECT COALESCE(MAX((substring(bug_key from '^BUG-([0-9]+)$'))::int), 0) AS n
       FROM bugs WHERE project_id = $1`,
    [projectId]
  );
  let n = maxr[0].n;
  for (const f of findings) {
    const title = String(f.title || '').trim().slice(0, 300);
    if (!title) continue;
    const severity = oneOf(f.severity, SEVERITIES, 'medium');
    const evidence = String(f.evidence || '').trim().slice(0, 300);
    const fp = fingerprint(title);

    const { rows: dead } = await q(
      `SELECT 1 FROM dismissed_items WHERE project_id=$1 AND kind='bug' AND fingerprint=$2`,
      [projectId, fp]
    );
    if (dead.length) { out.push({ title, severity, evidence, outcome: 'dismissed', bug: null }); continue; }

    const { rows: dup } = await q(
      'SELECT bug_key FROM bugs WHERE project_id=$1 AND fingerprint=$2 LIMIT 1',
      [projectId, fp]
    );
    if (dup.length) { out.push({ title, severity, evidence, outcome: 'duplicate', bug: null }); continue; }

    n += 1;
    const { rows } = await q(
      `INSERT INTO bugs (project_id, bug_key, title, severity, status, source, fingerprint)
       VALUES ($1,$2,$3,$4,'open','hook',$5)
       ON CONFLICT DO NOTHING RETURNING *`,
      [projectId, `BUG-${n}`, title, severity, fp]
    );
    if (rows.length) out.push({ title, severity, evidence, outcome: 'logged', bug: bugShape(rows[0]) });
    else out.push({ title, severity, evidence, outcome: 'duplicate', bug: null });
  }
  return out;
}

// POST /  -> run the Gemini audit and log findings to the review inbox
audit.post('/', async (req, res) => {
  if (!geminiEnabled()) {
    return res.status(503).json({ error: 'Gemini is not configured on this server (set GEMINI_API_KEY).' });
  }
  const p = req.project;
  const ctx = await gatherContext(p);
  const prompt = buildPrompt('audit', contextVars(p, ctx));

  try {
    const answer = await askGemini(prompt, { timeoutMs: 30_000 });
    const raw = Array.isArray(answer?.findings) ? answer.findings.slice(0, MAX_FINDINGS) : [];
    const findings = await landFindings(p.id, raw);
    res.json({
      findings,
      logged: findings.filter((f) => f.outcome === 'logged').length,
      skipped: findings.filter((f) => f.outcome !== 'logged').length,
    });
  } catch (err) {
    res.status(err.httpStatus || 502).json({ error: err.message || 'Gemini call failed.' });
  }
});

// GET /prompt  -> the deep-audit prompt for a Claude session (keyless — no
// Gemini involved; the client copies it to the clipboard).
audit.get('/prompt', async (req, res) => {
  const p = req.project;
  const ctx = await gatherContext(p);
  const v = contextVars(p, ctx);

  const prompt = `You are doing a deep bug audit of the side project "${v.NAME}".
${v.NORTH_STAR_LINE ? v.NORTH_STAR_LINE + '\n' : ''}Phase: ${v.PHASE}
Tech stack: ${v.TECH}
${p.repo_url ? `Repo: ${p.repo_url}\n` : ''}${p.site_url ? `Live app: ${p.site_url}\n` : ''}${p.logs_url ? `Logs: ${p.logs_url}\n` : ''}
THE OWNER'S AUDIT BRIEF (what to look for — weigh this heavily):
${v.BRIEF}

Check results (name | expectation | last result):
${v.CHECKS}

Bugs already tracked (do not re-report these):
${v.KNOWN_BUGS}

Recent pushes:
${v.ACTIVITY}

Unlike a surface scan, you should INVESTIGATE: read the code where you have it, exercise the live
app and its API, reproduce anything suspicious, and check the recent pushes for regressions. Be
sceptical of your own findings — confirm each one before reporting it.

For each confirmed bug, report: a short specific title (≤ 15 words), severity
(critical/high/medium/low) and how to reproduce it. If this machine has the Stack CLI set up
(~/.stack/env), you may also file each one via
POST $STACK_API/api/projects/${p.slug}/bugs with {"title","severity"} — otherwise just report back
and the owner will file them. Use en-AU spelling.`;

  res.json({ prompt });
});
