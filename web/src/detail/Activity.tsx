import type { Activity as ActivityItem } from '../types';
import { isAccentTag, PRODUCT_NAME } from '../lib/ui';

export function Activity({
  activity, highlightRef, linkedBugId, onClear,
}: {
  activity: ActivityItem[]; highlightRef: string | null; linkedBugId: string | null; onClear: () => void;
}) {
  return (
    <div>
      <div className="section-bar" style={{ marginBottom: 6 }}>
        <div className="titles">
          <div className="h">Activity</div>
          <span className="auto-badge">✦ auto-generated per push</span>
        </div>
      </div>
      <div className="subtitle" style={{ marginBottom: 20 }}>
        Every push to the repo posts a summary to the {PRODUCT_NAME} API — so you can scan what changed without reading diffs.
      </div>

      {highlightRef && linkedBugId && (
        <div className="linkbanner">
          <span className="txt">Showing the push linked from <span className="mono">{linkedBugId}</span></span>
          <button className="clear" onClick={onClear}>Clear</button>
        </div>
      )}

      {activity.length ? (
        <div className="timeline">
          <div className="rail" />
          <div className="items">
            {activity.map((a) => (
              <div className="tl" key={a.hash}>
                <div className="node" />
                <div className={`tl-card ${a.hash === highlightRef ? 'hl' : ''}`}>
                  <div className="top">
                    <span className="hash">{a.hash}</span>
                    <span className="branch">on {a.branch}</span>
                    {(a.tokens ?? 0) > 0 && (
                      <span className="branch" title="Real token usage for the session, from its transcript (#178)">
                        · {a.tokens! >= 1e6 ? `${(a.tokens! / 1e6).toFixed(1)}M` : `${Math.round(a.tokens! / 1000)}k`} tok
                      </span>
                    )}
                    <span className="when">{a.when}</span>
                  </div>
                  <div className="body">{a.summary}</div>
                  {a.geminiNote && (
                    <div className="gem-take">
                      <span className="star">✦</span>
                      <span className="who">Gemini</span>
                      {a.geminiNote}
                    </div>
                  )}
                  <div className="tags">
                    {a.tags.map((t, i) => <span key={i} className={`tag ${isAccentTag(t) ? 'accent' : ''}`}>{t}</span>)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <div className="big">No pushes yet</div>
          <div>Summaries appear here after your first push.</div>
        </div>
      )}
    </div>
  );
}
