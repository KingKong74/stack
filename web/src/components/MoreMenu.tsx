import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// THE ⋯ MENU — one component for every "a few more things you can do here".
//
// It exists because the alternative is a row of single-glyph buttons, and a
// lane head had grown three of them (✎ × ⇥) before anything was collapsed. A
// glyph must be guessed; a menu item says what it does in words.
//
// IT IS POSITIONED FIXED, and that is the whole reason this is a component
// rather than three lines of `position: absolute` at each call site. Both
// places that want it sit inside a scroll container that clips its own
// overflow — the rail (`overflow-y: auto`) and the board (`overflow-x: auto`)
// — so an absolutely-positioned popover is cut off by its own parent. Fixed
// escapes that, at the cost of not travelling with a scroll, which is why any
// scroll CLOSES it rather than leaving it stranded beside nothing.
//
// A DANGEROUS ITEM STILL CONFIRMS. This renders the trigger, never the
// consequence: "Remove lane" opens the caller's own two-press confirm exactly
// as the × did. A menu is a shorter path to an action, not a shorter path
// past a confirmation.

export type MenuOption = {
  key: string;
  label: string;
  onSelect: () => void;
  /** Drawn in the critical tone — this one removes something. */
  danger?: boolean;
  /** Leave the menu open after the press: for an item whose own label is the
      feedback ("Copy link" → "Link copied"), closing would hide the answer. */
  keepOpen?: boolean;
  title?: string;
};

const MENU_W = 184;

export function MoreMenu({ options, label = 'More options', btnClass = '', small }: {
  options: MenuOption[];
  /** What the trigger is called to a screen reader — name the thing it acts on. */
  label?: string;
  /** The trigger's own class, so a lane head and the rail can each dress it. */
  btnClass?: string;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);

  // Measured before paint, so the menu never shows up in the wrong corner for
  // a frame. Right-aligned to the trigger and flipped above it when there is
  // no room below — a menu that opens off the bottom of the window is a menu
  // with items nobody can reach.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const h = pop.current?.offsetHeight ?? options.length * 30 + 12;
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below;
    setAt({ top, left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); }
    };
    // Capture, because the scroll that moves this menu's anchor is usually a
    // container's, not the window's, and a container scroll does not bubble.
    const shut = () => setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', shut);
    };
  }, [open]);

  if (options.length === 0) return null;

  return (
    <>
      <button ref={btn} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        className={`moremenu-btn${small ? ' sm' : ''}${open ? ' on' : ''}${btnClass ? ` ${btnClass}` : ''}`}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(!open); }}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div ref={pop} className="moremenu-pop" role="menu" style={at ? { top: at.top, left: at.left } : { visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}>
          {options.map((o) => (
            <button key={o.key} type="button" role="menuitem" title={o.title}
              className={`moremenu-item${o.danger ? ' danger' : ''}`}
              onClick={() => { if (!o.keepOpen) setOpen(false); o.onSelect(); }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Absolute URL for a hash href — what "open in a new tab" and "copy link" both need. */
export function absoluteHref(href: string): string {
  return new URL(href, window.location.href).href;
}
