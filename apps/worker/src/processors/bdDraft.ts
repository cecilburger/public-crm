import { withTenant, tenantKeys, openField, sealField, queueOutboundMessage, audit, type Database, type Sql } from '@kirana/db';
import type { BdAction, BdBrainClient, BdConversation } from '../bdBrain.ts';

/**
 * Reply to one inbound message on a BD conversation, using the `trained-cb`
 * flow as the brain.
 *
 * This is the BD sibling of `autopilotDraft` and deliberately never runs
 * alongside it: Autopilot sells a shop's catalogue to a consumer, this
 * qualifies a brand and books a meeting, and two of them answering the same
 * thread would talk over each other. `routeConversation` picks exactly one.
 *
 * Three phases with the brain call in the middle and outside any transaction,
 * for the same reason `autopilotDraft` is shaped this way: holding a Postgres
 * connection open across a network call is how a worker pool starves.
 */

export interface BdDeps {
  db: Database;
  kek: Buffer;
  brain: BdBrainClient;
  dispatch: (job: { queue: string; payload: unknown }) => Promise<void>;
}

export interface BdOutcome {
  status: 'skipped' | 'replied' | 'handover';
  intent?: string;
  /** Actions the brain returned that this processor does not execute yet.
   *  Never silently empty: see `applyActions`. */
  deferred: string[];
}

/** Actions this spike executes. Everything else is deferred, loudly. */
const HANDLED = new Set<BdAction['type']>(['send', 'set_node', 'cancel_timers', 'escalate']);

/**
 * Which brain answers this conversation — exactly one does.
 *
 * This used to be "only if the contact is already on the brand list", but
 * that misses the exact case trained-cb's own SOP is built for: a brand
 * writing in cold, never tracked before — see trained-cb/README.md, "the
 * inbound SOP it implements". The business here is B2B (qualifying brands
 * toward a meeting), not a shop selling a catalogue to consumers, so
 * Autopilot's product-catalogue persona does not apply to inbound WhatsApp
 * traffic at all — everything on this ingress is BD's to answer.
 *
 * Kept as its own function, `async` and taking `tx`/`tenantId`, rather than
 * inlined as a bare `true` at the call site: the day a real Autopilot-shaped
 * conversation shows up on this channel, the distinction has a home to go
 * back into instead of being reinvented from scratch.
 */
export async function isBdConversation(
  _tx: Sql, _tenantId: string, _conversationId: string,
): Promise<boolean> {
  return true;
}

