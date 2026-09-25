import type { Ctx } from './repo.ts';
import type { Database, Sql } from './sql.ts';
import { withTenant } from './tenant.ts';
import { audit } from './audit.ts';
import { divisionSql } from './divisions.ts';

/**
 * The trained-cb DM chatbot's rows (migration 0061).
 *
 * The bot answers a conversation only when its division has the chatbot on,
 * its connected account has it on, the account is one of the DM bridges, and
 * the conversation's `handling` is still `bot`. Every piece of that is read
 * here, so the worker, the API and the console reach the same answer.
 */

export const CHATBOT_CHANNEL_KINDS = ['whatsapp_web', 'instagram_bridge', 'messenger_bridge'] as const;
export type ChatbotChannelKind = (typeof CHATBOT_CHANNEL_KINDS)[number];

export const HANDLING_STATES = ['bot', 'human', 'needs_human'] as const;
export type Handling = (typeof HANDLING_STATES)[number];

export type ChatbotRunStatus = 'running' | 'replied' | 'skipped' | 'handover' | 'failed';

/** A run still `running` after this long lost its worker, and with it the thread's lease. */
export const CHATBOT_LEASE_STALE_MS = 2 * 60_000;

/**
 * How long a failed run keeps later messages on its thread waiting for its
 * retry. The queue's 8 attempts, backing off from 2 s, span about four
 * minutes; a run the queue gave up on is marked `exhausted` and waits no one.
 */
export const CHATBOT_RETRY_WINDOW_MS = 5 * 60_000;

const LEASE_INDEX = 'chatbot_runs_running_lease';

/**
 * An opt-out belongs to the contact, not to the thread it was said on: once
 * that thread is resolved, the contact's next message opens a conversation
 * with no engine state of its own. Correlated on `c`, the conversation.
 */
const CONTACT_OPTED_OUT = `exists (
  select 1 from conversations oc
    join bd_conversation_state os on os.conversation_id = oc.id and os.tenant_id = oc.tenant_id
   where oc.tenant_id = c.tenant_id and oc.contact_id = c.contact_id and os.stopped_reason = 'opt_out')`;

/** The nodes trained-cb's own `release` puts back into Q&A. */
const RELEASABLE_NODES = ['handover', 'meeting_done', 'stopped'];

type ChatbotCtx = Pick<Ctx, 'tx' | 'tenantId' | 'divisionId'>;

const kinds = (): string[] => [...CHATBOT_CHANNEL_KINDS];

export function isChatbotChannelKind(kind: string): kind is ChatbotChannelKind {
  return (CHATBOT_CHANNEL_KINDS as readonly string[]).includes(kind);
}

/* ---------------------------------------------------------------- settings */

