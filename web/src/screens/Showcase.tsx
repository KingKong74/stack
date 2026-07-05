import { useEffect, useState } from 'react';
import { getShowcase, type Showcase as ShowcaseData } from '../store';
import { PRODUCT_NAME, isAccentTag } from '../lib/ui';

const STATUS_LABEL = { live: 'Live', building: 'Building', paused: 'Paused', archived: 'Archived' } as const;

// The public showcase: a tokenless, read-only view of one project (overview +
// activity), reached via a share link. No gate, no navigation into the app —
// this is the shop window, not the workbench.
export function Showcase({ slug, token }: { slug: string; token: string }) {
  const [data, setData] = useState<ShowcaseData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    getShowcase(slug, token)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError((e as Error)?.message || 'Could not load this showcase.'); });
    return () => { live = false; };
  }, [slug, token]);

  if (error) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="brandmark" style={{ marginBottom: 18 }}>
            <span className="sq" /><span className="word">{PRODUCT_NAME}</span>
          </div>
          <div className="gate-title">Nothing here</div>
          <div className="gate-sub">{error}</div>
        </div>
      </div>
    );
  }
  if (!data) return <div className="empty-state" style={{ paddingTop: 80 }}><div className="big">Loading…</div></div>;

  return (
    <div>
      <div className="topbar">
        <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        <div className="right"><span className="show-badge">Shared view · read-only</span></div>
      </div>

      <div className="page detail" style={{ maxWidth: 860 }}>
        <div className="detail-head">
          <div>
            <div className="titlerow">
              <div className="detail-title">{data.name}</div>
              <span className={`statusbadge ${data.status}`}><span className="dot" />{STATUS_LABEL[data.status]}</span>
            </div>
            {data.subtitle && <div className="detail-sub">{data.subtitle}</div>}
          </div>
          {data.siteUrl && (
            <div className="head-actions">
              <button className="btn-accent" onClick={() => window.open(data.siteUrl, '_blank', 'noopener')}>
                Visit site <span style={{ fontSize: 12 }}>↗</span>
              </button>
            </div>
          )}
        </div>

        <div className="show-progress">
          <div className="show-progress-track"><div className="show-progress-fill" style={{ width: `${data.progress}%` }} /></div>
          <div className="show-progress-meta">
            <span>{data.progress}% of the current round</span>
            {data.lastPush && <span>last push {data.lastPush}</span>}
          </div>
        </div>

        {(data.summary || data.currentPhase) && (
          <div className="show-card">
            {data.currentPhase && <div className="show-phase">{data.currentPhase}</div>}
            {data.summary && <div className="show-summary">{data.summary}</div>}
            {data.techStack.length > 0 && (
              <div className="techchips" style={{ marginTop: 14 }}>
                {data.techStack.map((t, i) => <span key={i} className="techchip">{t}</span>)}
              </div>
            )}
          </div>
        )}

        <div className="section-bar" style={{ margin: '30px 0 6px' }}>
          <div className="titles"><div className="h">Recent activity</div></div>
        </div>
        {data.activity.length ? (
          <div className="timeline">
            <div className="rail" />
            <div className="items">
              {data.activity.map((a) => (
                <div className="tl" key={a.hash}>
                  <div className="node" />
                  <div className="tl-card">
                    <div className="top">
                      <span className="hash">{a.hash}</span>
                      <span className="branch">on {a.branch}</span>
                      <span className="when">{a.when}</span>
                    </div>
                    <div className="body">{a.summary}</div>
                    <div className="tags">
                      {a.tags.map((t, i) => <span key={i} className={`tag ${isAccentTag(t) ? 'accent' : ''}`}>{t}</span>)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="empty-state"><div className="big">No pushes yet</div></div>
        )}

        <div className="show-foot">Shared from {PRODUCT_NAME} — a self-hosted side-project command centre.</div>
      </div>
    </div>
  );
}
