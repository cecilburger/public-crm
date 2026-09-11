'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ago } from '@/lib/format';
import { t } from '@/lib/copy';
import type { ConversationSummary } from '@/lib/api';

/**
 * Reuses the same conversation list the sidebar badge already counts — no
 * second fetch, just a second view of it: who is waiting, not only how many.
 * Lives in the Rail, which is the one thing every page already shares, so
 * this doesn't need touching every page's own topbar.
 */
export function NotificationBell({ items }: { items: ConversationSummary[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="notif" ref={rootRef}>
      <button type="button" className="notif-bell" onClick={() => setOpen((v) => !v)}
              aria-label={t.notifications.title} aria-expanded={open}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" />
          <path d="M9.5 17a2.5 2.5 0 0 0 5 0" />
        </svg>
        {items.length > 0 ? <span className="notif-badge">{items.length > 9 ? '9+' : items.length}</span> : null}
      </button>

      {open ? (
        <div className="notif-panel">
          <header>{t.notifications.title}</header>
          {items.length === 0 ? (
            <p className="empty">{t.notifications.empty}</p>
          ) : (
            <>
              <div className="notif-list">
                {items.slice(0, 8).map((c) => (
                  <Link key={c.id} href={`/obrolan/${c.id}`} className="notif-item" onClick={() => setOpen(false)}>
                    <span className="dot warn" aria-hidden />
                    <span style={{ minWidth: 0 }}>
                      <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.display_name ?? c.phone ?? '—'}
                      </b>
                      <span className="dim">{t.notifications.needsReply}</span>
                    </span>
                    <span className="notif-time">{ago(c.last_message_at)}</span>
                  </Link>
                ))}
              </div>
              <Link href="/obrolan" className="notif-footer" onClick={() => setOpen(false)}>
                {t.notifications.seeAll}
              </Link>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
