import { useEffect, useState } from 'react';
import type { ProjectTree, TreeLane, TreeIdea, TreeAbsorbed } from '../types';
import { getProjectTree } from '../store';
import { go } from '../lib/route';
import { timeAgo } from '../lib/ui';

// Branch tree view (#72): renders the project's branch/idea structure as a
// visual tree — main trunk on the left spine, lane branches hanging right
// (each linked to its roadmap item), the idea funnel below, absorbed
// (landed) branches dimmed at the bottom. Pure CSS layout, no libraries.

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1000) return `${Math.round(n / 1000)}k tok`;
  return `${n} tok`;
}

const ALIGN_LABEL: Record<string, string> = {
  'on-course': 'on course',
  'tangent': 'tangent',
  'off-course': 'off course',
};

function LaneNode({ lane, slug }: { lane: TreeLane; slug: string }) {
  const isAuto = lane.branch.startsWith('auto/');
  const isLive = lane.live;
  const isStale = lane.state === 'stale';

  let stateClass = 'tree-lane-open';
  if (isLive) stateClass = 'tree-lane-live';
  else if (isStale) stateClass = 'tree-lane-stale';

  const openItem = () => go.detail(slug, 'roadmap', lane.itemId);

  return (
    <div className={`tree-node tree-lane ${stateClass}`}>
      <div className="tree-connector" aria-hidden="true">
        <span className="tree-elbow" />
      </div>
      <div className="tree-card" onClick={openItem} role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && openItem()}
        title={`Open roadmap item · ${lane.branch}`}>
        <div className="tree-card-head">
          <span className={`tree-state-dot ${stateClass}`} aria-hidden="true" />
          <span className="tree-branch-name">{lane.branch}</span>
          {isLive && <span className="tree-live-badge">live</span>}
          {isStale && <span className="tree-stale-badge">stale</span>}
          {isAuto && <span className="tree-auto-badge">⚙ auto</span>}
        </div>
        <div className="tree-card-title">{lane.itemTitle}</div>
        <div className="tree-card-meta">
          <span className={`tree-bucket tree-bucket-${lane.bucket}`}>{lane.bucket}</span>
        </div>
      </div>
    </div>
  );
}

function IdeaNode({ idea, slug }: { idea: TreeIdea; slug: string }) {
  const openIdea = () => go.detail(slug, 'futures', idea.id);
  const alignClass = idea.alignment ? `tree-idea-${idea.alignment}` : 'tree-idea-unsorted';

  return (
    <div className={`tree-node tree-idea ${alignClass}`}>
      <div className="tree-connector" aria-hidden="true">
        <span className="tree-elbow tree-elbow-idea" />
      </div>
      <div className="tree-card tree-idea-card" onClick={openIdea} role="button" tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && openIdea()}
        title={`Open idea · ${idea.alignment ? ALIGN_LABEL[idea.alignment] || idea.alignment : 'unsorted'}`}>
        <div className="tree-card-head">
          <span className="tree-idea-dot" aria-hidden="true" />
          <span className="tree-idea-title">{idea.title}</span>
        </div>
        {idea.alignment && (
          <div className="tree-idea-align">{ALIGN_LABEL[idea.alignment] || idea.alignment}</div>
        )}
      </div>
    </div>
  );
}

function AbsorbedNode({ run }: { run: TreeAbsorbed }) {
  return (
    <div className="tree-node tree-absorbed">
      <div className="tree-connector" aria-hidden="true">
        <span className="tree-elbow tree-elbow-abs" />
      </div>
      <div className="tree-card tree-absorbed-card"
        title={`Landed — merged into main${run.commits ? ` · ${run.commits} commit${run.commits === 1 ? '' : 's'}` : ''}`}>
        <div className="tree-card-head">
          <span className="tree-abs-dot" aria-hidden="true" />
          <span className="tree-branch-name tree-branch-abs">{run.branch}</span>
          <span className="tree-abs-badge">✓ landed</span>
        </div>
        <div className="tree-card-title tree-abs-title">{run.itemTitle}</div>
        <div className="tree-card-meta">
          {run.commits > 0 && <span>{run.commits} commit{run.commits === 1 ? '' : 's'}</span>}
          {run.tokens > 0 && <span>{fmtTok(run.tokens)}</span>}
          {run.when && <span>{timeAgo(run.when)}</span>}
        </div>
      </div>
    </div>
  );
}

