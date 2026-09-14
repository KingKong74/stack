// Dragging a file onto a terminal pane (#511).
//
// On a native terminal the gesture is: drop a screenshot, get its PATH typed
// at the cursor. That is how anyone hands Claude Code an image, and a web
// terminal cannot do it for free — the file the browser holds has never
// existed on the host, so there is no path to type yet. The exchange is
// therefore: bytes out on the session's own socket, a path back, and the path
// typed as if it had been keyed in (see terminal/drop-file.mjs for what the
// host does in between).
//
// Everything here is the browser half, kept out of the pane component because
// it is all decisions rather than layout:
//
//  • WHAT COUNTS AS A FILE DRAG. A drag of selected text inside the page, or
//    of one of Stack's own draggable rows, must not light the pane up — those
//    carry no `Files` type, so that is what is asked. Asked on dragOVER as
//    well as drop, because a dragover that is not prevent-default'd is a drop
//    the browser refuses, and a page that swallows text drags would break
//    every other drag on the screen.
//  • THE CAP IS CHECKED BEFORE A BYTE IS READ. The host enforces it too (it
//    is the one that writes), but a 40 MB video should fail as a sentence in
//    the pane, not as a stalled upload and a socket the relay cut.
//  • A DROP NEVER BECOMES A COMMAND. The path arrives back and is sent as
//    input with ONE trailing space and no newline — exactly what a native
//    terminal inserts. Nothing here ever sends a return: what to do with the
//    path is the human's next keystroke, and a drop that submitted the prompt
//    for them would run a half-written message.

// Mirrors DROP_MAX_BYTES in terminal/drop-file.mjs. Three copies of this
// number exist (here, the relay's frame guard, the host's own check) because
// none of the three packages can import another; the host's is the rule and
// these two only save a pointless round trip.
export const DROP_MAX_BYTES = 10 * 1024 * 1024;

export const dropSizeLabel = () => `${Math.round(DROP_MAX_BYTES / (1024 * 1024))} MB`;

// Does this drag carry files? `types` is the only thing readable during a
// dragover — the items themselves are withheld until the drop, deliberately,
// so a page cannot read what is being dragged over it.
export function isFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types || []).includes('Files');
}

export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files || []);
}

// The file as base64, which is how every byte on this socket travels.
// FileReader rather than a fetch/arrayBuffer loop: its data URL is already
// base64 and the browser did the encoding in native code, which for a 10 MB
// image is the difference between imperceptible and a visible page freeze.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('the browser could not read that file'));
    fr.onload = () => {
      const s = String(fr.result || '');
      const comma = s.indexOf(',');
      if (comma < 0) { reject(new Error('the browser could not read that file')); return; }
      resolve(s.slice(comma + 1));
    };
    fr.readAsDataURL(file);
  });
}

// What gets typed. The host's names are already reduced to [A-Za-z0-9._-] and
// the directory is fixed, so no path this can be handed needs quoting — but
// the check is here rather than assumed, because the day that stops being true
// the failure is a shell running the second half of a filename.
export function pathAsInput(path: string): string {
  return /^[A-Za-z0-9._\-/~]+$/.test(path) ? `${path} ` : `'${path.replace(/'/g, `'\\''`)}' `;
}