interface Row {
  contact_id: string; status: string; assignee_id: string | null;
  contact_name: string | null;
  brand_name: string | null; brand_category: string | null;
  node: string | null; outcome: string | null;
  gadget_loops: number | null; unknown_streak: number | null; price_stage: number | null;
  email_enc: string | null; meet_link: string | null; stopped_reason: string | null;
  last_inbound_at: Date | null; last_outbound_at: Date | null; meeting_at: Date | null;
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export async function processBdDraft(
  deps: BdDeps,
  job: { tenantId: string; conversationId: string; text: string; now?: Date },
): Promise<BdOutcome> {
  const now = job.now ?? new Date();

  /* 1 — read the state */
  const state = await withTenant(deps.db, job.tenantId, async (tx) => {
    const rows = await tx.query<Row>(
      `select c.contact_id, c.status, c.assignee_id,
              ct.display_name as contact_name,
              b.name as brand_name, b.category as brand_category,
              s.node, s.outcome, s.gadget_loops, s.unknown_streak, s.price_stage,
              s.email_enc, s.meet_link, s.stopped_reason,
              s.last_inbound_at, s.last_outbound_at, s.meeting_at
         from conversations c
         join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
         left join brands b on b.contact_id = c.contact_id and b.tenant_id = c.tenant_id
         left join bd_conversation_state s
                on s.conversation_id = c.id and s.tenant_id = c.tenant_id
        where c.tenant_id = $1 and c.id = $2`,
      [job.tenantId, job.conversationId],
    );
    if (!rows[0]) return null;

    const keys = await tenantKeys(tx, deps.kek, job.tenantId);
    const email = rows[0].email_enc ? openField(keys, job.tenantId, rows[0].email_enc) : '';
    return { row: rows[0], email };
  });

  if (!state) return { status: 'skipped', deferred: [] };
  if (state.row.status === 'resolved') return { status: 'skipped', deferred: [] };

  const { row } = state;

  /* 2 — ask the brain, outside any transaction */
  //
  // `jid` is the flow's identity key, nothing more, so the conversation id
  // stands in for it. Decrypting a phone number to send it to another service
  // would put a personal field on the wire for no behaviour we would gain.
  const conversation: BdConversation = {
    jid: job.conversationId,
    name: row.contact_name ?? '',
    brand: row.brand_name ?? '',
    category: row.brand_category ?? '',
    node: row.node ?? 'new',
    outcome: row.outcome ?? 'followup',
    gadget_loops: row.gadget_loops ?? 0,
    unknown_streak: row.unknown_streak ?? 0,
    price_stage: row.price_stage ?? 0,
    email: state.email,
    meet_link: row.meet_link ?? '',
    stopped_reason: row.stopped_reason ?? '',
    last_inbound_at: iso(row.last_inbound_at),
    last_outbound_at: iso(row.last_outbound_at),
    meeting_at: iso(row.meeting_at),
  };

  const step = await deps.brain.step({ conversation, text: job.text, now });

  /* 3 — apply what came back */
  return applyActions(deps, {
    tenantId: job.tenantId,
    conversationId: job.conversationId,
    now,
    step,
  });
}

async function applyActions(
  deps: BdDeps,
  args: {
    tenantId: string; conversationId: string; now: Date;
    step: { intent: string; conversation: BdConversation; actions: BdAction[] };
  },
): Promise<BdOutcome> {
  const { step } = args;

  // The brain returns the mutated state; `set_node` carries the node change
  // separately, because the flow never writes `convo.node` itself. Applying
  // one without the other leaves a conversation that answers correctly once
  // and then never advances.
  const setNode = [...step.actions].reverse().find((a) => a.type === 'set_node');
  const next = {
    ...step.conversation,
    node: setNode?.type === 'set_node' ? setNode.node : step.conversation.node,
    outcome: setNode?.type === 'set_node' ? setNode.outcome : step.conversation.outcome,
  };

  const deferred = [...new Set(step.actions.filter((a) => !HANDLED.has(a.type)).map((a) => a.type))];
  const escalation = step.actions.find((a) => a.type === 'escalate');
  const sends = step.actions.filter((a): a is Extract<BdAction, { type: 'send' }> => a.type === 'send');

  const queued = await withTenant(deps.db, args.tenantId, async (tx) => {
    const messageIds: string[] = [];
    const ctx = { tx, tenantId: args.tenantId, kek: deps.kek };
    const keys = await tenantKeys(tx, deps.kek, args.tenantId);

    await tx.query(
      `insert into bd_conversation_state
         (tenant_id, conversation_id, node, outcome, gadget_loops, unknown_streak,
          price_stage, email_enc, meet_link, stopped_reason,
          last_inbound_at, last_outbound_at, meeting_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       on conflict (conversation_id) do update set
         node = excluded.node, outcome = excluded.outcome,
         gadget_loops = excluded.gadget_loops, unknown_streak = excluded.unknown_streak,
         price_stage = excluded.price_stage, email_enc = excluded.email_enc,
         meet_link = excluded.meet_link, stopped_reason = excluded.stopped_reason,
         last_inbound_at = excluded.last_inbound_at,
         last_outbound_at = excluded.last_outbound_at,
         meeting_at = excluded.meeting_at, updated_at = now()`,
      [
        args.tenantId, args.conversationId, next.node ?? 'new', next.outcome ?? 'followup',
        next.gadget_loops ?? 0, next.unknown_streak ?? 0, next.price_stage ?? 0,
        next.email ? sealField(keys, args.tenantId, next.email) : null,
        next.meet_link ?? '', next.stopped_reason ?? '',
        next.last_inbound_at ?? null,
        sends.length ? args.now.toISOString() : (next.last_outbound_at ?? null),
        next.meeting_at ?? null,
      ],
    );

    for (const send of sends) {
      const { messageId } = await queueOutboundMessage(ctx, {
        conversationId: args.conversationId,
        body: send.text,
        senderType: 'autopilot',
        templateName: send.key || null,
        now: args.now,
      });
      messageIds.push(messageId);
    }

    if (escalation?.type === 'escalate') {
      await tx.query(
        `update conversations set autopilot_mode = 'off', status = 'open'
          where tenant_id = $1 and id = $2`,
        [args.tenantId, args.conversationId],
      );
    }

    // Recorded, not printed and forgotten: a meeting booking or a follow-up
    // timer that this spike cannot execute must be findable afterwards, not
    // inferred from an absence.
    if (deferred.length || escalation) {
      await audit(tx, args.tenantId, {
        actorType: 'system',
        action: 'bd.draft',
        resourceType: 'conversation',
        resourceId: args.conversationId,
        meta: {
          intent: step.intent,
          node: next.node,
          sends: sends.length,
          deferred,
          ...(escalation?.type === 'escalate' ? { escalated: escalation.reason } : {}),
        },
      });
    }

    return messageIds;
  });

  // Outside the transaction, the way `autopilotDraft` does it: the relay
  // worker reads the message by id, so telling it before the insert commits
  // is a race it loses. Without this the reply sits in the outbox forever —
  // visible in the console, never delivered to WhatsApp or Instagram.
  for (const messageId of queued) {
    await deps.dispatch({
      queue: 'outbound.send',
      payload: { tenantId: args.tenantId, messageId },
    });
  }

  if (deferred.length) {
    console.warn(
      `[bd.draft] ${args.conversationId}: ${deferred.join(', ')} not wired yet — ` +
      `the flow asked for them and nothing executed them`,
    );
  }

  return {
    status: escalation ? 'handover' : sends.length ? 'replied' : 'skipped',
    intent: step.intent,
    deferred,
  };
}
