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
  const [status, setStatus] = useState<TermStatus>({ active: false, count: 0, claude: 0, unattended: 0 });
  useEffect(() => watchTermStatus(setStatus), []);
  if (hidden || !status.active) return null;
  // Claude activity outranks plain shells in the wording — and claude running
  // unattended (no browser anywhere) still shows, so a walked-away session is
  // never invisible. An anchor, not a button: middle/ctrl-click opens the
  // Terminal screen in its own tab.
  const claudeish = status.claude > 0 || status.unattended > 0;
  const label =
    status.claude > 1 ? `${status.claude} claude sessions active`
    : status.claude === 1 ? 'Claude session active'
    : status.unattended > 0 ? (status.unattended > 1 ? `${status.unattended} claude sessions unattended` : 'Claude running unattended')
    : status.count > 1 ? `${status.count} terminal sessions active` : 'Terminal session active';
  return (
    <a
      className={`term-presence${claudeish ? ' claude' : ''}`}
      href="#/terminal"
      onClick={(e) => { e.preventDefault(); go.terminal(); }}
      title={status.unattended > 0 && status.claude === 0 && status.count === 0
        ? 'Claude is running on the host with no tab attached — open the Terminal screen to jump back in'
        : 'A web terminal is running — open the Terminal screen'}
    >
      <span className="dot" />
      {label}
    </a>
  );
}
