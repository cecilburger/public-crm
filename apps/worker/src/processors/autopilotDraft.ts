import {
  selectKnowledge, checkGuardrails, decide,
  type AutopilotPolicy, type KnowledgeItem, type ReasonCode,
} from '@kirana/core';
import {
  withTenant, tenantKeys, openField, sealField, queueOutboundMessage,
  ensureBillingPeriod, incrementUsage, audit, type Database, type Sql,
} from '@kirana/db';
import type { AutopilotModel, DraftRequest } from '../autopilot/model.ts';
import { createToolBox, auditToolUse } from '../autopilot/tools.ts';

export interface AutopilotDeps {
  db: Database;
  kek: Buffer;
  model: AutopilotModel;
  dispatch: (job: { queue: string; payload: unknown }) => Promise<void>;
  /** Where a checkout link points. */
  publicBaseUrl?: string;
}

export interface AutopilotOutcome {
  status: 'skipped' | 'sent' | 'suggested' | 'handover';
  reasons: ReasonCode[];
  draftId?: string;
}

const CAUTION = { off: 0, suggest: 1, auto: 2 } as const;

/**
 * A conversation may be more cautious than the workspace, never bolder. Turning
 * one thread down to 'suggest' must not be undone by a workspace default of
 * 'auto', and 'inherit' means the conversation has no opinion.
 */
export function narrowest(conversationMode: string, workspaceMode: AutopilotPolicy['mode']): AutopilotPolicy['mode'] {
  if (conversationMode === 'inherit' || !(conversationMode in CAUTION)) return workspaceMode;
  const conv = conversationMode as AutopilotPolicy['mode'];
  return CAUTION[conv] < CAUTION[workspaceMode] ? conv : workspaceMode;
}

const DEFAULT_POLICY: AutopilotPolicy = {
  mode: 'suggest', minConfidence: 0.75, mayOfferDiscount: false, mayPromiseDelivery: false,
  persona: 'Ramah, sopan, ringkas. Pakai Bahasa Indonesia sehari-hari.',
  escalateKeywords: ['komplain', 'tuntut', 'polisi', 'pengacara', 'refund', 'kecewa'],
  maxReplyChars: 700,
  maxRepliesPerHour: 120,
  maxRepliesPerContactPerHour: 12,
};

/**
 * Draft a reply to one inbound message.
 *
 * Deliberately three phases with the model call in the middle, outside any
 * transaction: holding a Postgres connection open across a multi-second API call
 * is how a worker pool starves under load.
 */
