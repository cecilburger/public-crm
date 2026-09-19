import {
  api, type Contact, type ConversationSummary, type Member, type Deal, type TaskKind, type Task,
} from '@/lib/api';

/**
 * The fetch bundle every Client list view needs — Client Deal and Client On
 * Proses are the same table filtered two different ways, not two different
 * pages, so they share one data load instead of each repeating it.
 */
export async function loadClientPageData() {
  const [contacts, conversations, members, deals, taskKinds, tasks] = await Promise.all([
    api<Contact[]>('/v1/contacts'),
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
    api<Task[]>('/v1/tasks').catch(() => [] as Task[]),
  ]);

  // Conversations come back newest-first, so the first one seen per contact
  // is the one worth linking to — a client with two threads still gets a
  // single "Chat" link, and it goes to the live one.
  const conversationByContact: Record<string, string> = {};
  for (const c of conversations) {
    if (!(c.contact_id in conversationByContact)) conversationByContact[c.contact_id] = c.id;
  }

  return { contacts, conversationByContact, members, deals, taskKinds, meetingByContact: nextMeetingByContact(tasks) };
}

/**
 * The nearest open meeting task per contact — what the "Jadwal Meeting"
 * column shows today. Not `contact.scheduleMeeting`: that's a dead field
 * nothing writes to anymore (see `ClientQuickAddTaskDrawer`) — a meeting
 * made through the real "Jadwal Meeting" button would never show up here or
 * in that column otherwise.
 */
export function nextMeetingByContact(tasks: Task[]): Record<string, Task> {
  const out: Record<string, Task> = {};
  for (const task of tasks) {
    if (task.kind !== 'meeting' || task.status !== 'open' || !task.contactId) continue;
    const existing = out[task.contactId];
    if (!existing || new Date(task.dueAt) < new Date(existing.dueAt)) out[task.contactId] = task;
  }
  return out;
}

/**
 * Client On Proses vs Client Deal is a manual switch on the contact itself
 * (`clientStatus`, edited from Client Detail) — not derived from whether a
 * Deal has actually been won. An agent can move someone between the two
 * without a Deal existing at all, the same way `storeStatus` is a manual
 * call rather than computed from order history.
 */
export function prosesContacts(contacts: Contact[]): Contact[] {
  return contacts.filter((c) => c.tags.includes('customer') && c.clientStatus !== 'deal');
}

export function dealContacts(contacts: Contact[]): Contact[] {
  return contacts.filter((c) => c.tags.includes('customer') && c.clientStatus === 'deal');
}