export interface ChatbotSettings {
  enabled: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The division's switch. A missing row is off. */
export async function getChatbotSettings(ctx: ChatbotCtx): Promise<ChatbotSettings> {
  const rows = await ctx.tx.query<{ enabled: boolean; updated_at: Date; updated_by: string | null }>(
    `select enabled, updated_at, updated_by from chatbot_settings
      where tenant_id = $1 and division_id = ${divisionSql(2)}`,
    [ctx.tenantId, ctx.divisionId ?? null],
  );
  const row = rows[0];
  if (!row) return { enabled: false, updatedAt: null, updatedBy: null };
  return { enabled: row.enabled, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

export async function setChatbotEnabled(
  ctx: ChatbotCtx, args: { enabled: boolean; actorId: string },
): Promise<ChatbotSettings> {
  const before = await getChatbotSettings(ctx);
  const rows = await ctx.tx.query<{ division_id: string; enabled: boolean; updated_at: Date; updated_by: string | null }>(
    `insert into chatbot_settings (tenant_id, division_id, enabled, updated_by, updated_at)
     values ($1, ${divisionSql(4)}, $2, $3, now())
     on conflict (tenant_id, division_id) do update set
       enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()
     returning division_id, enabled, updated_at, updated_by`,
    [ctx.tenantId, args.enabled, args.actorId, ctx.divisionId ?? null],
  );
  const row = rows[0]!;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'chatbot.settings_changed',
    resourceType: 'division', resourceId: row.division_id,
    meta: { enabled: row.enabled, previous: before.enabled },
  });
  return { enabled: row.enabled, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

/* ---------------------------------------------------------------- channels */

export interface ChatbotChannelRow {
  id: string;
  kind: ChatbotChannelKind;
  display_name: string;
  status: string;
  chatbot_enabled: boolean;
}

/** The division's DM accounts the chatbot can serve, each with its own switch. */
export async function listChatbotChannels(ctx: ChatbotCtx): Promise<ChatbotChannelRow[]> {
  return ctx.tx.query<{
    id: string; kind: ChatbotChannelKind; display_name: string; status: string; chatbot_enabled: boolean;
  }>(
    `select id, kind, display_name, status, chatbot_enabled from channels
      where tenant_id = $1 and division_id = ${divisionSql(2)} and kind = any($3::text[])
      order by created_at`,
    [ctx.tenantId, ctx.divisionId ?? null, kinds()],
  );
}

/** Null when the channel is not visible here or is not a kind the chatbot serves. */
export async function setChannelChatbotEnabled(
  ctx: ChatbotCtx, args: { channelId: string; enabled: boolean; actorId: string },
): Promise<ChatbotChannelRow | null> {
  const rows = await ctx.tx.query<{
    id: string; kind: ChatbotChannelKind; display_name: string; status: string; chatbot_enabled: boolean;
  }>(
    `update channels set chatbot_enabled = $3
      where tenant_id = $1 and id = $2 and kind = any($4::text[])
      returning id, kind, display_name, status, chatbot_enabled`,
    [ctx.tenantId, args.channelId, args.enabled, kinds()],
  );
  const row = rows[0];
  if (!row) return null;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'channel.chatbot_changed',
    resourceType: 'channel', resourceId: row.id, meta: { kind: row.kind, enabled: row.chatbot_enabled },
  });
  return row;
}

/* --------------------------------------------------------------- ownership */

export interface ChatbotOwnership {
  /** trained-cb owns this conversation — Autopilot must never act on it, whatever `handling` says. */
  owned: boolean;
  divisionEnabled: boolean;
  channelEnabled: boolean;
  channelKind: string;
  handling: Handling;
  /** The contact opted out, on this conversation or an earlier one. */
  optOut: boolean;
  divisionId: string;
}

/**
 * Keyed on the conversation's own division, not the caller's, so a job that
 * runs tenant-wide still reads the right switch. `lock` takes the
 * conversation row for the rest of the transaction — the re-check that makes
 * a takeover landing mid-run win.
 */
export async function chatbotOwnership(
  ctx: ChatbotCtx, conversationId: string, opts: { lock?: boolean } = {},
): Promise<ChatbotOwnership | null> {
  const rows = await ctx.tx.query<{
    handling: Handling; division_id: string; channel_kind: string; channel_enabled: boolean;
    division_enabled: boolean; opt_out: boolean;
  }>(
    `select c.handling, c.division_id, ch.kind as channel_kind, ch.chatbot_enabled as channel_enabled,
            coalesce(cs.enabled, false) as division_enabled,
            ${CONTACT_OPTED_OUT} as opt_out
       from conversations c
       join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
       left join chatbot_settings cs on cs.tenant_id = c.tenant_id and cs.division_id = c.division_id
      where c.tenant_id = $1 and c.id = $2
      ${opts.lock ? 'for update of c' : ''}`,
    [ctx.tenantId, conversationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    owned: row.division_enabled && row.channel_enabled && isChatbotChannelKind(row.channel_kind),
    divisionEnabled: row.division_enabled,
    channelEnabled: row.channel_enabled,
    channelKind: row.channel_kind,
    handling: row.handling,
    optOut: row.opt_out,
    divisionId: row.division_id,
  };
}

/* -------------------------------------------------------------------- runs */

export interface ChatbotClaim {
  outcome: 'claimed' | 'reclaimed' | 'duplicate' | 'busy';
  /** Set unless `busy`. */
  runId?: string;
  attempts?: number;
  /** Set on a reclaim whose earlier attempt already reached the booking endpoint: it must not book again. */
  bookingAttemptedAt?: Date | null;
}

/**
 * One run per inbound message, one running run per conversation.
 *
 * `duplicate` — this message was already answered (or deliberately not);
 * `busy` — another message on the thread, or this one on another worker, is
 * in flight, or an earlier message on the thread has yet to be answered, so
 * try again shortly; `reclaimed` — an earlier attempt failed
 * and this one takes over its row. Runs in a transaction of its own because
 * losing the lease race surfaces as a unique violation, which aborts the
 * transaction it happens in.
 */
export async function claimChatbotRun(
  db: Database,
  args: { tenantId: string; divisionId?: string | null; conversationId: string; inboundMessageId: string },
): Promise<ChatbotClaim> {
  try {
    return await withTenant(db, args.tenantId, (tx) => claimInTx(tx, args), { divisionId: args.divisionId });
  } catch (err) {
    if (isLeaseConflict(err)) return { outcome: 'busy' };
    throw err;
  }
}

async function claimInTx(
  tx: Sql, args: { tenantId: string; conversationId: string; inboundMessageId: string },
): Promise<ChatbotClaim> {
  await releaseStalledRuns({ tx, tenantId: args.tenantId }, { conversationId: args.conversationId });

  const existing = await tx.query<{ id: string; status: ChatbotRunStatus }>(
    `select id, status from chatbot_runs
      where tenant_id = $1 and inbound_message_id = $2
      for update`,
    [args.tenantId, args.inboundMessageId],
  );
  const run = existing[0];
  if (run?.status === 'running') return { outcome: 'busy' };
  if (run && run.status !== 'failed') return { outcome: 'duplicate', runId: run.id };
  if (await earlierMessagePending(tx, args)) return { outcome: 'busy' };

  if (run) {
    const reclaimed = await tx.query<{ id: string; attempts: number; booking_attempted_at: Date | null }>(
      `update chatbot_runs
          set status = 'running', attempts = attempts + 1, started_at = now(), finished_at = null,
              error = null, skip_reason = null
        where tenant_id = $1 and id = $2
          and not exists (
            select 1 from chatbot_runs r
             where r.conversation_id = chatbot_runs.conversation_id and r.status = 'running')
        returning id, attempts, booking_attempted_at`,
      [args.tenantId, run.id],
    );
    const row = reclaimed[0];
    if (!row) return { outcome: 'busy' };
    return { outcome: 'reclaimed', runId: row.id, attempts: row.attempts, bookingAttemptedAt: row.booking_attempted_at };
  }

  // Either unique index can turn this into a no-op: a concurrent job wrote
  // this message's run first, or another message on the thread holds the
  // lease. Both mean "not now".
  const inserted = await tx.query<{ id: string; attempts: number }>(
    `insert into chatbot_runs (tenant_id, conversation_id, inbound_message_id, status, attempts)
     values ($1, $2, $3, 'running', 1)
     on conflict do nothing
     returning id, attempts`,
    [args.tenantId, args.conversationId, args.inboundMessageId],
  );
  const row = inserted[0];
  if (!row) return { outcome: 'busy' };
  return { outcome: 'claimed', runId: row.id, attempts: row.attempts, bookingAttemptedAt: null };
}

/**
 * Records that an inbound message was never handed to the bot — it came in
 * while a person held the thread, or with the chatbot off — so it is not taken
 * for one still on its way to a worker (`earlierMessagePending`), and the
 * first message after a hand-back or a switch-on is answered at once.
 */
export async function recordSkippedChatbotRun(
  ctx: ChatbotCtx, args: { conversationId: string; inboundMessageId: string; skipReason: string },
): Promise<void> {
  await ctx.tx.query(
    `insert into chatbot_runs (tenant_id, conversation_id, inbound_message_id, status, skip_reason, attempts, finished_at)
     values ($1, $2, $3, 'skipped', $4, 0, now())
     on conflict (tenant_id, inbound_message_id) do nothing`,
    [ctx.tenantId, args.conversationId, args.inboundMessageId, args.skipReason],
  );
}

/**
 * The lease keeps two messages on a thread from being answered at once; this
 * keeps them in the order they arrived. An earlier message still on its way
 * to a worker, or failed and waiting for its retry, goes first. A message that
 * was never dispatched has a skipped run (`recordSkippedChatbotRun`) and one
 * the queue gave up on is marked exhausted, so neither holds anything up; the
 * no-run wait is bounded as well, for a job lost between ingest and the queue.
 */
async function earlierMessagePending(
  tx: Sql, args: { tenantId: string; conversationId: string; inboundMessageId: string },
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `select m.id
       from messages m
       join messages cur on cur.tenant_id = m.tenant_id and cur.id = $3
       left join chatbot_runs r on r.tenant_id = m.tenant_id and r.inbound_message_id = m.id
      where m.tenant_id = $1 and m.conversation_id = $2 and m.direction = 'inbound'
        and (m.created_at, m.id) < (cur.created_at, cur.id)
        and ((r.id is null and m.created_at > now() - ($4::int * interval '1 millisecond'))
          or (r.status = 'failed' and r.skip_reason is distinct from 'exhausted'
              and r.finished_at > now() - ($5::int * interval '1 millisecond')))
      limit 1`,
    [args.tenantId, args.conversationId, args.inboundMessageId, CHATBOT_LEASE_STALE_MS, CHATBOT_RETRY_WINDOW_MS],
  );
  return rows.length > 0;
}

function isLeaseConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; constraint_name?: string; message?: string } | null;
  if (e?.code !== '23505') return false;
  return [e.constraint, e.constraint_name, e.message].some((v) => typeof v === 'string' && v.includes(LEASE_INDEX));
}

