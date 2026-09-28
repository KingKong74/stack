// The top bar's way into the Inbox (screens/Inbox.tsx): how many things are
// waiting on you across every project. It draws nothing while nothing is
// waiting AND the loop is not holding: a quiet bar is the good news. When
// Stack cannot see the dispatcher it says so, rather than going quiet.
import { useCallback, useEffect, useState } from 'react';
import { hrefTo, useRoute } from '../lib/route';
import { useAutoRefresh } from '../lib/autoRefresh';
import { getInboxCount, AuthError } from '../store';

export function InboxChip() {
  const route = useRoute();
  const [n, setN] = useState<{ waiting: number; hold: string; seen: boolean } | null>(null);
  const load = useCallback(() => {
    getInboxCount().then(setN).catch((e) => { if (!(e instanceof AuthError)) setN(null); });
  }, []);
  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load);
  if (!n || route.name === 'inbox') return null;
  if (n.waiting === 0 && n.seen) return null;
  return (
    <a className="inbox-chip" href={hrefTo.inbox}
      title={n.seen ? (n.hold ? `The loop is not building: ${n.hold}.` : 'The loop is running.') : n.hold}>
      Inbox{n.waiting > 0 && <span className="inbox-n">{n.waiting}</span>}
      {!n.seen && <span className="inbox-warn">cannot see the loop</span>}
    </a>
  );
}
