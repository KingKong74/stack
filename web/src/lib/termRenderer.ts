import type { Terminal as XTerm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

// How a Stack terminal actually gets PAINTED.
//
// xterm's default renderer builds a DOM node per styled run of characters, and
// a claude session is the worst possible input for it: a full-screen TUI that
// repaints its frame several times a second, every repaint tearing down and
// rebuilding a few hundred spans. That is the lag — not the websocket, not the
// pty. The WebGL renderer draws the same cells as textured quads on one canvas
// and does not touch the DOM at all, which is roughly an order of magnitude
// less work per frame and, more to the point, a CONSTANT amount of work: it
// does not get slower as the screen gets busier.
//
// Three things make it safe to just switch on:
//
//  • IT IS ALLOWED TO FAIL. No WebGL2 (a locked-down browser, a VM with no
//    GPU, a remote desktop) means the addon throws on load, and the terminal
//    keeps the DOM renderer it already had. A terminal that renders slowly is
//    a complaint; one that renders nothing is a broken product, so the attach
//    is wrapped and a failure is a log line, never a throw into React.
//  • A LOST CONTEXT IS NOT A DEAD TERMINAL. The browser takes the GL context
//    away whenever it likes — waking from sleep, switching GPUs, too many live
//    contexts on one page, which four panes plus a dock can genuinely hit. The
//    addon reports it, and the ONLY correct response is to dispose and fall
//    back: re-attaching immediately just loses it again in a loop, and doing
//    nothing leaves a terminal that is running fine and painting a blank
//    rectangle. That blank rectangle is the bug this handler exists for.
//  • DISPOSAL IS OURS TO ORDER. The addon must go before the terminal does;
//    disposing them the other way round leaves the GL context orphaned and is
//    how a page ends up refusing to give any pane a context at all.
export function attachRenderer(term: XTerm, onFallback?: (why: string) => void): () => void {
  let addon: WebglAddon | null = null;
  try {
    addon = new WebglAddon();
    // Fires when the browser revokes the GL context. Dispose and stay on the
    // DOM renderer for the life of this terminal — see above.
    addon.onContextLoss(() => {
      const dying = addon;
      addon = null;
      try { dying?.dispose(); } catch { /* already gone */ }
      onFallback?.('WebGL context lost — back on the DOM renderer.');
    });
    term.loadAddon(addon);
  } catch (e) {
    addon = null;
    onFallback?.(e instanceof Error ? e.message : 'WebGL unavailable');
  }
  return () => {
    const dying = addon;
    addon = null;
    try { dying?.dispose(); } catch { /* already gone */ }
  };
}
