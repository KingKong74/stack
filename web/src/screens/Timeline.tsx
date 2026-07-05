import { useEffect, useMemo, useState } from 'react';
import { getTimeline, AuthError, type TimelineData } from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME, isAccentTag } from '../lib/ui';
import { buildWeeks, contribLevel as level } from '../lib/contrib';

// The cross-project timeline: a year of pushes as a contribution grid (our own
// terracotta take, weeks starting Monday) over a vertical day-by-day feed of
// the last month. Entries click through to the push on its project's Activity
// tab.

export function Timeline() {
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getTimeline()
      .then(setData)
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Failed to load the timeline.'); });
  }, []);

  const weeks = useMemo(() => {
    if (!data) return [];
    return buildWeeks(new Map(data.graph.map((g) => [g.date, g.count])));
  }, [data]);

  return (
    <div>
      <div className="topbar">
        <div className="crumb">
          <span className="chev" onClick={go.dashboard}>‹</span>
          <span className="back" onClick={go.dashboard}>Projects</span>
          <span className="sep">/</span>
          <span className="here">Timeline</span>
        </div>
        <div className="right">
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail" style={{ maxWidth: 880 }}>
        <div className="dash-head" style={{ marginBottom: 24 }}>
          <div>
            <div className="dash-title">Timeline</div>
            <div className="dash-count">Every push, across every project.</div>
          </div>
        </div>

        {error && <div className="action-error">{error}</div>}

        {!data ? (
          !error && <div className="empty-state"><div className="big">Loading…</div></div>
        ) : (
          <>
            {/* the year in pushes — our contribution grid */}
            <div className="ctb">
              <div className="ctb-head">
                <span className="ctb-title">The year in pushes</span>
                <span className="ctb-total">{data.total} in the last 12 months</span>
              </div>
              <div className="ctb-grid" role="img" aria-label={`${data.total} pushes in the last 12 months`}>
                {weeks.map((week, wi) => (
                  <div className="ctb-col" key={wi}>
                    {week.map((day) => (
                      <span
                        key={day.date}
                        className={`ctb-cell ${day.future ? 'future' : `l${level(day.count)}`}`}
                        title={day.future ? '' : `${day.date} — ${day.count} push${day.count === 1 ? '' : 'es'}`}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <div className="ctb-legend">
                <span>quiet</span>
                <span className="ctb-cell l0" /><span className="ctb-cell l1" />
                <span className="ctb-cell l2" /><span className="ctb-cell l3" />
                <span>on a roll</span>
              </div>
            </div>

            {/* the last month, day by day */}
            {data.days.length ? (
              <div className="tld-list">
                {data.days.map((day) => (
                  <div className="tld" key={day.date}>
                    <div className="tld-head">
                      <span className="tld-label">{day.label}</span>
                      <span className="tld-count">{day.entries.length} push{day.entries.length === 1 ? '' : 'es'}</span>
                    </div>
                    {day.entries.map((e, i) => (
                      <button className="tld-row" key={`${e.hash}-${i}`}
                        onClick={() => go.detail(e.slug, 'activity', e.hash !== '—' ? e.hash : undefined)}>
                        <span className="tld-time">{e.time}</span>
                        <span className="tld-proj">
                          <span className="tld-dot" style={{ background: e.tint || 'var(--line-3)' }} />
                          {e.name}
                        </span>
                        <span className="tld-hash">{e.hash}</span>
                        <span className="tld-summary">{e.summary || '—'}</span>
                        <span className="tld-tags">
                          {e.tags.slice(0, 2).map((t, j) => (
                            <span key={j} className={`tag ${isAccentTag(t) ? 'accent' : ''}`}>{t}</span>
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="big">A quiet month</div>
                <div>Pushes from the last 30 days will appear here.</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