/** Frees leases whose worker died. Returns how many it released. */
export async function releaseStalledRuns(
  ctx: Pick<ChatbotCtx, 'tx' | 'tenantId'>, opts: { conversationId?: string; olderThanMs?: number } = {},
): Promise<number> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update chatbot_runs set status = 'failed', error = 'stalled', finished_at = now()
      where tenant_id = $1 and status = 'running'
        and started_at < now() - ($2::int * interval '1 millisecond')
        and ($3::uuid is null or conversation_id = $3)
      returning id`,
    [ctx.tenantId, opts.olderThanMs ?? CHATBOT_LEASE_STALE_MS, opts.conversationId ?? null],
  );
  return rows.length;
}

export interface FinishChatbotRunArgs {
  runId: string;
  status: Exclude<ChatbotRunStatus, 'running'>;
  skipReason?: string | null;
  error?: string | null;
  intent?: string | null;
  escalationReason?: string | null;
  actions?: unknown[];
  replyMessageIds?: string[];
}

/**
 * False when the run no longer holds its lease (swept as stalled, possibly
 * reclaimed by another worker) — the caller's transaction must then roll
 * back rather than apply a second answer.
 */
export async function finishChatbotRun(ctx: ChatbotCtx, args: FinishChatbotRunArgs): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update chatbot_runs
        set status = $3, skip_reason = $4, error = $5, intent = $6, escalation_reason = $7,
            actions = $8::jsonb, reply_message_ids = $9::uuid[], finished_at = now()
      where tenant_id = $1 and id = $2 and status = 'running'
      returning id`,
    [ctx.tenantId, args.runId, args.status, args.skipReason ?? null, args.error?.slice(0, 2000) ?? null,
     args.intent ?? null, args.escalationReason ?? null, JSON.stringify(args.actions ?? []),
     args.replyMessageIds ?? []],
  );
  return rows.length > 0;
}

