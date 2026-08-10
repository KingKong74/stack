import { useEffect, useMemo, useState } from 'react';
import { getTimeline, AuthError, type TimelineData } from '../store';
import { go } from '../lib/route';
import { PRODUCT_NAME, isAccentTag } from '../lib/ui';
import { buildWeeks, contribLevel as level } from '../lib/contrib';

// The cross-project timeline: a year of pushes as a contribution grid (our own
// terracotta take, weeks starting Monday) over a vertical day-by-day feed that
// opens tight — 3 days — and widens on request via the Extend button, rather
// than loading a month of entries nobody asked to see. Entries click through
// to the push on its project's Activity tab.

// Opens on the last 3 days; each Extend press asks for 4 more.
const INITIAL_WINDOW_DAYS = 3;
const EXTEND_STEP_DAYS = 4;

export function Timeline() {
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState('');
  const [winDays, setWinDays] = useState(INITIAL_WINDOW_DAYS);
  const [extending, setExtending] = useState(false);

  useEffect(() => {
    getTimeline({ days: INITIAL_WINDOW_DAYS })
      .then(setData)
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Failed to load the timeline.'); });
  }, []);

  function handleExtend() {
    if (extending) return;
    const next = winDays + EXTEND_STEP_DAYS;
    setExtending(true);
    getTimeline({ days: next, graph: false })
      .then((res) => {
        // Refetch-and-replace, not append: this is what keeps repeated Extend
        // presses idempotent. Widening the window and re-asking for the whole
        // range means a day group can never be duplicated or dropped, however
        // many times the button is pressed.
        setData((prev) => ({ ...res, graph: prev ? prev.graph : res.graph, total: prev ? prev.total : res.total }));
        setWinDays(next);
        setError('');
      })
      .catch((e) => { if (!(e instanceof AuthError)) setError((e as Error)?.message || 'Failed to load the timeline.'); })
      .finally(() => setExtending(false));
  }

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
          <button className="btn-repo" onClick={go.control} title="Mission Control">Mission Control</button>
          <div className="brandmark"><span className="sq" /><span className="word">{PRODUCT_NAME}</span></div>
        </div>
      </div>

      <div className="page detail">
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

            {/* the current window, day by day */}
            {data.days.length ? (
              <div className="tld-list">
                {data.days.map((day) => (
                  <div className="tld" key={day.date}>
                    <div className="tld-head">
                      <span className="tld-label">{day.label}</span>
                      {/* Two counts, never one total: a push landed and a fly
                          card only began. Adding them would read as a busier
                          day than actually happened (#381). */}
                      <span className="tld-count">
                        {day.entries.length} push{day.entries.length === 1 ? '' : 'es'}
                        {/* The explicit space matters: JSX drops the newline
                            between the text and the span, so without it this
                            renders "1 push· 1 card opened". */}
                        {!!day.flies?.length && ' '}
                        {!!day.flies?.length && (
                          <span className="tld-flies">
                            · {day.flies.length} card{day.flies.length === 1 ? '' : 's'} opened
                          </span>
                        )}
                      </span>
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
                        <span className="tld-summary">
                          {e.summary || '—'}
                          {e.geminiNote && <span className="tld-gem">✦ {e.geminiNote}</span>}
                        </span>
                        <span className="tld-tags">
                          {e.tags.slice(0, 2).map((t, j) => (
                            <span key={j} className={`tag ${isAccentTag(t) ? 'accent' : ''}`}>{t}</span>
                          ))}
                        </span>
                      </button>
                    ))}
                    {/* #381 — what live sessions STARTED that day, under the
                        pushes rather than mixed into them. Each row clicks
                        through to the card on the Roadmap tab, which is where
                        it gets signed off, reviewed or reworked. */}
                    {day.flies?.map((f) => (
                      <button className="tld-row fly" key={`fly-${f.id}`}
                        onClick={() => go.detail(f.slug, 'roadmap', String(f.id))}>
                        <span className="tld-time">{f.time}</span>
                        <span className="tld-proj">
                          <span className="tld-dot" style={{ background: f.tint || 'var(--line-3)' }} />
                          {f.name}
                        </span>
                        <span className="tld-hash">⚡ #{f.id}</span>
                        <span className="tld-summary">
                          {f.title}
                          <span className="tld-fly-by">
                            opened by {f.session || 'an unnamed session'}
                          </span>
                        </span>
                        <span className="tld-tags">
                          {/* The state that decides what you do about it: an
                              unsigned card is one you still owe a decision. */}
                          {f.done
                            ? <span className="tag">done</span>
                            : f.reviewed
                              ? <span className="tag">signed off</span>
                              : <span className="tag accent">awaiting sign-off</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="big">Quiet stretch</div>
                <div>No pushes in the last {data.windowDays} day{data.windowDays === 1 ? '' : 's'}.</div>
              </div>
            )}

            {data.capped && (
              <div className="tld-capped">
                Capped — the {data.days.reduce((n, d) => n + d.entries.length, 0)} most recent pushes in this window are shown.
              </div>
            )}
            {data.hasMore ? (
              <div className="tld-more">
                <span className="tld-more-cap">Showing the last {data.windowDays} days</span>
                <button className="btn-repo sm" disabled={extending} onClick={handleExtend}>
                  {extending ? 'Extending…' : 'Extend'}
                </button>
              </div>
            ) : (
              <div className="empty-soft tld-end">That's every push on record.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