export async function processAutopilotDraft(
  deps: AutopilotDeps,
  job: { tenantId: string; conversationId: string; messageId?: string },
): Promise<AutopilotOutcome> {
  /* 1 — read the context */
  const context = await withTenant(deps.db, job.tenantId, async (tx) => {
    const rows = await tx.query<{
      id: string; contact_id: string; autopilot_mode: string; status: string; assignee_id: string | null;
      shop_name: string; contact_name: string | null;
    }>(
      `select c.id, c.contact_id, c.autopilot_mode, c.status, c.assignee_id,
              t.name as shop_name, ct.display_name as contact_name
         from conversations c
         join tenants t on t.id = c.tenant_id
         join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
        where c.tenant_id = $1 and c.id = $2`,
      [job.tenantId, job.conversationId],
    );
    const conversation = rows[0];
    if (!conversation) return null;

    const policy = await loadPolicy(tx, job.tenantId);
    // A conversation can opt out even when the workspace is on.
    if (narrowest(conversation.autopilot_mode, policy.mode) === 'off') return null;

    // Someone is already on it — do not talk over them.
    if (conversation.assignee_id !== null) return null;

    // Already answered this message. A retried job must not call the model a
    // second time: the tenant pays per generation, so retries have to be free.
    if (job.messageId) {
      const existing = await tx.query<{ id: string }>(
        'select id from message_drafts where tenant_id = $1 and in_reply_to = $2',
        [job.tenantId, job.messageId],
      );
      if (existing[0]) return 'already_drafted' as const;
    }

    // Spend cap. Hitting it is not an error: the messages still arrive, they
    // just wait for a person instead of costing a model call each.
    if (policy.maxRepliesPerHour > 0) {
      const spent = await generationsThisHour(tx, job.tenantId);
      if (spent >= policy.maxRepliesPerHour) return 'rate_limited' as const;
    }

    // And per customer, so one person hammering the chat cannot exhaust the
    // shop's hour for everybody else.
    if (policy.maxRepliesPerContactPerHour > 0) {
      const spent = await generationsForContact(tx, job.tenantId, conversation.contact_id);
      if (spent >= policy.maxRepliesPerContactPerHour) return 'contact_rate_limited' as const;
    }

    const keys = await tenantKeys(tx, deps.kek, job.tenantId);
    const messages = await tx.query<{ direction: string; body_enc: string | null }>(
      `select direction, body_enc from messages
        where tenant_id = $1 and conversation_id = $2 and body_enc is not null
        order by coalesce(provider_ts, created_at) desc limit 12`,
      [job.tenantId, job.conversationId],
    );

    const history = messages.reverse().map((m) => ({
      role: m.direction === 'inbound' ? ('customer' as const) : ('shop' as const),
      text: openField(keys, job.tenantId, m.body_enc!),
    }));
    if (history.length === 0 || history.at(-1)?.role !== 'customer') return null;

    const knowledge = await loadKnowledge(tx, job.tenantId);

    return {
      conversation, policy, history, knowledge,
      effectiveMode: narrowest(conversation.autopilot_mode, policy.mode),
    };
  });

  if (context === 'already_drafted') return { status: 'skipped', reasons: [] };
  if (context === 'rate_limited') return { status: 'skipped', reasons: ['rate_limited'] };
  if (context === 'contact_rate_limited') return { status: 'skipped', reasons: ['contact_rate_limited'] };
  if (!context) return { status: 'skipped', reasons: [] };

  // A customer's question is often spread across two or three quick messages
  // ("batik parang size M ada?" … "butuh hari Jumat"). Retrieving on the last
  // line alone loses the subject, so the recent customer turns are read
  // together — for finding catalogue entries and for spotting a complaint.
  const customerMessage = context.history
    .filter((turn) => turn.role === 'customer')
    .slice(-3)
    .map((turn) => turn.text)
    .join(' \n');

  const relevant = selectKnowledge(context.knowledge, customerMessage);

  // The chatbot's hands. Each tool opens its own short transaction, so nothing
  // is held open across the model call.
  const tools = createToolBox({ db: deps.db, kek: deps.kek }, {
    tenantId: job.tenantId,
    conversationId: job.conversationId,
    contactId: context.conversation.contact_id,
    knowledge: context.knowledge,
    publicBaseUrl: deps.publicBaseUrl ?? 'http://localhost:8080',
  });

  const request: DraftRequest = {
    shopName: context.conversation.shop_name,
    policy: context.policy,
    knowledge: relevant,
    history: context.history,
    tools,
  };

  /* 2 — generate, outside any transaction */
  const result = await deps.model.draft(request);
  await auditToolUse({ db: deps.db }, job.tenantId, job.conversationId, tools);

  /* 3 — check, decide, persist */
  const guardrails = checkGuardrails({
    draft: result.draft,
    customerMessage,
    knowledge: request.knowledge,
    policy: context.policy,
    // Totals and checkout links the server produced this turn are quotable
    // precisely because the model did not invent them.
    groundedAmounts: tools.groundedAmounts,
    groundedLinks: tools.groundedLinks,
  });
  const decision = decide(result.draft, guardrails, { ...context.policy, mode: context.effectiveMode });

  const outcome = await withTenant(deps.db, job.tenantId, async (tx) => {
    const status = decision.action === 'send' ? 'auto_sent'
      : decision.action === 'suggest' ? 'pending'
      : 'blocked';

    const keys = await tenantKeys(tx, deps.kek, job.tenantId);
    // The read above is the cheap guard; this is the one that holds when two
    // workers pick up the same job at the same instant.
    const inserted = await tx.query<{ id: string }>(
      `insert into message_drafts
         (tenant_id, conversation_id, in_reply_to, body_enc, confidence, intent, status, reasons, model, usage)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict do nothing
       returning id`,
      [job.tenantId, job.conversationId, job.messageId ?? null,
       sealField(keys, job.tenantId, result.draft.reply),
       result.draft.confidence, result.draft.intent, status,
       JSON.stringify(decision.reasons), result.model,
       JSON.stringify({ ...result.usage, actions: tools.actions })],
    );

    // Lost the race: another worker already drafted for this message. The model
    // call is spent, but the tenant is not charged twice for it.
    if (!inserted[0]) return { draftId: undefined };

    // Every generation is metered, whether or not it reached the customer.
    const period = await ensureBillingPeriod(tx, job.tenantId, new Date());
    await incrementUsage(tx, job.tenantId, period.id, 'ai_replies', 1);

    if (decision.action === 'send') {
      const queued = await queueOutboundMessage({ tx, tenantId: job.tenantId, kek: deps.kek }, {
        conversationId: job.conversationId,
        body: result.draft.reply,
        senderType: 'autopilot',
      });
      await audit(tx, job.tenantId, {
        actorType: 'system', action: 'autopilot.sent', resourceType: 'conversation',
        resourceId: job.conversationId,
        meta: { draftId: inserted[0]!.id, confidence: result.draft.confidence, intent: result.draft.intent },
      });
      return { messageId: queued.messageId, draftId: inserted[0]!.id };
    }

    if (decision.action === 'handover') {
      // Put it back in front of a person, with the reason attached.
      await tx.query(
        `update conversations set status = 'open' where tenant_id = $1 and id = $2 and status = 'resolved'`,
        [job.tenantId, job.conversationId],
      );
      await audit(tx, job.tenantId, {
        actorType: 'system', action: 'autopilot.handover', resourceType: 'conversation',
        resourceId: job.conversationId,
        meta: { draftId: inserted[0]!.id, reasons: decision.reasons },
      });
    }

    return { draftId: inserted[0]!.id };
  });

  if ('messageId' in outcome && outcome.messageId) {
    await deps.dispatch({
      queue: 'outbound.send',
      payload: { tenantId: job.tenantId, messageId: outcome.messageId },
    });
  }

  return {
    status: decision.action === 'send' ? 'sent' : decision.action === 'suggest' ? 'suggested' : 'handover',
    reasons: decision.reasons,
    draftId: outcome.draftId,
  };
}

