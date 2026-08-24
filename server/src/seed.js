// Optional demo seed — NOT run on boot. Inserts a couple of demo projects with
// a little content so a fresh database isn't empty while you click around.
//
//   docker compose exec server npm run seed
//
// Idempotent: projects are keyed by slug, so re-running adds nothing.

import { migrate, pool, q } from './db.js';
import { TINTS, fingerprint } from './util.js';

const DEMO = [
  {
    slug: 'trailmark', name: 'Trailmark', repo: 'KingKong74/trailmark',
    subtitle: 'Hiking log + trail discovery web app', status: 'live',
    site_url: 'https://trailmark.app',
    summary:
      'Finishing the elevation-chart tooltip and migrating auth to Supabase magic links. ' +
      'Tooltip renders but mis-positions on mobile; magic-link login works end to end.',
    current_phase: 'Auth migration',
    in_progress: ['Elevation chart tooltip — mobile positioning is off', 'Session refresh after magic-link login (stubbed)'],
    next_up: ['Finish session refresh, then remove the temporary token hack', 'Add a test for the difficulty filter'],
    working_well: ['Magic-link login flow feels clean', 'Difficulty-filter UX with URL sync'],
    bugs: [{ title: 'Tooltip mis-positions on mobile', severity: 'high', status: 'open' }],
    roadmap: {
      must: [{ title: 'Remove the temporary token hack', done: false }],
      should: [{ title: 'Test the difficulty filter', done: false }],
    },
  },
  {
    slug: 'beacon', name: 'Beacon', repo: 'KingKong74/beacon',
    subtitle: 'Status page + uptime notifier', status: 'building',
    site_url: 'https://beacon.sh',
    summary:
      'Built the incident timeline and wired the email notifier. Webhook + Slack notifiers are ' +
      'scaffolded but not sending; the check scheduler still drifts under load.',
    current_phase: 'Notifiers',
    in_progress: ['Slack notifier — payload builds, delivery untested', 'Check scheduler drifts past 200 monitors'],
    next_up: ['Pin the scheduler with a leaky-bucket queue', 'Wire Slack delivery and add a retry'],
    working_well: ['Incident timeline component is reusable', 'Go check runner is fast and lean'],
    bugs: [{ title: 'Scheduler drifts past 200 monitors', severity: 'critical', status: 'investigating' }],
    roadmap: {
      must: [{ title: 'Leaky-bucket queue for the scheduler', done: false }],
      should: [{ title: 'Slack delivery with retry', done: false }],
      could: [{ title: 'Status-page themes', done: false }],
    },
  },
];

async function seed() {
  await migrate();
  for (let idx = 0; idx < DEMO.length; idx++) {
    const d = DEMO[idx];
    const exists = await q('SELECT 1 FROM projects WHERE slug = $1', [d.slug]);
    if (exists.rows.length) {
      console.log(`skip ${d.slug} (already present)`);
      continue;
    }
    const tint = TINTS[idx % TINTS.length];
    const { rows } = await q(
      `INSERT INTO projects
         (slug, name, repo, subtitle, status, site_url, tint, summary, current_phase,
          in_progress, next_up, working_well, last_session_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb, now())
       RETURNING id`,
      [
        d.slug, d.name, d.repo, d.subtitle, d.status, d.site_url, tint, d.summary, d.current_phase,
        JSON.stringify(d.in_progress), JSON.stringify(d.next_up), JSON.stringify(d.working_well),
      ]
    );
    const pid = rows[0].id;

    let bugN = 0;
    for (const b of d.bugs || []) {
      bugN++;
      await q(
        `INSERT INTO bugs (project_id, bug_key, title, severity, status, source, fingerprint)
         VALUES ($1,$2,$3,$4,$5,'manual',$6)`,
        [pid, `BUG-${bugN}`, b.title, b.severity, b.status, fingerprint(b.title)]
      );
    }
    for (const [bucket, items] of Object.entries(d.roadmap || {})) {
      let pos = 0;
      for (const it of items) {
        await q(
          `INSERT INTO roadmap_items (project_id, bucket, title, done, position, source, fingerprint)
           VALUES ($1,$2,$3,$4,$5,'manual',$6)`,
          [pid, bucket, it.title, it.done, pos++, fingerprint(it.title)]
        );
      }
    }
    console.log(`seeded ${d.slug}`);
  }
  await pool.end();
}

seed().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
