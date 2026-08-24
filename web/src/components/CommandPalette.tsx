import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SearchResponse, SearchResult } from '../types';
import { getSearch, AuthError } from '../store';
import { go } from '../lib/route';

// The ⌘K command palette: a centred modal over a dimmed, blurred backdrop.
// Searches across every project (names, bugs, roadmap, notes, activity) via
// GET /api/search, debounced. Full keyboard control: type to search, ↑↓ to move
// the selection across groups, ↵ to open (navigating to the item's project + tab
// and flagging it via the existing highlight mechanism), esc to close. Scope
// chips filter by kind. Focus is trapped while open and restored on close.

type Scope = 'all' | 'bugs' | 'roadmap' | 'notes' | 'activity';

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'bugs', label: 'Bugs' },
  { key: 'roadmap', label: 'Roadmap' },
  { key: 'notes', label: 'Notes' },
  { key: 'activity', label: 'Activity' },
];

// Group render order. Projects only ever show under the "All" scope.
const GROUP_ORDER: { key: keyof SearchResponse['groups']; label: string }[] = [
  { key: 'projects', label: 'Projects' },
  { key: 'bugs', label: 'Bugs' },
  { key: 'roadmap', label: 'Roadmap' },
  { key: 'notes', label: 'Notes' },
  { key: 'activity', label: 'Activity' },
];

const KIND_ICON: Record<SearchResult['kind'], string> = {
  project: '▦', bug: '!', roadmap: '◆', note: '✎', activity: '↗',
};

// Wrap each case-insensitive occurrence of the query in <mark> (terracotta).
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i <= text.length) {
    const j = lower.indexOf(lq, i);
    if (j < 0) { out.push(text.slice(i)); break; }
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={k++} className="cmdk-mark">{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  return out;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  // Reset + focus on open; restore focus on close.
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement;
      setQuery(''); setDebounced(''); setScope('all');
      setData(null); setError(''); setSelected(0);
      // focus after paint
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    const el = restoreRef.current as HTMLElement | null;
    if (el && typeof el.focus === 'function') el.focus();
  }, [open]);

  // Debounce the query.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 170);
    return () => clearTimeout(t);
  }, [query]);

  // Fetch on debounced query change (race-guarded). Empty query → nothing.
  useEffect(() => {
    if (!open) return;
    if (!debounced) { setData(null); setError(''); setLoading(false); return; }
    let live = true;
    setLoading(true);
    getSearch(debounced)
      .then((r) => { if (live) { setData(r); setError(''); } })
      .catch((e) => { if (live && !(e instanceof AuthError)) setError(e?.message || 'Search failed.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [debounced, open]);

  // The flat, ordered list of currently-visible results (selection runs across
  // groups). Projects only appear under "All".
  const flat = useMemo(() => {
    if (!data) return [] as SearchResult[];
    const out: SearchResult[] = [];
    for (const g of GROUP_ORDER) {
      if (g.key === 'projects' && scope !== 'all') continue;
      if (scope !== 'all' && g.key !== scope) continue;
      out.push(...data.groups[g.key]);
    }
    return out;
  }, [data, scope]);

  // Keep the selection in range and scrolled into view.
  useEffect(() => { setSelected(0); }, [debounced, scope]);
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected, flat.length]);

  if (!open) return null;

  const openResult = (r: SearchResult | undefined) => {
    if (!r) return;
    go.detail(r.target.slug, r.target.tab, r.target.highlight ?? undefined);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, Math.max(flat.length - 1, 0))); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); openResult(flat[selected]); return; }
    if (e.key === 'Tab') {
      // Trap focus within the palette.
      const focusables = containerRef.current?.querySelectorAll<HTMLElement>(
        'input, button, [tabindex]:not([tabindex="-1"])');
      if (!focusables || !focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
  };

  const counts = data?.counts;
  const chipCount = (key: Scope) =>
    !counts ? 0 : key === 'all' ? counts.total : counts[key];

  // Build the rendered groups, tracking the running flat index for selection.
  let idx = 0;
  const renderGroups = GROUP_ORDER
    .filter((g) => !(g.key === 'projects' && scope !== 'all'))
    .filter((g) => scope === 'all' || g.key === scope)
    .map((g) => ({ ...g, items: data ? data.groups[g.key] : [] }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div
        className="cmdk"
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-input-row">
          <span className="cmdk-glass" aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search projects, bugs, roadmap, notes, activity…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search query"
          />
          <span className="cmdk-esc">esc</span>
        </div>

        <div className="cmdk-scopes">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              className={`cmdk-scope ${scope === s.key ? 'on' : ''}`}
              onClick={() => setScope(s.key)}
            >
              {s.label}{data ? <span className="cmdk-scope-n">{chipCount(s.key)}</span> : null}
            </button>
          ))}
        </div>

        <div className="cmdk-results" ref={listRef}>
          {!debounced ? (
            <div className="cmdk-hint">Type to search across every project.</div>
          ) : error ? (
            <div className="cmdk-hint cmdk-error">{error}</div>
          ) : loading && !data ? (
            <div className="cmdk-hint">Searching…</div>
          ) : flat.length === 0 ? (
            <div className="cmdk-hint">No matches for “{debounced}”.</div>
          ) : (
            renderGroups.map((g) => (
              <div className="cmdk-group" key={g.key}>
                <div className="cmdk-group-head">{g.label}</div>
                {g.items.map((r) => {
                  const myIdx = idx++;
                  const sel = myIdx === selected;
                  return (
                    <button
                      key={`${r.kind}-${r.slug}-${r.target.tab}-${r.target.highlight ?? ''}-${myIdx}`}
                      data-idx={myIdx}
                      className={`cmdk-row ${sel ? 'sel' : ''}`}
                      onMouseEnter={() => setSelected(myIdx)}
                      onClick={() => openResult(r)}
                    >
                      <span className={`cmdk-ico kind-${r.kind}`} aria-hidden="true">{KIND_ICON[r.kind]}</span>
                      <span className="cmdk-row-main">
                        <span className="cmdk-row-title">{highlight(r.title, debounced)}</span>
                        <span className="cmdk-row-proj">
                          <span className="cmdk-dot" style={{ background: r.tint || '#dcdac9' }} />
                          {r.name}
                        </span>
                      </span>
                      {r.meta && <span className="cmdk-meta">{r.meta}</span>}
                      <span className="cmdk-enter" aria-hidden="true">↵</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-foot">
          <div className="cmdk-foot-hints">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>⌘K</kbd> toggle</span>
            <span><kbd>esc</kbd> close</span>
          </div>
          {data && data.counts.total > 0 && (
            <div className="cmdk-foot-count">
              {data.counts.total} {data.counts.total === 1 ? 'result' : 'results'} across {data.projectCount}{' '}
              {data.projectCount === 1 ? 'project' : 'projects'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
