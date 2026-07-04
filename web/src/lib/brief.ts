import type { Project, Activity, Bug, Roadmap } from '../types';
import { PRODUCT_NAME, SEVERITY_ORDER } from './ui';

// Builds the exportable "resume brief" — a concise markdown template with the
// essentials for starting back into a project (paste it into an agent or an
// editor). Pure formatting: callers hand in data already loaded via store.ts.

export interface BriefInput {
  project: Project;
  currentPhase: string;
  blockers: string[];
  activity: Activity[];
  bugs: Bug[];
  roadmap: Roadmap;
}

const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;
const MAX_BUGS = 8;
const MAX_ROADMAP = 6;
const MAX_ACTIVITY = 3;

const clip = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  return `${one.slice(0, n).replace(/\s+\S*$/, '')}…`;
};

const bullets = (items: string[]) => items.map((t) => `- ${t}`).join('\n');

function section(title: string, body: string): string {
  return body ? `## ${title}\n${body}` : '';
}

export function buildBrief({ project, currentPhase, blockers, activity, bugs, roadmap }: BriefInput): string {
  const r = project.resume;
  const latest = activity[0];

  const statusBits = [
    `**Status:** ${STATUS_LABEL[project.status]}${project.progress > 0 ? ` (${project.progress}% by roadmap)` : ''}`,
    currentPhase && `**Phase:** ${currentPhase}`,
  ].filter(Boolean).join(' · ');
  const pushLine = latest && `**Last push:** \`${latest.hash}\` on ${latest.branch} · ${latest.when}`;
  const linkLine = [
    project.repoUrl && `**Repo:** ${project.repoUrl}`,
    project.siteUrl && `**Site:** ${project.siteUrl}`,
  ].filter(Boolean).join(' · ');

  // Open bugs, worst first, capped.
  const openBugs = bugs
    .filter((b) => b.status !== 'fixed')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const bugLines = openBugs.slice(0, MAX_BUGS)
    .map((b) => `- ${b.id} · ${b.severity} — ${b.title}${b.status !== 'open' ? ` _(${b.status})_` : ''}`);
  if (openBugs.length > MAX_BUGS) bugLines.push(`- …and ${openBugs.length - MAX_BUGS} more`);

  // Open Must/Should roadmap items not already covered by the resume's next-up list.
  const covered = new Set((r?.nextUp || []).map((t) => t.trim().toLowerCase()));
  const openRoadmap = [...roadmap.must, ...roadmap.should]
    .filter((it) => !it.done && !covered.has(it.title.trim().toLowerCase()));
  const roadLines = openRoadmap.slice(0, MAX_ROADMAP)
    .map((it) => `- [ ] ${it.title}${it.bucket === 'must' ? ' _(must)_' : ''}`);
  if (openRoadmap.length > MAX_ROADMAP) roadLines.push(`- …and ${openRoadmap.length - MAX_ROADMAP} more`);

  const pushLines = activity.slice(0, MAX_ACTIVITY)
    .map((a) => `- \`${a.hash}\` (${a.when}) — ${clip(a.summary) || '—'}`);

  const exported = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  const parts = [
    `# ${project.name} — resume brief`,
    project.subtitle && `_${project.subtitle}_`,
    [statusBits, pushLine, linkLine].filter(Boolean).join('\n'),
    section('Where you left off', r?.summary || ''),
    section('In progress', bullets(r?.inProgress || [])),
    section('Next up', bullets(r?.nextUp || [])),
    section('Blockers', bullets(blockers)),
    openBugs.length ? section(`Open bugs (${openBugs.length})`, bugLines.join('\n')) : '',
    roadLines.length ? section('Roadmap — still open (must/should)', roadLines.join('\n')) : '',
    section('Working well — keep', bullets(r?.liked || [])),
    section('Recent pushes', pushLines.join('\n')),
    `---\n_Exported from ${PRODUCT_NAME} · ${exported}. Paste this at the start of a session to pick up where you left off._`,
  ];
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

// Compose the brief and hand it to the browser as a markdown download.
export function downloadBrief(input: BriefInput) {
  const blob = new Blob([buildBrief(input)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${input.project.id}-resume-brief.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
