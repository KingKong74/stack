// Output belongs to one connection. Retiring it must cancel deferred paints,
// including a frame queued before a reconnect or while the browser slept.
// The timer keeps hidden tabs parsing output when animation frames pause.
export function createTermWrites(write: (data: Uint8Array) => void, current: () => boolean) {
  let chunks: Uint8Array[] = [];
  let bytes = 0;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retired = false;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = undefined;
    timer = undefined;
  };
  const flush = () => {
    cancel();
    const pending = chunks;
    const size = bytes;
    chunks = [];
    bytes = 0;
    if (retired || !current() || !size) return;
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of pending) { merged.set(chunk, offset); offset += chunk.length; }
    write(merged);
  };
  return {
    push(data: Uint8Array) {
      if (retired || !current()) return;
      chunks.push(data);
      bytes += data.length;
      // Bound our own queue even when a background tab throttles both clocks.
      if (bytes >= 256 * 1024) { flush(); return; }
      if (frame !== undefined) return;
      frame = requestAnimationFrame(flush);
      timer = setTimeout(flush, 100);
    },
    flush,
    dispose() { retired = true; cancel(); chunks = []; bytes = 0; },
  };
}

// Track the grid sent to THIS socket, not the last socket or the last focus
// effect. A failed send must not suppress the retry when the socket opens.
export function createTermSizeSender(send: (cols: number, rows: number) => boolean) {
  let cols = 0, rows = 0;
  return {
    seed(c: number, r: number) { cols = c; rows = r; },
    update(c: number, r: number) {
      if (!Number.isInteger(c) || !Number.isInteger(r) || c < 2 || r < 2) return;
      if (c === cols && r === rows) return;
      if (send(c, r)) { cols = c; rows = r; }
    },
  };
}
