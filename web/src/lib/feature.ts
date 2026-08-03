// Feature derivation for Mission Control's Trees room (#365) — the pure layer
// that turns a project's claims, branches and worktrees into one row per
// in-progress feature, reading across parallel checkouts. No React, no
// network: this module takes the data Mission Control already fetched and
// works out where each feature has actually got to.
//
// It reuses `./branch` — the canonical client twin of the host's lane naming
// and merge-state read — rather than re-deriving anything about branch names
// or merge probes here.

import type { ControlProject, FleetSlot, Worktree } from '../store';
import { parseBranch, mergeStateOf, type MergeState, type LaneKind } from './branch';

export type FeatureStage = 'claimed' | 'building' | 'built' | 'pushed' | 'landed';

// Display order. Note the SORT is not this order verbatim — `building` always
// sorts first regardless of its position here (see `compareFeatures`), because
// a fleet worker on it right now outranks everything else about the room.
export const STAGES: readonly FeatureStage[] = ['claimed', 'building', 'built', 'pushed', 'landed'];

export const STAGE_META: Record<FeatureStage, { label: string; tone: string; hint: string }> = {
  claimed: {
    label: 'Claimed',
    tone: 'var(--paused)',
    hint: 'Somebody has claimed this work, but nothing has been committed or pushed yet.',
  },
  building: {
    label: 'Building',
    tone: 'var(--building)',
    hint: 'A fleet worker is on this right now.',
  },
  built: {
    label: 'Built',
    tone: 'var(--sage)',
    hint: 'Committed in a local worktree, but origin has never seen it.',
  },
  pushed: {
    label: 'Pushed',
    tone: 'var(--accent)',
    hint: 'On origin, ahead of main and waiting to merge.',
  },
  landed: {
    label: 'Landed',
    tone: 'var(--live)',
    hint: 'Already in main — done, or level with it.',
  },
};

export type FeatureFlag = 'dirty' | 'unpushed' | 'conflict' | 'unprobed' | 'no-tree' | 'prunable' | 'no-branch';

export const FLAG_META: Record<FeatureFlag, { label: string; tone: string; hint: string }> = {
  dirty: {
    label: 'Dirty',
    tone: 'var(--building)',
    hint: 'Uncommitted changes sit in this worktree — nothing has captured them yet.',
  },
  unpushed: {
    label: 'Unpushed',
    tone: 'var(--building)',
    hint: 'Local commits exist that origin has never seen.',
  },
  conflict: {
    label: 'Conflict',
    tone: 'var(--accent)',
    hint: 'The host’s merge-tree probe says this branch conflicts with main.',
  },
  unprobed: {
    label: 'Unprobed',
    tone: 'var(--paused)',
    hint: 'No conflict probe has run on this branch — unprobed is not clean.',
  },
  'no-tree': {
    label: 'No tree',
    tone: 'var(--paused)',
    hint: 'This claim has no worktree the host can see.',
  },
  prunable: {
    label: 'Prunable',
    tone: 'var(--muted)',
    hint: 'The tree’s directory is gone; its git record is ready to be pruned.',
  },
  'no-branch': {
    label: 'No branch',
    tone: 'var(--paused)',
    hint: 'This claim has no branch report and no worktree — nothing has been seen of it yet.',
  },
};

export interface Feature {
  key: string;            // stable: `${slug}/${itemId||branch}`
  slug: string; project: string; tint: string;
  itemId: string;         // '' when a branch has no roadmap item behind it
  title: string;          // item title, else the branch's parsed summary
  branch: string;         // '' when a claim has no branch yet
  kind: LaneKind | '';
  stage: FeatureStage;
  live: boolean;          // a fleet worker is on it right now
  // progress
  planTotal: number; planDone: number;
  ahead: number; behind: number;
  adds: number; dels: number; files: number;
  // the tree
  tree: Worktree | null;
  dirty: number;          // uncommitted paths, 0 when no tree
  unpushed: number;       // local commits origin has not seen, 0 when unknown
  // judgement
  mergeState: MergeState;
  reviewTag: string; builtNote: string; tier: string | null; risk: string;
  area: string; bucket: string;
  subject: string; when: string; claimedWhen: string;
  flags: FeatureFlag[];
}

type ClaimEntry = ControlProject['claims'][number];
type BranchEntry = ControlProject['branches'][number];

// One project's union draft, before stage/flags are resolved.
interface Draft {
  itemId: string;
  branch: string;
  claim: ClaimEntry | null;
  branchRep: BranchEntry | null;
  tree: Worktree | null;
}

const keyFor = (itemId: string, branch: string) => (itemId ? `id:${itemId}` : `br:${branch}`);

function draftFor(drafts: Map<string, Draft>, itemId: string, branch: string): Draft {
  const key = keyFor(itemId, branch);
  let d = drafts.get(key);
  if (!d) {
    d = { itemId, branch, claim: null, branchRep: null, tree: null };
    drafts.set(key, d);
  }
  if (!d.branch && branch) d.branch = branch;
  return d;
}

// Slugs whose worktree report has never run — the room says so out loud
// rather than implying every feature in it is tree-less. Missing data must
// never read as good news (CLAUDE.md's fail-silent rule).
export function worktreesUnseen(projects: ControlProject[]): string[] {
  return projects.filter((p) => p.worktrees === null).map((p) => p.slug);
}

