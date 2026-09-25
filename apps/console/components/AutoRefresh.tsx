'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/lib/copy';
import { withBase } from '@/lib/basePath';

const MIN_GAP_MS = 1500;

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
export function AutoRefresh({ seconds = 10, renderedAt }: { seconds?: number; renderedAt?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [on, setOn] = useState(true);
  const [last, setLast] = useState<number>(0);

  // Set the real timestamp after mount so SSR and client initial renders match.
  useEffect(() => { setLast(Date.now()); }, []);

  // A page shown from the browser's cache (`staleTimes` in next.config) opens
  // instantly but may be up to 30 s old — catch it up straight away, in the
  // background, rather than at the next tick. Mount only: every refresh
  // re-renders with a new `renderedAt`, and that must not trigger another.
  useEffect(() => {
    if (renderedAt && Date.now() - renderedAt > 5_000) start(() => { router.refresh(); setLast(Date.now()); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!on) return;
    // Each refresh re-renders the whole server page — a burst of API reads —
    // so they are rationed: a burst of realtime events coalesces into one
    // refresh at most every MIN_GAP_MS, the interval tick is skipped when an
    // event already refreshed recently, and a background tab doesn't refresh
    // at all until it is looked at again. On a slow machine the unrationed
    // version queued refreshes faster than they could finish.
    let lastRun = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let missed = false;

    const run = () => {
      timer = undefined;
      if (document.hidden) { missed = true; return; }
      lastRun = Date.now();
      start(() => { router.refresh(); setLast(Date.now()); });
    };
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(run, Math.max(0, lastRun + MIN_GAP_MS - Date.now()));
    };
    const onVisible = () => {
      if (!document.hidden && missed) { missed = false; schedule(); }
    };

    const source = new EventSource(withBase('/api/realtime'));
    source.onmessage = schedule;

    const id = setInterval(() => {
      if (Date.now() - lastRun >= seconds * 1000 - MIN_GAP_MS) schedule();
    }, seconds * 1000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      source.close();
      clearInterval(id);
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [on, seconds, router]);

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="mono dim">
        {pending || last === 0 ? t.chats.refreshing
          : `${t.chats.updated} ${new Date(last).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`}
      </span>
      <button className="btn ghost sm" onClick={() => setOn((v) => !v)} aria-pressed={on}>
        <span className={on ? 'dot' : 'dot idle'} /> {on ? t.chats.live : t.chats.paused}
      </button>
    </span>
  );
}