// Placeholder nodes for empty sections — mirrors what stack-tree.mjs does.
function PlaceholderLane() {
  return (
    <div className="tree-node tree-lane tree-placeholder">
      <div className="tree-connector" aria-hidden="true">
        <span className="tree-elbow" />
      </div>
      <div className="tree-card tree-placeholder-card">
        <div className="tree-card-head">
          <span className="tree-state-dot tree-lane-open" style={{ opacity: 0.3 }} aria-hidden="true" />
          <span className="tree-branch-name" style={{ opacity: 0.4 }}>auto/item-N</span>
        </div>
        <div className="tree-card-title" style={{ opacity: 0.4 }}>No active lanes yet</div>
      </div>
    </div>
  );
}

function PlaceholderIdea() {
  return (
    <div className="tree-node tree-idea tree-placeholder">
      <div className="tree-connector" aria-hidden="true">
        <span className="tree-elbow tree-elbow-idea" />
      </div>
      <div className="tree-card tree-placeholder-card">
        <div className="tree-card-head">
          <span className="tree-idea-dot" style={{ opacity: 0.3 }} aria-hidden="true" />
          <span className="tree-idea-title" style={{ opacity: 0.4 }}>idea/example-direction</span>
        </div>
      </div>
    </div>
  );
}

export function BranchTree({ slug }: { slug: string }) {
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    getProjectTree(slug)
      .then((t) => { if (live) { setTree(t); setLoading(false); } })
      .catch((e) => { if (live) { setError(e?.message || 'Could not load tree.'); setLoading(false); } });
    return () => { live = false; };
  }, [slug]);

  if (loading) return <div className="tree-loading">Loading…</div>;
  if (error) return <div className="tree-error">{error}</div>;
  if (!tree) return null;

  const { lanes, ideas, absorbed } = tree;

  // Sort ideas: on-course first, unsorted middle, off-course last.
  const alignOrder = (a: string) =>
    a === 'on-course' ? 0 : a === 'tangent' ? 1 : a === 'off-course' ? 3 : 2;
  const sortedIdeas = [...ideas].sort((a, b) => alignOrder(a.alignment) - alignOrder(b.alignment));

  return (
    <div className="branch-tree">
      <div className="tree-subtitle">
        Branches hanging off main — active lanes, the idea funnel and recently landed work.
        Click any node to open the linked item.
      </div>

      {/* Trunk spine */}
      <div className="tree-trunk-row">
        <div className="tree-trunk-spine" aria-hidden="true" />
        <div className="tree-trunk-label">
          <span className="tree-trunk-dot" aria-hidden="true" />
          <span className="tree-trunk-name">main</span>
          <span className="tree-trunk-tag">trunk</span>
        </div>
      </div>

      {/* Active lane branches */}
      <section className="tree-section" aria-label="Active lanes">
        <div className="tree-section-head">
          <span className="tree-section-label">Lanes</span>
          <span className="tree-section-count">{lanes.length}</span>
        </div>
        <div className="tree-nodes">
          {lanes.length === 0 ? <PlaceholderLane /> : lanes.map((lane) => (
            <LaneNode key={lane.branch} lane={lane} slug={slug} />
          ))}
        </div>
      </section>

      {/* Idea funnel */}
      <section className="tree-section" aria-label="Idea funnel">
        <div className="tree-section-head">
          <span className="tree-section-label">Ideas</span>
          <span className="tree-section-count">{sortedIdeas.length}</span>
        </div>
        <div className="tree-nodes">
          {sortedIdeas.length === 0 ? <PlaceholderIdea /> : sortedIdeas.map((idea) => (
            <IdeaNode key={idea.id} idea={idea} slug={slug} />
          ))}
        </div>
      </section>

      {/* Absorbed (landed) branches */}
      {absorbed.length > 0 && (
        <section className="tree-section tree-section-absorbed" aria-label="Landed branches">
          <div className="tree-section-head">
            <span className="tree-section-label">Landed</span>
            <span className="tree-section-count">{absorbed.length}</span>
          </div>
          <div className="tree-nodes">
            {absorbed.map((run) => (
              <AbsorbedNode key={run.branch} run={run} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
