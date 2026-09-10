'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/lib/copy';

/**
 * Two sources feed the same refresh: an interval (still needed for things a
 * message event doesn't cover, like a QR code rotating while pairing) and
 * `/api/realtime` — a relay onto the API's own SSE endpoint — which fires the
 * instant a new WhatsApp message actually arrives instead of waiting for the
 * next tick. `EventSource` reconnects on its own when the connection drops or
 * the API cycles it after its max lifetime, so there is no manual retry loop
 * here. The control still says what it is doing rather than showing a green
 * "live" light that means nothing, and it can be paused, because a list that
 * reorders itself while you are reading it is worse than a stale one.
 */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [on, setOn] = useState(true);
  const [last, setLast] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!on) return;
    const refresh = () => start(() => { router.refresh(); setLast(Date.now()); });

    const source = new EventSource('/api/realtime');
    source.onmessage = refresh;

    const id = setInterval(refresh, seconds * 1000);
    return () => { source.close(); clearInterval(id); };
  }, [on, seconds, router]);

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="mono dim">
        {pending ? t.chats.refreshing
          : `${t.chats.updated} ${new Date(last).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`}
      </span>
      <button className="btn ghost sm" onClick={() => setOn((v) => !v)} aria-pressed={on}>
        <span className={on ? 'dot' : 'dot idle'} /> {on ? t.chats.live : t.chats.paused}
      </button>
    </span>
  );
}
