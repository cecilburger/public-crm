import { withTenant, type Database } from '@kirana/db';
import {
  processChatbotReply, markChatbotExhausted, type ChatbotDeps, type ChatbotJob, type ChatbotOutcome,
} from './chatbotReply.ts';

/**
 * Drains `bd.draft` jobs queued before the chatbot moved to `chatbot.reply`.
 * Kept for one release; nothing dispatches to this queue any more.
 *
 * An old job names the conversation and carries the text, but not the
 * message or the division — both are read back from the conversation, and
 * the newest inbound message is answered through the new processor, with its
 * idempotency, lease and ownership checks. A conversation with no inbound
 * message has nothing to answer.
 */
export const LEGACY_BD_DRAFT_QUEUE = 'bd.draft';

export interface LegacyBdDraftJob {
  tenantId: string;
  conversationId: string;
  text?: string;
}

/** The `chatbot.reply` job an old `bd.draft` job stands for; null when there is nothing to answer. */
export async function legacyBdDraftTarget(db: Database, job: LegacyBdDraftJob): Promise<ChatbotJob | null> {
  const rows = await withTenant(db, job.tenantId, (tx) =>
    tx.query<{ division_id: string; message_id: string | null }>(
      `select c.division_id,
              (select m.id from messages m
                where m.tenant_id = c.tenant_id and m.conversation_id = c.id and m.direction = 'inbound'
                order by m.created_at desc limit 1) as message_id
         from conversations c
        where c.tenant_id = $1 and c.id = $2`,
      [job.tenantId, job.conversationId],
    ));
  const target = rows[0];
  if (!target?.message_id) return null;
  return {
    tenantId: job.tenantId, divisionId: target.division_id,
    conversationId: job.conversationId, messageId: target.message_id,
  };
}

export async function processLegacyBdDraft(
  deps: ChatbotDeps, job: LegacyBdDraftJob, opts: { onBusy?: () => Promise<void> } = {},
): Promise<ChatbotOutcome> {
  const target = await legacyBdDraftTarget(deps.db, job);
  if (!target) return { status: 'skipped', reason: 'not_found' };
  return processChatbotReply(deps, target, opts);
}

/**
 * The queue gave up on an old job: the same hand-over to a person as a
 * `chatbot.reply` job gets. The job is resolved to its message again, since
 * it never carried one.
 */
export async function markLegacyBdDraftExhausted(db: Database, job: LegacyBdDraftJob, error: string): Promise<void> {
  const target = await legacyBdDraftTarget(db, job);
  if (target) await markChatbotExhausted(db, target, error);
}
