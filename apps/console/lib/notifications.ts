import type { ConversationSummary, Task, IgComment } from './api';
import { awaitingReply } from './format';
import { isTaskOverdue, isTaskDueToday } from './taskHelpers';
import { t } from './copy';

export interface NotificationItem {
  id: string;
  kind: 'chat' | 'task' | 'comment';
  /** Bold headline: the contact's name for a chat, the task's title for a task,
   *  the commenter's handle for an IG comment. */
  title: string;
  /** Second line under the headline — tasks name who it's about, comments show
   *  a preview of the text; chats have none. */
  meta: string | null;
  /** Whose initial the avatar circle shows — always a person, never a task title. */
  avatarLabel: string;
  tag: string;
  tone: 'warn' | 'danger';
  when: string;
  href: string;
}

const COMMENT_PREVIEW_LENGTH = 60;

/** Everything waiting on someone, in one list — a chat with no reply yet, a
 *  follow-up whose due date has already arrived, or an Instagram comment that
 *  still needs its public reply (`comments` defaults to empty so callers that
 *  never fetch `/v1/ig-comments` — none left, but a cheap safety net for a
 *  future one — don't have to pass it). */
export function buildNotifications(
  conversations: ConversationSummary[], tasks: Task[], comments: IgComment[] = [],
): NotificationItem[] {
  const chatItems: NotificationItem[] = conversations.filter(awaitingReply).map((c) => {
    const name = c.display_name ?? c.phone ?? '?';
    return {
      id: `chat-${c.id}`, kind: 'chat', title: name, meta: null, avatarLabel: name,
      tag: t.notifications.needsReply, tone: 'warn',
      when: c.last_message_at ?? c.created_at, href: `/obrolan/${c.id}`,
    };
  });

  const taskItems: NotificationItem[] = tasks
    .filter((tk) => isTaskOverdue(tk) || isTaskDueToday(tk))
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    .map((tk) => {
      const party = tk.contactName ?? tk.brandName ?? tk.contactPhone ?? tk.brandPhone;
      return {
        id: `task-${tk.id}`, kind: 'task' as const, title: tk.title,
        meta: party, avatarLabel: party ?? tk.title,
        tag: isTaskOverdue(tk) ? t.notifications.taskOverdue : t.notifications.taskDueToday,
        tone: (isTaskOverdue(tk) ? 'danger' : 'warn') as 'danger' | 'warn',
        when: tk.dueAt, href: '/tugas',
      };
    });

  // Mirrors what the Komentar IG page itself treats as needing attention:
  // `pending` is a real comment nobody has answered yet, `failed` is one the
  // bridge tried and could not post — both are "someone has to look at this",
  // `sent` and `skipped` are already handled. There is no per-comment page to
  // deep-link to (the Komentar IG list is the whole surface), so every one of
  // these opens the same place the badgeless rail link already does.
  const commentItems: NotificationItem[] = comments
    .filter((c) => c.publicStatus === 'pending' || c.publicStatus === 'failed')
    .map((c) => ({
      id: `comment-${c.id}`, kind: 'comment' as const, title: c.commenter,
      meta: c.text.length > COMMENT_PREVIEW_LENGTH ? `${c.text.slice(0, COMMENT_PREVIEW_LENGTH)}…` : c.text,
      avatarLabel: c.commenter,
      tag: c.publicStatus === 'failed' ? t.notifications.commentFailed : t.notifications.commentPending,
      tone: (c.publicStatus === 'failed' ? 'danger' : 'warn') as 'danger' | 'warn',
      when: c.commentedAt ?? c.createdAt, href: '/komentar-ig',
    }));

  return [...chatItems, ...taskItems, ...commentItems];
}
