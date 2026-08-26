'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@/lib/copy';

/**
 * Polling, said plainly.
 *
 * There is no streaming endpoint on the API yet, so this re-renders on an
 * interval. The control says what it is doing rather than showing a green "live"
 * light that means nothing — and it can be paused, because a list that reorders
 * itself while you are reading it is worse than a stale one.
 */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [on, setOn] = useState(true);
  const [last, setLast] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => {
      start(() => { router.refresh(); setLast(Date.now()); });
    }, seconds * 1000);
    return () => clearInterval(id);
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
