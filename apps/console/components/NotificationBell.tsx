'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ago } from '@/lib/format';
import { t } from '@/lib/copy';
import type { NotificationItem } from '@/lib/notifications';

/**
 * Reuses the same conversation and task lists the rail already fetches — no
 * second round trip, just a second view of them: who and what is waiting,
 * not only how many. Lives in the Rail, which is the one thing every page
 * already shares, so this doesn't need touching every page's own topbar.
 */
export function NotificationBell({ items }: { items: NotificationItem[] }) {
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

  const hasUnread = items.length > 0;

  return (
    <div className="notif" ref={rootRef}>
      <button type="button" className={`notif-bell ${hasUnread ? 'has-unread' : ''}`} onClick={() => setOpen((v) => !v)}
              aria-label={t.notifications.title} aria-expanded={open}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" />
          <path d="M9.5 17a2.5 2.5 0 0 0 5 0" />
        </svg>
        {hasUnread ? <span className="notif-badge">{items.length > 9 ? '9+' : items.length}</span> : null}
      </button>

      {open ? (
        <div className="notif-panel">
          <header>
            <span className="notif-header-left">
              {t.notifications.title}
              {items.length > 0 ? <span className="notif-count">{items.length}</span> : null}
            </span>
            <Link href="/notifikasi" className="notif-see-all" onClick={() => setOpen(false)}>
              {t.notifications.seeAll}
            </Link>
          </header>
          {items.length === 0 ? (
            <p className="empty">{t.notifications.empty}</p>
          ) : (
            <div className="notif-list">
              {items.slice(0, 5).map((item) => {
                const initial = item.avatarLabel.replace(/[^a-zA-Z0-9]/g, '').charAt(0).toUpperCase() || '?';
                return (
                  <Link key={item.id} href={item.href} className="notif-item" onClick={() => setOpen(false)}>
                    <div className="notif-avatar-wrap">
                      <div className="notif-avatar">{initial}</div>
                      <span className={`notif-dot ${item.tone}`} aria-hidden />
                    </div>
                    <div className="notif-body">
                      <div className="notif-row">
                        <b>{item.title}</b>
                        <span className="notif-time">{ago(item.when)}</span>
                      </div>
                      {item.meta ? <span className="notif-meta">{item.meta}</span> : null}
                      <span className={`notif-tag ${item.tone}`}>{item.tag}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