/**
 * The queue gave up on this run's message. It stays failed, and stops holding
 * later messages on its thread back (see `earlierMessagePending`).
 */
export async function markChatbotRunExhausted(
  ctx: ChatbotCtx, args: { runId: string; error: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update chatbot_runs
        set status = 'failed', skip_reason = 'exhausted', error = coalesce(error, $3),
            finished_at = coalesce(finished_at, now())
      where tenant_id = $1 and id = $2 and status in ('running', 'failed')
      returning id`,
    [ctx.tenantId, args.runId, args.error.slice(0, 2000)],
  );
  return rows.length > 0;
}

/**
 * A finished run's replies the outbound worker has not taken yet, in the
 * order they were written. A redelivered job hands them over again, in case
 * the first hand-over never reached the queue.
 */
export async function unsentChatbotReplies(ctx: ChatbotCtx, runId: string): Promise<string[]> {
  const rows = await ctx.tx.query<{ id: string }>(
    `select m.id
       from chatbot_runs r
       cross join lateral unnest(r.reply_message_ids) with ordinality as u(message_id, pos)
       join messages m on m.tenant_id = r.tenant_id and m.id = u.message_id
      where r.tenant_id = $1 and r.id = $2 and r.status <> 'running' and m.status = 'queued'
      order by u.pos`,
    [ctx.tenantId, runId],
  );
  return rows.map((r) => r.id);
}

/**
 * Committed before the booking endpoint is called. True the first time;
 * false means an earlier attempt already tried to book, and this one must not.
 */
export async function markBookingAttempted(ctx: ChatbotCtx, runId: string): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update chatbot_runs set booking_attempted_at = now()
      where tenant_id = $1 and id = $2 and booking_attempted_at is null
      returning id`,
    [ctx.tenantId, runId],
  );
  return rows.length > 0;
}

