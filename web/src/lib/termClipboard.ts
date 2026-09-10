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
//
// RIGHT-CLICK is the mintty gesture, added because ⌃⇧C/⌃V is not what anyone's
// hands do: copy when there is a selection, paste when there is not, and the
// context menu suppressed because a terminal has no use for one. Shift keeps
// the real menu. Its paste half is the ONE path here that asks to read the
// clipboard, so it is the one path that can be refused — and when it is, the
// pane says so and names ⌃V rather than leaving a dead button.

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

// Write to the clipboard, honestly reporting whether it landed.
// The async Clipboard API is unavailable on an insecure origin — Stack over
// plain http on the LAN is exactly that — so the old execCommand path stays as
// the fallback rather than leaving a whole class of device unable to copy.
// A browser is not a terminal emulator, which is why these three rules look odd:
// Ctrl-C copies ONLY while a selection exists (so the next press is still a real
// SIGINT); Ctrl-V returns false WITHOUT preventDefault, so the browser's own
// paste event reaches xterm's bracketed-paste handler — reading the clipboard
// ourselves would need a permission Firefox never grants; and an OSC 52 '?'
// payload, the host asking to READ the clipboard, is never answered.

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
// that created the terminal.
//
// `notice` is how the pane says what happened. With a canvas and no browser
// selection to look at, a copy that worked and one the browser refused are
// indistinguishable — and a paste the browser refused is worse, because the
// user's next keystroke goes into a session they think already has the text.
// Everything below that can fail reports through it.
export function wireTermClipboard(
  term: XTerm,
  notice?: (label: string) => void,
): () => void {
  const copy = async (text: string) => {
    if (!text) return;
    if (await copyText(text)) {
      const lines = text.split('\n').length;
      notice?.(lines > 1 ? `copied ${lines} lines` : `copied ${text.length} chars`);
    } else {
      notice?.('copy blocked by the browser');
    }
  };

  // 1. A finished selection copies itself. The gesture people actually make.
  //    Only when the drag STARTED in this terminal: a click elsewhere on the
  //    page must not re-copy a selection this pane happens to still hold.
  let dragging = false;
  const el = term.element;
  const onDown = (ev: MouseEvent) => { if (ev.button === 0) dragging = true; };
  const onUp = (ev: MouseEvent) => {
    if (!dragging || ev.button !== 0) return;
    dragging = false;
    if (term.hasSelection()) void copy(term.getSelection());
  };
  el?.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);

  // 2. RIGHT-CLICK: copy if something is selected, otherwise paste. The mintty
  //    /Windows-Terminal gesture, and the one the owner asked for — with a
  //    terminal there is no other use for a context menu, so the menu is
  //    suppressed and the button does the useful thing instead.
  //
  //    The copy half needs no permission (writing the clipboard is free after
  //    a user gesture). The PASTE half needs clipboard-READ, which Chrome
  //    prompts for once and Firefox does not grant at all — so it is offered,
  //    and when it is refused the pane SAYS so and names ⌃V, which always
  //    works because it rides the browser's own paste event. A right-click
  //    that quietly did nothing would read as the terminal being broken.
  const onContext = (ev: MouseEvent) => {
    // Shift-right-click is the escape hatch to the browser's real menu
    // (inspect, save) — the same convention every terminal emulator uses.
    if (ev.shiftKey) return;
    ev.preventDefault();
    if (term.hasSelection()) {
      const text = term.getSelection();
      term.clearSelection();
      void copy(text);
      return;
    }
    void (async () => {
      let text = '';
      try { text = (await navigator.clipboard?.readText?.()) || ''; }
      catch { notice?.('paste needs ⌃V here'); return; }
      if (!text) { notice?.('clipboard is empty'); return; }
      // term.paste, not term.input: it wraps the text in bracketed-paste
      // markers when the program asked for them, which is what stops a
      // multi-line paste being run line by line as it arrives.
      term.paste(text);
      const lines = text.split('\n').length;
      notice?.(lines > 1 ? `pasted ${lines} lines` : `pasted ${text.length} chars`);
    })();
  };
  el?.addEventListener('contextmenu', onContext);

  // 3. MIDDLE-CLICK is left alone on purpose. On X11 it pastes the PRIMARY
  //    selection, which a browser cannot read; intercepting it to paste the
  //    clipboard instead would make the same button do two different things
  //    depending on which window you are in. Better to not answer than to
  //    answer wrongly.

  // 4. The keyboard. ⌃⇧C / ⌘C copy; ⌃C copies only when there is something to
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

  // 5. OSC 52 — the host asking the terminal to set the clipboard. This is how
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
    el?.removeEventListener('contextmenu', onContext);
    window.removeEventListener('mouseup', onUp);
    osc.dispose();
  };
}
