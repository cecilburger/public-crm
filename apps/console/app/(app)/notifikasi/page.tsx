import Link from 'next/link';
import { api, type ConversationSummary, type Task, type IgComment } from '@/lib/api';
import { buildNotifications } from '@/lib/notifications';
import { ago } from '@/lib/format';
import { t } from '@/lib/copy';

export const dynamic = 'force-dynamic';

/**
 * The bell's "Lihat semua" — every chat waiting on a reply, every task whose
 * due date has arrived, and every Instagram comment still needing its public
 * reply, unabridged. Reachable only from the bell, not from the rail: this is
 * a detail view of what the bell already shows, not a place someone starts
 * their day.
 */
export default async function NotificationsPage() {
  const [conversations, tasks, pendingComments] = await Promise.all([
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    api<Task[]>('/v1/tasks').catch(() => [] as Task[]),
    api<IgComment[]>('/v1/ig-comments?pending=true').catch(() => [] as IgComment[]),
  ]);
  const items = buildNotifications(conversations, tasks, pendingComments);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.notifications.title}</h1>
        </div>
      </div>

      <div className="scroll pad stack">
        <div className="panel">
          {items.length === 0 ? (
            <p className="empty" style={{ padding: '24px 0' }}>{t.notifications.empty}</p>
          ) : (
            <div className="notif-list">
              {items.map((item) => {
                const initial = item.avatarLabel.replace(/[^a-zA-Z0-9]/g, '').charAt(0).toUpperCase() || '?';
                return (
                  <Link key={item.id} href={item.href} className="notif-item">
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
      </div>
    </>
  );
}
