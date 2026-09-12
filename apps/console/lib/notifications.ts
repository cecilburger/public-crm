import type { ConversationSummary, Task } from './api';
import { awaitingReply } from './format';
import { isTaskOverdue, isTaskDueToday } from './taskHelpers';
import { t } from './copy';

export interface NotificationItem {
  id: string;
  kind: 'chat' | 'task';
  /** Bold headline: the contact's name for a chat, the task's title for a task. */
  title: string;
  /** Second line under the headline — only tasks have one, naming who it's about. */
  meta: string | null;
  /** Whose initial the avatar circle shows — always a person, never a task title. */
  avatarLabel: string;
  tag: string;
  tone: 'warn' | 'danger';
  when: string;
  href: string;
}

/** Everything waiting on someone, in one list — a chat with no reply yet,
 *  or a follow-up whose due date has already arrived. */
export function buildNotifications(conversations: ConversationSummary[], tasks: Task[]): NotificationItem[] {
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
    .map((tk) => ({
      id: `task-${tk.id}`, kind: 'task', title: tk.title,
      meta: tk.contactName ?? tk.contactPhone, avatarLabel: tk.contactName ?? tk.title,
      tag: isTaskOverdue(tk) ? t.notifications.taskOverdue : t.notifications.taskDueToday,
      tone: isTaskOverdue(tk) ? 'danger' : 'warn',
      when: tk.dueAt, href: '/tugas',
    }));

  return [...chatItems, ...taskItems];
}
