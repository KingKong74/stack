// What every xterm in Stack shares: the wire codec and the colour scheme.
//
// There are two terminals now — the Terminal screen's tabs and each tab agent's
// console (#379) — and both talk the same protocol to the same daemon. These
// three things were the parts that would have been copied: a base64 pair that
// has to agree byte for byte with the daemon's, and a palette that is the whole
// visual identity of a Stack terminal. A second spelling of either is a bug
// nobody notices until the two look or behave differently.
//
// Nothing else moved. The frame handling, the write batching and the resize
// arithmetic stay with their screens, because they are about how a particular
// surface is laid out rather than about the wire.

// The daemon sends and receives payloads base64'd, so binary output survives
// JSON. TextEncoder/atob rather than Buffer: this is browser code.
export const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export const b64decode = (s: string) => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

// mintty's default palette — the git-bash look. Deliberately NOT Stack's own
// palette: a terminal that recolours what a program prints is lying about its
// output, and every tool anyone runs in here was written against these sixteen.
export const GIT_BASH_THEME = {
  background: '#000000',
  foreground: '#bfbfbf',
  cursor: '#bfbfbf',
  selectionBackground: '#264f78',
  black: '#000000', red: '#bf0000', green: '#00bf00', yellow: '#bfbf00',
  blue: '#4040bf', magenta: '#bf00bf', cyan: '#00bfbf', white: '#bfbfbf',
  brightBlack: '#404040', brightRed: '#ff4040', brightGreen: '#40ff40',
  brightYellow: '#ffff40', brightBlue: '#6060ff', brightMagenta: '#ff40ff',
  brightCyan: '#40ffff', brightWhite: '#ffffff',
};

// The rest of the git-bash box: the font and the handful of constructor
// options that decide how it FEELS rather than what it says.
//
// The font stack is the part that had a real bug in it. It led with Consolas
// and then `'Courier New'`, so every client without Consolas — which is every
// Linux and most Macs — landed on Courier New: a thin, wide, metrically
// unrelated face that makes box-drawing characters (claude's own frames, tmux's
// borders, every progress bar) fail to join up. That is most of what "the
// terminal looks buggy" actually was. The order now runs the mintty faces
// first, then each platform's real terminal face, and `ui-monospace` — which
// resolves to SF Mono / Cascadia / the system's own — ahead of the Courier
// fallback that should only ever be the last resort.
export const TERM_FONT =
  "Consolas, 'Lucida Console', 'Cascadia Mono', 'DejaVu Sans Mono', 'Liberation Mono', ui-monospace, Menlo, monospace";

// Shared xterm constructor options. Every one of these is a decision:
//
//  • `scrollback` MATCHES TMUX'S history-limit (20000, set in
//    terminal/tmux-session.mjs). They are two different buffers holding the
//    same output and a mismatch shows: xterm's default of 1000 meant a shell
//    tab lost its history a screenful later than the claude tab beside it, for
//    no reason anyone could see.
//  • `minimumContrastRatio: 1` turns OFF xterm's automatic recolouring. The
//    palette comment above says a terminal that recolours what a program
//    prints is lying about its output; xterm will quietly do exactly that to
//    dim text unless it is told not to.
//  • `fastScrollModifier: 'shift'` — shift-scroll jumps a page. It is also the
//    modifier that bypasses tmux mouse reporting, so the same gesture that
//    selects text is the one that scrolls fast, which is what mintty does.
//  • `allowProposedApi` is what the renderer addons need to attach at all.
export const TERM_OPTIONS = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: TERM_FONT,
  theme: GIT_BASH_THEME,
  scrollback: 20000,
  minimumContrastRatio: 1,
  drawBoldTextInBrightColors: true,
  fastScrollModifier: 'shift' as const,
  scrollSensitivity: 3,
  allowProposedApi: true,
  // A URL is a link. xterm underlines what it recognises either way; without
  // this the underline is a lie the user clicks at.
  linkHandler: {
    activate: (_e: MouseEvent, uri: string) => {
      // Only ever http(s), and only ever a new tab with no opener: the text
      // came off a pty, which is to say from whatever a program decided to
      // print, and `javascript:` in a terminal is somebody else's script.
      if (!/^https?:\/\//i.test(uri)) return;
      window.open(uri, '_blank', 'noopener,noreferrer');
    },
  },
};
