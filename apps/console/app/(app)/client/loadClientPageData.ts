import {
  api, type Contact, type ConversationSummary, type Member, type Deal, type TaskKind,
} from '@/lib/api';

/**
 * The fetch bundle every Client list view needs — Client Deal and Client On
 * Proses are the same table filtered two different ways, not two different
 * pages, so they share one data load instead of each repeating it.
 */
export async function loadClientPageData() {
  const [contacts, conversations, members, deals, taskKinds] = await Promise.all([
    api<Contact[]>('/v1/contacts'),
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
  ]);

  // Conversations come back newest-first, so the first one seen per contact
  // is the one worth linking to — a client with two threads still gets a
  // single "Chat" link, and it goes to the live one.
  const conversationByContact: Record<string, string> = {};
  for (const c of conversations) {
    if (!(c.contact_id in conversationByContact)) conversationByContact[c.contact_id] = c.id;
  }

  return { contacts, conversationByContact, members, deals, taskKinds };
}

/** Contacts with at least one won deal — a deal can point at a Contact or a Brand, only the former counts here. */
export function wonDealContactIds(deals: Deal[]): Set<string> {
  return new Set(deals.filter((d) => d.status === 'won' && d.contact_id).map((d) => d.contact_id!));
}

/** Contacts with a meeting on the books — the "Jadwal Meeting" field set on the client's own record. */
export function withScheduledMeeting(contacts: Contact[]): Contact[] {
  return contacts.filter((c) => !!c.scheduleMeeting);
}
