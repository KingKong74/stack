import { useCallback, useEffect, useState } from 'react';
import type { ProjectDetailData } from '../store';
import { getProjectDetail } from '../store';
import type { Future, RoadmapItem } from '../types';
import { go } from '../lib/route';
import PolarisTerm from '../components/PolarisTerm';

// The Polaris studio (#226) — the planning session promoted out of the Futures
// tab's expand panel onto its own screen: the claude session full-height on the
// left, and a live planning panel on the right — north star, the direction
// funnel, the open board queue and blockers — refreshed every 30s so items
// Polaris lands mid-conversation appear as the session goes. The terminal is
// the same tmux-backed PolarisTerm (device-local mapping keyed polaris:<slug>),
// so moving between the Futures tab entry and this screen re-attaches the same
// session. Default export so App can React.lazy this screen and keep xterm.js
// out of the main bundle.

const ALIGN_GROUPS = [
  { key: 'on-course', label: 'On course', tone: 'sage' },
  { key: '', label: 'Unsorted', tone: 'muted' },
  { key: 'tangent', label: 'Tangents', tone: 'building' },
  { key: 'off-course', label: 'Off course', tone: 'critical' },
] as const;

export default function PolarisStudio({ slug }: { slug: string }) {
  const [data, setData] = useState<ProjectDetailData | null>(null);
  const [error, setError] = useState('');
  const [syncedAt, setSyncedAt] = useState('');

  // Silent = a background tick; a failure there keeps the last good panel
  // rather than replacing it with an error the human didn't ask about.
  const load = useCallback(async (silent: boolean) => {
    try {
      const d = await getProjectDetail(slug);
      setData(d);
      setError('');
      setSyncedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : 'Could not load the project.');
    }
  }, [slug]);

  useEffect(() => {
    setData(null);
    setError('');
    load(false);
    const t = window.setInterval(() => { if (!document.hidden) load(true); }, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const open = (items: RoadmapItem[]) => items.filter((it) => !it.done);
  const road = data?.roadmap;
  const buckets = road ? [
    { label: 'Must', items: open(road.must) },
    { label: 'Should', items: open(road.should) },
    { label: 'Could', items: open(road.could) },
  ] : [];
  const allItems = road ? [...road.must, ...road.should, ...road.could, ...road.wont] : [];
  const toVerify = allItems.filter((it) => it.done && !it.reviewTag && !it.reviewShelved).length;

  const itemRow = (it: RoadmapItem) => (
    <a key={it.id} className="pol-item" href={`#/p/${encodeURIComponent(slug)}/roadmap?hl=${it.id}`}
      title={it.note || it.title}>
      <span className="item-num">#{it.id}</span>
      <span className="pol-item-t">{it.title}</span>
      {it.plan.length > 0 && (
        <span className="plan-chip">☰ {it.plan.filter((s) => s.done).length}/{it.plan.length}</span>
      )}
      {it.claimedBy && <span className="pol-claim" title={`Claimed by ${it.claimedBy}`}>⚑</span>}
      {it.area && <span className="area-chip">{it.area}</span>}
    </a>
  );

  const ideaRow = (f: Future) => (
    <a key={f.id} className="pol-item" href={`#/p/${encodeURIComponent(slug)}/futures?hl=${f.id}`}
      title={f.note || f.title}>
      <span className="pol-item-t">{f.title}</span>
      {f.area && <span className="area-chip">{f.area}</span>}
    </a>
  );

  return (
    <div className="pol-page">
      <div className="pol-head">
        <button className="btn-repo" onClick={() => go.detail(slug, 'futures')}
          title="Back to the project">← {data?.project.name || slug}</button>
        <div className="pol-title"><span className="glyph">✦</span>Polaris</div>
        <div className="pol-tag">planning studio — shape direction, pressure-test ideas, design the work</div>
        <div className="pol-sync">
          {syncedAt ? `board synced ${syncedAt}` : 'syncing board…'}
          <button className="pol-refresh" onClick={() => load(false)} title="Refresh the planning panel now">↻</button>
        </div>
      </div>

      {error && <div className="action-error">{error}</div>}

      <div className="pol-grid">
        <div className="pol-main">
          <PolarisTerm slug={slug} />
        </div>

        <div className="pol-side">
          <div className="pol-card north">
            <div className="pol-lbl">North star</div>
            {data ? (
              data.northStar
                ? <div className="pol-north-text">{data.northStar}</div>
                : <div className="pol-empty">No north star yet — a good first thing to ask Polaris to draft.</div>
            ) : <div className="pol-empty">loading…</div>}
          </div>

          <div className="pol-card">
            <div className="pol-lbl">Direction funnel</div>
            {data && ALIGN_GROUPS.map((g) => {
              const ideas = data.futures.filter((f) => (f.alignment || '') === g.key);
              if (ideas.length === 0) return null;
              return (
                <div className="pol-group" key={g.key || 'unsorted'}>
                  <div className={`pol-group-head ${g.tone}`}>
                    <span className="dot" />{g.label} <span className="n">{ideas.length}</span>
                  </div>
                  {ideas.slice(0, 6).map(ideaRow)}
                  {ideas.length > 6 && <div className="pol-more">… {ideas.length - 6} more on the Futures tab</div>}
                </div>
              );
            })}
            {data && data.futures.length === 0 && (
              <div className="pol-empty">The idea funnel is empty — directions agreed here land as futures.</div>
            )}
          </div>

          <div className="pol-card">
            <div className="pol-lbl">The board — open queue</div>
            {buckets.map((b) => b.items.length > 0 && (
              <div className="pol-group" key={b.label}>
                <div className="pol-group-head muted"><span className="dot" />{b.label} <span className="n">{b.items.length}</span></div>
                {b.items.slice(0, 8).map(itemRow)}
                {b.items.length > 8 && <div className="pol-more">… {b.items.length - 8} more on the Roadmap tab</div>}
              </div>
            ))}
            {data && buckets.every((b) => b.items.length === 0) && (
              <div className="pol-empty">Nothing open — work agreed with Polaris lands here as roadmap items.</div>
            )}
            {toVerify > 0 && (
              <a className="pol-verify" href={`#/p/${encodeURIComponent(slug)}/roadmap`}
                title="Completed items awaiting your verdict on the Reviews view">
                {toVerify} completed item{toVerify === 1 ? '' : 's'} awaiting review →
              </a>
            )}
          </div>

          {data && data.blockers.length > 0 && (
            <div className="pol-card">
              <div className="pol-lbl">Blockers</div>
              {data.blockers.map((b, i) => <div className="pol-blocker" key={i}>{b}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