/* ---------------------------------------------------------------- handling */

export async function setHandling(
  ctx: ChatbotCtx,
  args: { conversationId: string; handling: Handling; onlyFrom?: readonly Handling[] },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update conversations set handling = $3
      where tenant_id = $1 and id = $2 and ($4::text[] is null or handling = any($4::text[]))
      returning id`,
    [ctx.tenantId, args.conversationId, args.handling, args.onlyFrom ? [...args.onlyFrom] : null],
  );
  return rows.length > 0;
}

export interface TakeoverResult {
  assigneeId: string | null;
  /** Bot replies that were still waiting in the outbox and now never will be sent. */
  cancelledMessageIds: string[];
}

/**
 * A human takes the conversation: the bot stops, the agent is assigned if
 * nobody was, and bot replies not yet handed to a provider are cancelled in
 * the same transaction so none of them goes out after the agent's first word.
 */
export async function takeoverConversation(
  ctx: ChatbotCtx, args: { conversationId: string; actorId: string },
): Promise<TakeoverResult | null> {
  const current = await ctx.tx.query<{ handling: Handling; assignee_id: string | null }>(
    `select handling, assignee_id from conversations where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, args.conversationId],
  );
  if (!current[0]) return null;

  const updated = await ctx.tx.query<{ assignee_id: string | null }>(
    `update conversations set handling = 'human', assignee_id = coalesce(assignee_id, $3)
      where tenant_id = $1 and id = $2
      returning assignee_id`,
    [ctx.tenantId, args.conversationId, args.actorId],
  );

  const cancelled = await ctx.tx.query<{ id: string }>(
    `update messages
        set status = 'failed', error = jsonb_build_object('reason', 'bot_cancelled_by_takeover')
      where tenant_id = $1 and conversation_id = $2 and sender_type = 'bot' and status = 'queued'
      returning id`,
    [ctx.tenantId, args.conversationId],
  );
  const cancelledMessageIds = cancelled.map((r) => r.id);
  if (cancelledMessageIds.length) {
    await ctx.tx.query(
      'delete from message_outbox where tenant_id = $1 and message_id = any($2::uuid[])',
      [ctx.tenantId, cancelledMessageIds],
    );
  }

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'chatbot.takeover',
    resourceType: 'conversation', resourceId: args.conversationId,
    meta: {
      from: current[0].handling,
      selfAssigned: current[0].assignee_id === null,
      cancelled: cancelledMessageIds.length,
    },
  });

  return { assigneeId: updated[0]?.assignee_id ?? null, cancelledMessageIds };
}