/* ------------------------------------------------------------------ loads */

/**
 * The columns are declared once and used for both the query and the row type.
 *
 * Hand-written SQL is not checked against a hand-written row type, and this
 * exact pair has drifted three times — each time silently disabling whatever the
 * new column controlled. One list removes the class of bug.
 */
const POLICY_COLUMNS = [
  'mode', 'min_confidence', 'may_offer_discount', 'may_promise_delivery',
  'persona', 'escalate_keywords', 'max_reply_chars',
  'max_replies_per_hour', 'max_replies_per_contact_per_hour',
] as const;

type PolicyRow = {
  mode: string; min_confidence: string; may_offer_discount: boolean;
  may_promise_delivery: boolean; persona: string; escalate_keywords: string[];
  max_reply_chars: number; max_replies_per_hour: number; max_replies_per_contact_per_hour: number;
};
// Fails to compile if a column is added to the list but not to the row type.
type _PolicyColumnsCovered = (typeof POLICY_COLUMNS)[number] extends keyof PolicyRow ? true : never;
const _policyColumnsCovered: _PolicyColumnsCovered = true;
void _policyColumnsCovered;

export async function loadPolicy(tx: Sql, tenantId: string): Promise<AutopilotPolicy> {
  const rows = await tx.query<PolicyRow>(
    `select ${POLICY_COLUMNS.join(', ')} from autopilot_settings where tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return DEFAULT_POLICY;

  return {
    mode: row.mode as AutopilotPolicy['mode'],
    minConfidence: Number(row.min_confidence),
    mayOfferDiscount: row.may_offer_discount,
    mayPromiseDelivery: row.may_promise_delivery,
    persona: row.persona,
    escalateKeywords: row.escalate_keywords,
    maxReplyChars: row.max_reply_chars,
    maxRepliesPerHour: row.max_replies_per_hour ?? DEFAULT_POLICY.maxRepliesPerHour,
    maxRepliesPerContactPerHour:
      row.max_replies_per_contact_per_hour ?? DEFAULT_POLICY.maxRepliesPerContactPerHour,
  };
}

/** Generations spent on one customer in the last hour. */
export async function generationsForContact(tx: Sql, tenantId: string, contactId: string): Promise<number> {
  const rows = await tx.query<{ n: number }>(
    `select count(*)::int as n
       from message_drafts d
       join conversations c on c.id = d.conversation_id and c.tenant_id = d.tenant_id
      where d.tenant_id = $1 and c.contact_id = $2 and d.created_at > now() - interval '1 hour'`,
    [tenantId, contactId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * How many generations this workspace has spent in the last hour. Counted from
 * drafts rather than a counter, so it is the same number a supervisor can see.
 */
export async function generationsThisHour(tx: Sql, tenantId: string): Promise<number> {
  const rows = await tx.query<{ n: number }>(
    `select count(*)::int as n from message_drafts
      where tenant_id = $1 and created_at > now() - interval '1 hour'`,
    [tenantId],
  );
  return rows[0]?.n ?? 0;
}

export async function loadKnowledge(tx: Sql, tenantId: string): Promise<KnowledgeItem[]> {
  const rows = await tx.query<{
    id: string; kind: string; title: string; body: string;
    sku: string | null; price_idr: string | null; stock: number | null; tags: string[];
  }>(
    `select id, kind, title, body, sku, price_idr, stock, tags
       from knowledge_items where tenant_id = $1 and active order by kind, title limit 500`,
    [tenantId],
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind as KnowledgeItem['kind'], title: r.title, body: r.body,
    sku: r.sku, priceIdr: r.price_idr === null ? null : Number(r.price_idr),
    stock: r.stock, tags: r.tags,
  }));
}
