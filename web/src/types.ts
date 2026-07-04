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
  deployPlatform: string;  // hand-set label on the Deployment panel ("Dokploy", "Vercel", …)
  logsUrl: string;         // where "View logs" points
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
  reviewed: boolean;       // hook items with false await review
}

export interface RoadmapItem {
  id: number;
  title: string;
  note: string;
  done: boolean;
  bucket: Priority;
  source: Source;
  reviewed: boolean;
}
export interface Roadmap { must: RoadmapItem[]; should: RoadmapItem[]; could: RoadmapItem[]; wont: RoadmapItem[] }

export interface Note {
  id: number;
  text: string;
  colour: string;
  when: string;
  source: Source;
}

// A future: a loose directional idea, curated against the project's north star
// and promoted into the roadmap when it firms up.
export interface Future {
  id: number;
  title: string;
  note: string;
  when: string;
  source: Source;
  reviewed: boolean;
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
// A project with at least one Claude session open right now.
export interface PresenceItem {
  slug: string; name: string;
  count: number;           // live sessions on this project
  branches: string[];      // distinct branches those sessions are on
  seen: string;            // most recent ping, relative
}
export interface ReviewItem {
  kind: 'bug' | 'roadmap' | 'future';
  slug: string; name: string;
  id: string;              // bug key (BUG-N) or row id (roadmap/future)
  title: string;
  meta: string;            // severity (bug) / bucket (roadmap) / 'idea' (future)
  when: string;
}
export interface OverviewStale { slug: string; name: string; since: string }
export interface OverviewBugProject { slug: string; name: string; count: number }
export interface OverviewActivity {
  slug: string; name: string; hash: string; branch: string;
  summary: string; tags: string[]; when: string;
}
export interface Overview {
  resume: OverviewResume | null;
  keepResumeCard: boolean;
  presence: PresenceItem[];
  blockers: OverviewBlocker[];
  stale: OverviewStale[];
  review: { total: number; items: ReviewItem[] };
  bugs: { total: number; projects: OverviewBugProject[] };
  activity: OverviewActivity[];
  totals: {
    byStatus: Record<ProjectStatus, number>;
    openBugs: number;
    pushesThisWeek: number;
  };
}

// ---- ⌘K command palette search (GET /api/search) ----
export type SearchKind = 'project' | 'bug' | 'roadmap' | 'future' | 'note' | 'activity';
export interface SearchTarget { slug: string; tab: string; highlight: string | null }
export interface SearchResult {
  kind: SearchKind;
  slug: string; name: string; tint: string | null;
  title: string; meta: string;
  target: SearchTarget;
}
export interface SearchGroups {
  projects: SearchResult[]; bugs: SearchResult[]; roadmap: SearchResult[];
  futures: SearchResult[]; notes: SearchResult[]; activity: SearchResult[];
}
export interface SearchResponse {
  query: string;
  groups: SearchGroups;
  counts: { projects: number; bugs: number; roadmap: number; futures: number; notes: number; activity: number; total: number };
  projectCount: number;
}

// ---- settings (GET/PATCH /api/settings) ----
export type CheckpointDetail = 'brief' | 'standard' | 'detailed';
export interface Settings {
  autoRecord: boolean;
  keepResumeCard: boolean;
  checkpointDetail: CheckpointDetail;
  includeChores: boolean;
}
