import type { Project, Activity, Bug, Roadmap } from '../types';
import { PRODUCT_NAME, SEVERITY_ORDER } from './ui';

// Builds the exportable "resume brief" — a concise markdown template with the
// essentials for starting back into a project (paste it into an agent or an
// editor). Pure formatting: callers hand in data already loaded via store.ts,
// and the export modal hands in the options (detail level + session
// preferences) the user curated.

export interface BriefInput {
  project: Project;
  currentPhase: string;
  blockers: string[];
  directives: string[];   // the standing steer list — echoed near the top
  activity: Activity[];
  bugs: Bug[];
  roadmap: Roadmap;
}

export interface BriefOptions {
  compact: boolean;      // efficiency mode — tighter caps, essentials only
  directives: string[];  // selected DIRECTIVES keys, rendered as session preferences
}

// The chop-and-change session preferences offered before export. `line` is the
// sentence written into the brief; label/hint are what the modal shows.
export const DIRECTIVES: { key: string; label: string; hint: string; line: string }[] = [
  {
    key: 'lean',
    label: 'Reduce token usage',
    hint: 'Work lean — concise output, no re-reading unchanged files.',
    line: 'Keep token usage lean: concise output, no re-reading unchanged files, no exploratory tangents.',
  },
  {
    key: 'ship',
    label: 'Commit + push each unit',
    hint: 'Land every completed unit of work on the remote.',
    line: 'Commit and push after every completed unit of work.',
  },
  {
    key: 'checkpoint',
    label: 'Checkpoint on wrap-up',
    hint: 'Run /checkpoint before ending the session.',
    line: 'Run /checkpoint before wrapping up the session.',
  },
  {
    key: 'confirm',
    label: 'Confirm big changes',
    hint: 'Check in before contract/schema changes or deletions.',
    line: 'Check in before changing API contracts or the schema, or deleting anything.',
  },
  {
    key: 'verify',
    label: 'Verify before done',
    hint: 'Build + typecheck must pass before calling work done.',
    line: 'Run the build/typecheck and verify before declaring work done.',
  },
];

const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  return `${one.slice(0, n).replace(/\s+\S*$/, '')}…`;
};

const bullets = (items: string[]) => items.map((t) => `- ${t}`).join('\n');

function section(title: string, body: string): string {
  return body ? `## ${title}\n${body}` : '';
}

export function buildBrief(
  { project, currentPhase, blockers, directives: steer, activity, bugs, roadmap }: BriefInput,
  { compact, directives }: BriefOptions = { compact: false, directives: [] },
): string {
  const r = project.resume;
  const latest = activity[0];
  const caps = compact
    ? { bugs: 5, roadmap: 3, activity: 1, clip: 90 }
    : { bugs: 8, roadmap: 6, activity: 3, clip: 160 };

  // Header facts as a tight bullet block.
  const facts = [
    `- **Status:** ${[
      STATUS_LABEL[project.status],
      project.progress > 0 && `${project.progress}%`,
      currentPhase,
    ].filter(Boolean).join(' · ')}`,
    latest && `- **Last push:** \`${latest.hash}\` on ${latest.branch} · ${latest.when}`,
    (project.repoUrl || project.siteUrl) &&
      `- **Links:** ${[project.repoUrl, project.siteUrl].filter(Boolean).join(' · ')}`,
  ].filter(Boolean).join('\n');

  const prefLines = DIRECTIVES.filter((d) => directives.includes(d.key)).map((d) => d.line);

  // Open bugs, worst first, capped.
  const openBugs = bugs
    .filter((b) => b.status !== 'fixed')
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const bugLines = openBugs.slice(0, caps.bugs)
    .map((b) => `- ${b.id} · ${b.severity} — ${b.title}${b.status !== 'open' ? ` _(${b.status})_` : ''}`);
  if (openBugs.length > caps.bugs) bugLines.push(`- …and ${openBugs.length - caps.bugs} more`);

  // Open Must/Should roadmap items not already covered by the resume's next-up list.
  const covered = new Set((r?.nextUp || []).map((t) => t.trim().toLowerCase()));
  const openRoadmap = [...roadmap.must, ...roadmap.should]
    .filter((it) => !it.done && !covered.has(it.title.trim().toLowerCase()));
  const roadLines = openRoadmap.slice(0, caps.roadmap)
    .map((it) => `- [ ] ${it.title}${it.bucket === 'must' ? ' _(must)_' : ''}`);
  if (openRoadmap.length > caps.roadmap) roadLines.push(`- …and ${openRoadmap.length - caps.roadmap} more`);

  const pushLines = activity.slice(0, caps.activity)
    .map((a) => `- \`${a.hash}\` (${a.when}) — ${clip(a.summary, caps.clip) || '—'}`);

  const exported = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  const parts = [
    `# ${project.name} — resume brief`,
    project.subtitle && `> ${project.subtitle}`,
    facts,
    section('Session preferences', bullets(prefLines)),
    section('Directives — honour these first', bullets(steer)),
    section('Where you left off', r?.summary || ''),
    section('In progress', bullets(r?.inProgress || [])),
    section('Next up', bullets(r?.nextUp || [])),
    section('Blockers', bullets(blockers)),
    openBugs.length ? section(`Open bugs (${openBugs.length})`, bugLines.join('\n')) : '',
    roadLines.length ? section('Roadmap — still open (must/should)', roadLines.join('\n')) : '',
    compact ? '' : section('Working well — keep', bullets(r?.liked || [])),
    section('Recent pushes', pushLines.join('\n')),
    `---\n_Exported from ${PRODUCT_NAME} · ${exported}. Paste this at the start of a session to pick up where you left off._`,
  ];
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

// Compose the brief and hand it to the browser as a markdown download.
export function downloadBrief(input: BriefInput, options?: BriefOptions) {
  const blob = new Blob([buildBrief(input, options)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${input.project.id}-resume-brief.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
