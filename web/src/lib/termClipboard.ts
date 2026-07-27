import type { Terminal as XTerm } from '@xterm/xterm';

// Copy and paste for the web terminals.
//
// A browser is not a terminal emulator, so none of this comes for free — and
// three separate things had to be true before "select some lines and copy
// them" worked at all:
//
//  • the selection has to REACH xterm. Claude sessions run inside tmux with
//    `mouse on` (that is what makes the wheel scroll tmux's own history), so a
//    plain drag belongs to tmux, not to xterm: it lands in a tmux paste buffer
//    the browser cannot see, which is exactly what "I highlighted it and
//    nothing copied" looks like. tmux's `set-clipboard on`
//    (terminal/tmux-session.mjs) makes it emit whatever it copied as OSC 52,
//    and the handler below turns that into a real clipboard write. Shift-drag
//    still bypasses mouse reporting and selects inside xterm directly, and a
//    shell tab (no tmux) always selected normally.
//  • the selection has to reach the CLIPBOARD. xterm draws to a canvas, so the
//    browser's own copy has nothing to take from the page. Releasing a
//    selection copies it, and ⌃⇧C (⌘C on a Mac) copies explicitly.
//  • ⌃C must still interrupt. It copies ONLY while a selection exists, and
//    clears the selection as it does — so the next press is SIGINT, as always.
//
// Paste is the one case where the browser knows better than we do: the ⌃V /
// ⌃⇧V / ⌘V handlers return false WITHOUT preventing the default, so the native
// paste event reaches xterm's own handler — bracketed-paste aware, and needing
// no clipboard-READ permission (which Firefox does not grant at all).

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

// Write to the clipboard, honestly reporting whether it landed.
// The async Clipboard API is unavailable on an insecure origin — Stack over
// plain http on the LAN is exactly that — so the old execCommand path stays as
// the fallback rather than leaving a whole class of device unable to copy.
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* denied, or no transient activation — try the fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    const restore = document.activeElement as HTMLElement | null;
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    restore?.focus?.();
    return ok;
  } catch {
    return false;
  }
}

// Wire copy/paste into one xterm instance. Returns a disposer for the effect
// that created the terminal. onCopy fires for anything that actually reached
// the clipboard, so a pane can say so — with a canvas and no visible browser
// selection, "did that copy?" is otherwise unanswerable.
export function wireTermClipboard(term: XTerm, onCopy?: (text: string) => void): () => void {
  const copy = async (text: string) => {
    if (!text) return;
    if (await copyText(text)) onCopy?.(text);
  };

  // 1. A finished selection copies itself. The gesture people actually make.
  //    Only when the drag STARTED in this terminal: a click elsewhere on the
  //    page must not re-copy a selection this pane happens to still hold.
  let dragging = false;
  const el = term.element;
  const onDown = () => { dragging = true; };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    if (term.hasSelection()) void copy(term.getSelection());
  };
  el?.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);

  // 2. The keyboard. ⌃⇧C / ⌘C copy; ⌃C copies only when there is something to
  //    copy and then gets out of the way; paste falls through to the browser.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    if (!mod || ev.altKey) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c' || key === 'insert') {
      if (!term.hasSelection()) return true; // nothing selected — ⌃C is SIGINT
      const text = term.getSelection();
      term.clearSelection();
      void copy(text);
      ev.preventDefault();
      return false;
    }
    if (key === 'v') return false; // let the native paste event through
    return true;
  });

  // 3. OSC 52 — the host asking the terminal to set the clipboard. This is how
  //    a tmux copy-mode selection (i.e. an ordinary mouse drag in a claude
  //    session) reaches the browser at all.
  const osc = term.parser.registerOscHandler(52, (payload) => {
    const semi = payload.indexOf(';');
    if (semi < 0) return true;
    const b64 = payload.slice(semi + 1);
    // '?' is the host READING the clipboard. Never answer it: the daemon has
    // no business learning what the browser has copied.
    if (!b64 || b64 === '?') return true;
    let text = '';
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      text = new TextDecoder().decode(bytes);
    } catch { return true; }
    void copy(text);
    return true;
  });

  return () => {
    el?.removeEventListener('mousedown', onDown);
    window.removeEventListener('mouseup', onUp);
    osc.dispose();
  };
}
