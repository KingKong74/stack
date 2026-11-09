import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Choosing a tracked project fills its slug; arbitrary paths and blank (home)
// remain valid. Selection only changes the directory, never starts a session.
export function TerminalDirectoryPicker({ value, projects, onChange, onSubmit }: {
  value: string;
  projects: { id: string; name: string }[];
  onChange: (value: string) => void;
  onSubmit?: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [filter, setFilter] = useState(false);
  const [active, setActive] = useState(-1);
  const query = filter ? value.toLowerCase().trim() : '';
  const options = [{ id: '', name: 'Home' }, ...projects]
    .filter((p) => !query || `${p.name} ${p.id}`.toLowerCase().includes(query));
  const choose = (path: string) => {
    onChange(path);
    setOpen(false);
    setActive(-1);
    input.current?.focus();
  };
  // The terminal toolbar clips overflow; render the menu above that boundary.
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const r = root.current.getBoundingClientRect();
    setPosition({ top: r.bottom + 4, left: Math.max(16, Math.min(r.right - 260, window.innerWidth - 276)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setActive(-1); };
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) close();
    };
    const scroll = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || !root.current) return;
      const r = root.current.getBoundingClientRect();
      setPosition({ top: r.bottom + 4, left: Math.max(16, Math.min(r.right - 260, window.innerWidth - 276)) });
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  return (
    <div ref={root} className="tv-directory" onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) { setOpen(false); setActive(-1); }
    }}>
      <div className="tv-path">
        <span className="pre">~/</span>
        <input ref={input} value={value} spellCheck={false} autoComplete="off"
          role="combobox" aria-label="Directory for new sessions" aria-autocomplete="list"
          aria-expanded={open} aria-controls={id}
          aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
          title="Choose a project or type any directory. Blank is home."
          onChange={(e) => {
            onChange(e.target.value.replace(/^~\//, ''));
            setFilter(true); setOpen(true); setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              const next = !options.length ? -1 : active < 0
                ? (e.key === 'ArrowDown' ? 0 : options.length - 1)
                : (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
              setActive(next);
              if (next >= 0) requestAnimationFrame(() => document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' }));
            } else if (e.key === 'Escape') {
              e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (open && active >= 0 && options[active]) choose(options[active].id);
              else { setOpen(false); onSubmit?.(); }
            }
          }} />
        <button type="button" className="tv-directory-toggle" aria-label="Choose project directory"
          aria-expanded={open} aria-controls={id}
          onClick={() => { setFilter(false); setActive(-1); setOpen(!open); input.current?.focus(); }}>▾</button>
      </div>
      {open && createPortal(
        <div ref={menu} className="tv-directory-menu" style={position} id={id} role="listbox" aria-label="Project directories">
          {options.map((p, i) => (
            <button type="button" key={p.id} id={`${id}-${i}`} role="option"
              aria-selected={i === active} className={i === active ? 'on' : ''}
              onMouseDown={(e) => e.preventDefault()} onClick={() => choose(p.id)}>
              <span>{p.name}</span><small>~/{p.id}</small>
            </button>
          ))}
          {!options.length && <div className="tv-directory-empty">No matching project. You can still use this path.</div>}
        </div>, document.body
      )}
    </div>
  );
}
