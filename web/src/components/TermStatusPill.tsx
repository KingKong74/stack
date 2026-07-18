import { useEffect, useState } from 'react';
import { watchTermStatus, TermStatus } from '../store';
import { go } from '../lib/route';

// The global terminal presence pill (#121): mounted once in App so every open
// Stack tab — dashboard, detail, settings, anywhere — shows when a web-terminal
// session is live somewhere. Pushed by the relay's /term-status channel, so a
// session starting or ending in one tab updates all of them at once. Quiet
// (renders nothing) at zero, like the deck's live-now strip; clicking it opens
// the Terminal screen. Hidden on the Terminal screen itself, which has its own
// status line — the watch stays subscribed so navigating back is instant.
export function TermStatusPill({ hidden }: { hidden?: boolean }) {
  const [status, setStatus] = useState<TermStatus>({ active: false, count: 0 });
  useEffect(() => watchTermStatus(setStatus), []);
  if (hidden || !status.active) return null;
  return (
    <button
      className="term-presence"
      onClick={() => go.terminal()}
      title="A web terminal is running — open the Terminal screen"
    >
      <span className="dot" />
      {status.count > 1 ? `${status.count} terminal sessions active` : 'Terminal session active'}
    </button>
  );
}