export function buildFeatures(projects: ControlProject[], fleetSlots: FleetSlot[]): Feature[] {
  const out: Feature[] = [];

  for (const p of projects) {
    const drafts = new Map<string, Draft>();

    // 1. Claims — every open, claimed roadmap item always has an itemId.
    for (const c of p.claims) {
      const d = draftFor(drafts, c.id, c.branch);
      d.claim = c;
    }
    // 2. The merge strip's branches — git-enriched or claim-derived chips.
    for (const b of p.branches) {
      const d = draftFor(drafts, b.itemId || '', b.branch);
      d.branchRep = b;
    }
    // 3. Worktrees — excluding the primary checkout, which is not a feature.
    //    `worktrees === null` means the host has never reported: there is
    //    nothing to fold in, and (per worktreesUnseen) no tree-shaped flag
    //    may be inferred for this project at all.
    if (Array.isArray(p.worktrees)) {
      for (const w of p.worktrees) {
        if (w.main) continue;
        const d = draftFor(drafts, w.itemId || '', w.branch);
        d.tree = w;
      }
    }

    const worktreesSeen = Array.isArray(p.worktrees);
    const slugFleet = fleetSlots.filter((f) => f.slug === p.slug);

    for (const d of drafts.values()) {
      const branch = d.branch || '';
      const parsed = branch ? parseBranch(branch) : null;
      const kind: LaneKind | '' = parsed ? parsed.kind : '';
      const itemTitle = d.claim ? d.claim.title
        : (d.branchRep && d.branchRep.itemTitle) || (d.tree && d.tree.itemTitle) || '';
      const title = itemTitle || (parsed ? parsed.summary : '') || branch || d.itemId;

      const live = slugFleet.some((f) =>
        (d.itemId && f.itemId === d.itemId) || (branch && f.branch === branch));

      // NOT used: absence from claims[] as evidence the item is "done".
      // claims[] holds items that are both claimed AND open — an item drops
      // out of it when the claim is simply RELEASED too, which
      // stack-autopilot.mjs does routinely on runs that committed real work.
      // A released-but-open item with commits waiting on its branch would
      // then render as "landed": the room would hide a feature that needs
      // attention behind a green done. Git is the only evidence of landing.
      const branchAhead = d.branchRep && typeof d.branchRep.ahead === 'number' ? d.branchRep.ahead : null;
      const treeAhead = d.tree ? d.tree.ahead : null;
      // Landed = origin's branch holds nothing that main does not already have.
      // Only a branch that EXISTS on origin can be landed: a tree sitting at zero
      // commits has not landed, it has not started. And a tree holding commits
      // origin has not seen outranks a merged branch — there is newer work here.
      const landed = branchAhead === 0 && !(treeAhead !== null && treeAhead > 0);

      let stage: FeatureStage;
      if (live) stage = 'building';
      else if (landed) stage = 'landed';
      else if (branchAhead !== null && branchAhead > 0) stage = 'pushed';
      else if (treeAhead !== null && treeAhead > 0) stage = 'built';
      else stage = 'claimed';

      const mergeState = mergeStateOf({
        mergeClean: d.branchRep ? d.branchRep.mergeClean : undefined,
        behind: d.branchRep ? d.branchRep.behind : undefined,
      });

      const flags: FeatureFlag[] = [];
      if (d.tree && d.tree.dirty > 0) flags.push('dirty');
      if (d.tree && typeof d.tree.unpushed === 'number' && d.tree.unpushed > 0) flags.push('unpushed');
      if (mergeState === 'conflict') flags.push('conflict');
      if (mergeState === 'unprobed' && branch) flags.push('unprobed');
      if (worktreesSeen) {
        if (d.claim && stage !== 'landed' && !d.tree) flags.push('no-tree');
        if (d.tree && d.tree.prunable) flags.push('prunable');
      }
      if (d.claim && !d.branchRep && !d.tree) flags.push('no-branch');

      out.push({
        key: `${p.slug}/${d.itemId || branch}`,
        slug: p.slug,
        project: p.name,
        tint: p.tint || '',
        itemId: d.itemId,
        title,
        branch,
        kind,
        stage,
        live,
        planTotal: d.claim ? d.claim.planTotal : 0,
        planDone: d.claim ? d.claim.planDone : 0,
        ahead: branchAhead ?? treeAhead ?? 0,
        behind: (d.branchRep && d.branchRep.behind) || 0,
        adds: (d.branchRep && d.branchRep.adds) || 0,
        dels: (d.branchRep && d.branchRep.dels) || 0,
        files: (d.branchRep && d.branchRep.files) || 0,
        tree: d.tree,
        dirty: d.tree ? d.tree.dirty : 0,
        unpushed: d.tree && typeof d.tree.unpushed === 'number' ? d.tree.unpushed : 0,
        mergeState,
        reviewTag: d.claim ? d.claim.reviewTag : '',
        builtNote: d.claim ? d.claim.builtNote : '',
        tier: d.claim ? d.claim.tier : null,
        risk: d.claim ? d.claim.risk : '',
        area: d.claim ? d.claim.area : ((d.branchRep && d.branchRep.area) || ''),
        bucket: d.claim ? d.claim.bucket : '',
        subject: (d.branchRep && d.branchRep.subject) || (d.tree && d.tree.subject) || '',
        when: (d.branchRep && d.branchRep.when) || (d.tree && d.tree.when) || '',
        claimedWhen: d.claim ? d.claim.claimedWhen : '',
        flags,
      });
    }
  }

  const stageRank = (s: FeatureStage) => STAGES.indexOf(s);
  out.sort((a, b) => {
    if (a.stage === 'building' && b.stage !== 'building') return -1;
    if (b.stage === 'building' && a.stage !== 'building') return 1;
    const sr = stageRank(a.stage) - stageRank(b.stage);
    if (sr !== 0) return sr;
    if (a.ahead !== b.ahead) return b.ahead - a.ahead;
    return a.branch.localeCompare(b.branch);
  });

  return out;
}