export type ResumeResult = 'resumed' | 'opt_out' | 'not_found';

/**
 * Hands the conversation back to the bot. After a handover or a finished
 * meeting the flow is put back into Q&A the way trained-cb's own `release`
 * does it; a contact who opted out is never resumed.
 */
export async function resumeBot(
  ctx: ChatbotCtx, args: { conversationId: string; actorId: string },
): Promise<ResumeResult> {
  const rows = await ctx.tx.query<{ handling: Handling; node: string | null; opt_out: boolean }>(
    `select c.handling, s.node, ${CONTACT_OPTED_OUT} as opt_out
       from conversations c
       left join bd_conversation_state s on s.conversation_id = c.id and s.tenant_id = c.tenant_id
      where c.tenant_id = $1 and c.id = $2
      for update of c`,
    [ctx.tenantId, args.conversationId],
  );
  const row = rows[0];
  if (!row) return 'not_found';
  if (row.opt_out) return 'opt_out';

  await ctx.tx.query(
    `update conversations set handling = 'bot' where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.conversationId],
  );

  const released = row.node !== null && RELEASABLE_NODES.includes(row.node);
  if (released) {
    await ctx.tx.query(
      `update bd_conversation_state
          set node = 'qna', outcome = 'followup', unknown_streak = 0, updated_at = now()
        where tenant_id = $1 and conversation_id = $2`,
      [ctx.tenantId, args.conversationId],
    );
  }

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'chatbot.resumed',
    resourceType: 'conversation', resourceId: args.conversationId,
    meta: { from: row.handling, releasedNode: released ? row.node : null },
  });
  return 'resumed';
}

/**
 * Why the bot last asked for a person, if its latest word on the thread did.
 * Read from the newest run that got past the gate — a message skipped because
 * a person already had the thread says nothing about why — so a reason from an
 * earlier episode is never shown for a later hand-over.
 */
export async function currentEscalationReason(ctx: ChatbotCtx, conversationId: string): Promise<string | null> {
  const rows = await ctx.tx.query<{ escalation_reason: string | null }>(
    `select escalation_reason from chatbot_runs
      where tenant_id = $1 and conversation_id = $2 and status <> 'running'
        and not (status = 'skipped' and intent is null and escalation_reason is null)
      order by started_at desc
      limit 1`,
    [ctx.tenantId, conversationId],
  );
  return rows[0]?.escalation_reason ?? null;
}

/** Open conversations on the division's chatbot accounts, by who is handling them. */
export async function chatbotHandlingCounts(ctx: ChatbotCtx): Promise<Record<Handling, number>> {
  const rows = await ctx.tx.query<{ handling: Handling; n: number }>(
    `select c.handling, count(*)::int as n
       from conversations c
       join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
      where c.tenant_id = $1 and c.division_id = ${divisionSql(2)}
        and c.status <> 'resolved' and ch.kind = any($3::text[])
      group by c.handling`,
    [ctx.tenantId, ctx.divisionId ?? null, kinds()],
  );
  const counts: Record<Handling, number> = { bot: 0, human: 0, needs_human: 0 };
  return rows.reduce((acc, r) => ({ ...acc, [r.handling]: r.n }), counts);
}
