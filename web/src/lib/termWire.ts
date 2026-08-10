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
