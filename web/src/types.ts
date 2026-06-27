export type ProjectStatus = 'live' | 'building' | 'paused' | 'archived';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type BugStatus = 'open' | 'investigating' | 'fixing' | 'fixed';
export type Priority = 'must' | 'should' | 'could' | 'wont';
export type Source = 'hook' | 'manual';   // hook = auto-extracted, manual = hand-entered

export interface Resume {
  when: string;
  ref: string;
  summary: string;
  inProgress: string[];
  nextUp: string[];
  liked: string[];
}

export interface ProjectMeta {
  version: string;
  lastDeploy: string;
  stack: string[];
  pushesThisWeek: number;
}

export interface Project {
  id: string;              // the slug
  name: string;
  subtitle: string;
  tint: string;
  status: ProjectStatus;
  progress: number;        // 0–100, computed server-side from roadmap/bug completion
  metaLine: string;        // dashboard card meta e.g. "pushed 2h ago"
  siteUrl: string;
  repoUrl: string;
  meta: ProjectMeta;
  resume: Resume | null;
}

export interface Bug {
  id: string;              // BUG-N
  title: string;
  severity: Severity;
  status: BugStatus;
  meta: string;            // "reported 2h ago"
  linkRef: string | null;  // commit hash
  source: Source;
}

export interface RoadmapItem {
  id: number;
  title: string;
  note: string;
  done: boolean;
  bucket: Priority;
  source: Source;
}
export interface Roadmap { must: RoadmapItem[]; should: RoadmapItem[]; could: RoadmapItem[]; wont: RoadmapItem[] }

export interface Note {
  id: number;
  text: string;
  colour: string;
  when: string;
  source: Source;
}

export interface Activity {
  hash: string;
  branch: string;
  when: string;
  summary: string;
  tags: string[];
}

export interface Collections {
  bugs: Bug[];
  roadmap: Roadmap;
  notes: Note[];
}

// ---- cross-project command deck (GET /api/overview) ----
export interface OverviewResume {
  slug: string; name: string; tint: string | null;
  summary: string; currentPhase: string; nextUp: string[];
}
export interface OverviewBlocker { slug: string; name: string; text: string }
export interface OverviewStale { slug: string; name: string; since: string }
export interface OverviewBugProject { slug: string; name: string; count: number }
export interface OverviewActivity {
  slug: string; name: string; hash: string; branch: string;
  summary: string; tags: string[]; when: string;
}
export interface Overview {
  resume: OverviewResume | null;
  blockers: OverviewBlocker[];
  stale: OverviewStale[];
  bugs: { total: number; projects: OverviewBugProject[] };
  activity: OverviewActivity[];
  totals: {
    byStatus: Record<ProjectStatus, number>;
    openBugs: number;
    pushesThisWeek: number;
  };
}
