import {
  withTenant, tenantKeys, openField, sealField, queueOutboundMessage, createTask, setTaskCalendarEvent,
  recordBrandFromChat, fillContactStoreFromChat, audit,
  chatbotOwnership, claimChatbotRun, finishChatbotRun, markBookingAttempted, setHandling,
  markChatbotRunExhausted, unsentChatbotReplies, recordSkippedChatbotRun,
  type Database, type Sql, type Handling, type ChatbotOwnership,
} from '@kirana/db';
import type { BdAction, BdBooking, BdBrainClient, BdConversation, BdStep, BdTurn } from '../bdBrain.ts';

/**
 * What the flow calls the channel a conversation is on.
 *
 * `bd_bot.flow.dm_channel` reads `Conversation.source` ('' / 'instagram' /
 * 'facebook') to choose the DM opener over the WhatsApp form and to switch
 * on the DM → WhatsApp hand-off. In the bot the Meta transport records it;
 * here the channel row already knows, and the flow cannot infer it from a
 * UUID jid. Before this existed an Instagram DM was answered with the
 * WhatsApp qualification form and could never be moved to WhatsApp.
 */
function bdSourceOf(channelKind: string | null | undefined): '' | 'instagram' | 'facebook' {
  switch (channelKind) {
    case 'instagram':
    case 'instagram_bridge':
      return 'instagram';
    case 'messenger':
    case 'messenger_bridge':
      return 'facebook';
    default:
      return '';
  }
}

/**
 * The trained-cb DM chatbot: one inbound message on a WhatsApp Web, Instagram
 * bridge or Messenger bridge conversation, answered by the `trained-cb` flow.
 *
 * Exactly one owner per conversation. A DM account switched on for the
 * chatbot is never answered by Autopilot, and a conversation a human holds
 * (`handling` other than `bot`) is never answered by the bot. Every message
 * gets one `chatbot_runs` row — a redelivered job is a duplicate, and two
 * messages on one thread are answered one after the other, in the order they
 * arrived, never together.
 *
 * The brain is called outside any transaction: holding a Postgres connection
 * open across a network call is how a worker pool starves. Replies are
 * written in one transaction that first re-reads `handling` under a row lock,
 * so a takeover that lands while the brain is thinking wins.
 */

export const CHATBOT_REPLY_QUEUE = 'chatbot.reply';

export interface ChatbotJob {
  tenantId: string;
  divisionId: string;
  conversationId: string;
  messageId: string;
  now?: Date;
}

export type ChatbotBrain = Pick<BdBrainClient, 'step' | 'book' | 'proposeSlots'>;

export interface ChatbotDeps {
  db: Database;
  kek: Buffer;
  /** Null when `BD_BRAIN_URL` is unset: every run is then recorded as skipped. */
  brain: ChatbotBrain | null;
  dispatch: (job: { queue: string; payload: unknown }) => Promise<void>;
}

export type ChatbotSkipReason =
  | 'duplicate' | 'disabled' | 'human_active' | 'not_found' | 'resolved'
  | 'brain_not_configured' | 'no_reply';

export type ChatbotOutcome =
  | { status: 'busy' }
  | { status: 'skipped'; reason: ChatbotSkipReason; runId?: string }
  | { status: 'replied' | 'handover'; runId: string; intent: string; handling: Handling; messageIds: string[] };

/** Actions this processor executes. The rest are recorded on the run and warned about. */
const HANDLED = new Set<BdAction['type']>(['send', 'set_node', 'cancel_timers', 'escalate']);

const TERMINAL_NODES = new Set(['handover', 'meeting_done']);

/* -------------------------------------------------------------------- logs */

type LogEvent =
  | 'chatbot_job_started' | 'chatbot_job_completed' | 'chatbot_job_failed'
  | 'chatbot_skipped_human_active' | 'chatbot_skipped_disabled' | 'chatbot_handoff'
  | 'chatbot_duplicate_skipped' | 'chatbot_busy_deferred' | 'chatbot_outbound_queued'
  | 'chatbot_scheduling_failed';

/** Ids and outcomes only — never a message body. */
function log(event: LogEvent, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...fields });
  if (event === 'chatbot_job_failed' || event === 'chatbot_scheduling_failed') console.error(line);
  else console.log(line);
}

const idsOf = (job: ChatbotJob) => ({
  tenantId: job.tenantId, divisionId: job.divisionId, conversationId: job.conversationId, messageId: job.messageId,
});

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/* ---------------------------------------------------------------- dispatch */

export interface ChatbotDispatchArgs {
  tenantId: string;
  divisionId: string;
  conversationId: string;
  channelId: string;
  messageId: string;
}

export type ChatbotDispatchResult = 'dispatched' | 'skipped_disabled' | 'skipped_human_active';

/**
 * Called once per newly ingested inbound DM on a bridge channel. Queues the
 * reply only when the division and the account have the chatbot on and the
 * conversation is still the bot's; otherwise the message waits for a person in
 * the inbox, with a skipped run recorded so it never holds a later message back.
 */
export async function chatbotDispatch(
  deps: Pick<ChatbotDeps, 'db' | 'dispatch'>, args: ChatbotDispatchArgs,
): Promise<ChatbotDispatchResult> {
  const ownership = await withTenant(deps.db, args.tenantId, async (tx) => {
    const ctx = { tx, tenantId: args.tenantId, divisionId: args.divisionId };
    const found = await ownershipKeepingOptOut(ctx, args.conversationId);
    const skipReason = !found ? null : !found.owned ? 'disabled' : found.handling !== 'bot' ? 'human_active' : null;
    if (skipReason) {
      await recordSkippedChatbotRun(ctx, {
        conversationId: args.conversationId, inboundMessageId: args.messageId, skipReason,
      });
    }
    return found;
  }, { divisionId: args.divisionId });

  if (!ownership?.owned) {
    log('chatbot_skipped_disabled', { ...args, stage: 'dispatch' });
    return 'skipped_disabled';
  }
  if (ownership.handling !== 'bot') {
    log('chatbot_skipped_human_active', {
      ...args, stage: 'dispatch', handling: ownership.handling, optOut: ownership.optOut,
    });
    return 'skipped_human_active';
  }

  const job: ChatbotJob = {
    tenantId: args.tenantId, divisionId: args.divisionId,
    conversationId: args.conversationId, messageId: args.messageId,
  };
  await deps.dispatch({ queue: CHATBOT_REPLY_QUEUE, payload: job });
  return 'dispatched';
}

/**
 * `chatbotOwnership`, with a contact's opt-out made to stick. The contact's
 * next thread after the one they opted out on starts on `bot` like any other;
 * it is moved to a person here, before the bot can say a word on it, and an
 * opted-out contact is never handed back (`resumeBot`).
 */
async function ownershipKeepingOptOut(
  ctx: { tx: Sql; tenantId: string; divisionId: string }, conversationId: string,
): Promise<ChatbotOwnership | null> {
  const ownership = await chatbotOwnership(ctx, conversationId);
  if (!ownership?.owned || !ownership.optOut || ownership.handling !== 'bot') return ownership;
  await setHandling(ctx, { conversationId, handling: 'human', onlyFrom: ['bot'] });
  return { ...ownership, handling: 'human' };
}

/* --------------------------------------------------------------- processor */

/**
 * The run was swept as stalled while this attempt was still working, and its
 * writes were rolled back. Thrown to the queue rather than swallowed: the
 * retry takes the message up again once the thread is free, and a booking
 * this attempt may have made is then handed to a person (`verify_booking`).
 */
export class LeaseLostError extends Error {
  constructor() {
    super('chatbot run lost its lease before it could record its answer');
  }
}

/**
 * `onBusy` runs when another message on this thread is still being answered,
 * or an earlier one has yet to be; the worker uses it to put the job back for
 * a few seconds without spending an attempt. Whatever it throws is passed
 * through.
 */
export async function processChatbotReply(
  deps: ChatbotDeps, job: ChatbotJob, opts: { onBusy?: () => Promise<void> } = {},
): Promise<ChatbotOutcome> {
  const ids = idsOf(job);
  // Stalled leases on this thread are swept inside the claim.
  const claim = await claimChatbotRun(deps.db, {
    tenantId: job.tenantId, divisionId: job.divisionId,
    conversationId: job.conversationId, inboundMessageId: job.messageId,
  });

  if (claim.outcome === 'duplicate') {
    const redispatched = claim.runId ? await redispatchUnsent(deps, job, claim.runId) : 0;
    log('chatbot_duplicate_skipped', { ...ids, runId: claim.runId, redispatched });
    return { status: 'skipped', reason: 'duplicate', runId: claim.runId };
  }
  if (claim.outcome === 'busy' || !claim.runId) {
    log('chatbot_busy_deferred', ids);
    await opts.onBusy?.();
    return { status: 'busy' };
  }

  const run = { runId: claim.runId, bookingAttemptedAt: claim.bookingAttemptedAt ?? null };
  log('chatbot_job_started', {
    ...ids, runId: run.runId, attempts: claim.attempts, reclaimed: claim.outcome === 'reclaimed',
  });

  try {
    const outcome = await answer(deps, job, run);
    log('chatbot_job_completed', {
      ...ids, runId: run.runId, status: outcome.status,
      ...(outcome.status === 'skipped' ? { reason: outcome.reason } : {}),
    });
    return outcome;
  } catch (err) {
    // The run is no longer this attempt's to write: it was swept, and may
    // already be another attempt's again.
    if (err instanceof LeaseLostError) {
      log('chatbot_job_failed', { ...ids, runId: run.runId, error: err.message });
      throw err;
    }
    await failRun(deps, job, run.runId, err);
    throw err;
  }
}

/**
 * Replies reach the outbound worker only after they commit. A job that died
 * between the two — Redis refused the hand-over, or the process was killed —
 * comes back as a duplicate and finishes the hand-over here. `processOutbound`
 * takes the message row under lock and skips anything no longer queued, so a
 * reply handed over twice still goes out once.
 */
async function redispatchUnsent(deps: ChatbotDeps, job: ChatbotJob, runId: string): Promise<number> {
  const unsent = await withTenant(deps.db, job.tenantId, (tx) =>
    unsentChatbotReplies({ tx, tenantId: job.tenantId, divisionId: job.divisionId }, runId),
  { divisionId: job.divisionId });
  await dispatchReplies(deps, job, runId, unsent);
  return unsent.length;
}

async function dispatchReplies(deps: ChatbotDeps, job: ChatbotJob, runId: string, messageIds: string[]): Promise<void> {
  for (const messageId of messageIds) {
    await deps.dispatch({ queue: 'outbound.send', payload: { tenantId: job.tenantId, messageId } });
    log('chatbot_outbound_queued', { ...idsOf(job), runId, replyMessageId: messageId });
  }
}

async function failRun(deps: ChatbotDeps, job: ChatbotJob, runId: string, err: unknown): Promise<void> {
  log('chatbot_job_failed', { ...idsOf(job), runId, error: errorText(err) });
  try {
    await withTenant(deps.db, job.tenantId, (tx) =>
      finishChatbotRun({ tx, tenantId: job.tenantId, divisionId: job.divisionId }, {
        runId, status: 'failed', error: errorText(err),
      }), { divisionId: job.divisionId });
  } catch (finishErr) {
    // The original error is what the queue needs to see; a stuck lease is swept later.
    log('chatbot_job_failed', { ...idsOf(job), runId, error: `could not record failure: ${errorText(finishErr)}` });
  }
}

interface Run { runId: string; bookingAttemptedAt: Date | null }

async function answer(deps: ChatbotDeps, job: ChatbotJob, run: Run): Promise<ChatbotOutcome> {
  const now = job.now ?? new Date();
  const gate = await readState(deps, job, run);
  if (gate.kind === 'skip') return { status: 'skipped', reason: gate.reason, runId: run.runId };

  const brained = await askBrain(deps, job, run, gate.state, now);
  const applied = await applyStep(deps, job, run, gate.state, brained, now);
  if (applied.kind === 'skip') return { status: 'skipped', reason: applied.reason, runId: run.runId };

  // After commit: the relay reads the message by id, so telling it before the
  // insert is visible is a race it loses.
  await dispatchReplies(deps, job, run.runId, applied.messageIds);
  if (applied.handoff) {
    log('chatbot_handoff', { ...idsOf(job), runId: run.runId, ...applied.handoff });
  }
  if (applied.deferred.length) {
    console.warn(JSON.stringify({
      event: 'chatbot_actions_deferred', ...idsOf(job), runId: run.runId, deferred: applied.deferred,
    }));
  }

  if (applied.status === 'skipped') return { status: 'skipped', reason: 'no_reply', runId: run.runId };
  return {
    status: applied.status, runId: run.runId, intent: brained.step.intent,
    handling: applied.handoff?.handling ?? 'bot', messageIds: applied.messageIds,
  };
}

/* ------------------------------------------------------------ 1 — the gate */

interface StateRow {
  contact_id: string; status: string; assignee_id: string | null;
  channel_kind: string;
  contact_name: string | null;
  brand_name: string | null; brand_category: string | null;
  node: string | null; outcome: string | null;
  gadget_loops: number | null; unknown_streak: number | null; price_stage: number | null;
  email_enc: string | null; meet_link: string | null; stopped_reason: string | null;
  last_inbound_at: Date | null; last_outbound_at: Date | null; meeting_at: Date | null;
}

interface State { row: StateRow; email: string; text: string }

type Gate = { kind: 'skip'; reason: ChatbotSkipReason } | { kind: 'go'; state: State };

/**
 * The ownership and hand-off checks again, now that the run holds the lease —
 * the switch may have been flipped or a human may have taken over since the
 * message was dispatched. A skip is recorded on the run in the same transaction.
 */
async function readState(deps: ChatbotDeps, job: ChatbotJob, run: Run): Promise<Gate> {
  return withTenant(deps.db, job.tenantId, async (tx) => {
    const ctx = { tx, tenantId: job.tenantId, divisionId: job.divisionId };
    const gate = await gateInTx(tx, deps, job);
    if (gate.kind === 'skip') {
      await finishChatbotRun(ctx, { runId: run.runId, status: 'skipped', skipReason: gate.reason });
      const fields = { ...idsOf(job), runId: run.runId, stage: 'run' };
      if (gate.reason === 'disabled') log('chatbot_skipped_disabled', fields);
      if (gate.reason === 'human_active') log('chatbot_skipped_human_active', fields);
    }
    return gate;
  }, { divisionId: job.divisionId });
}

async function gateInTx(tx: Sql, deps: ChatbotDeps, job: ChatbotJob): Promise<Gate> {
  const ownership = await ownershipKeepingOptOut(
    { tx, tenantId: job.tenantId, divisionId: job.divisionId }, job.conversationId);
  if (!ownership) return { kind: 'skip', reason: 'not_found' };
  if (!ownership.owned) return { kind: 'skip', reason: 'disabled' };
  if (ownership.handling !== 'bot') return { kind: 'skip', reason: 'human_active' };
  if (!deps.brain) return { kind: 'skip', reason: 'brain_not_configured' };

  const rows = await tx.query<StateRow>(
    `select c.contact_id, c.status, c.assignee_id,
            ch.kind as channel_kind,
            ct.display_name as contact_name,
            b.name as brand_name, b.category as brand_category,
            s.node, s.outcome, s.gadget_loops, s.unknown_streak, s.price_stage,
            s.email_enc, s.meet_link, s.stopped_reason,
            s.last_inbound_at, s.last_outbound_at, s.meeting_at
       from conversations c
       join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
       join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
       left join brands b on b.contact_id = c.contact_id and b.tenant_id = c.tenant_id
       left join bd_conversation_state s
              on s.conversation_id = c.id and s.tenant_id = c.tenant_id
      where c.tenant_id = $1 and c.id = $2`,
    [job.tenantId, job.conversationId],
  );
  const row = rows[0];
  if (!row) return { kind: 'skip', reason: 'not_found' };
  if (row.status === 'resolved') return { kind: 'skip', reason: 'resolved' };

  const inbound = await tx.query<{ body_enc: string | null }>(
    `select body_enc from messages
      where tenant_id = $1 and id = $2 and conversation_id = $3 and direction = 'inbound'`,
    [job.tenantId, job.messageId, job.conversationId],
  );
  if (!inbound[0]) return { kind: 'skip', reason: 'not_found' };

  const keys = await tenantKeys(tx, deps.kek, job.tenantId);
  const open = (sealed: string | null) => (sealed ? openField(keys, job.tenantId, sealed) : '');
  return { kind: 'go', state: { row, email: open(row.email_enc), text: open(inbound[0].body_enc) } };
}

/* ------------------------------------------------------------ 2 — the brain */

const iso = (d: Date | null) => (d === null ? null : new Date(d).toISOString());

/**
 * `jid` is the flow's identity key, nothing more, so the conversation id
 * stands in for it — decrypting a phone number to send it to another service
 * would put a personal field on the wire for no behaviour gained.
 */
function toBdConversation(conversationId: string, state: State): BdConversation {
  const { row } = state;
  return {
    jid: conversationId,
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
    source: bdSourceOf(row.channel_kind),
  };
}

type ProposeSlots = Extract<BdAction, { type: 'propose_slots' }>;

interface Brained {
  step: BdStep;
  booking: BdBooking | null;
  /** Slot proposals, or the flow's own fallback wording when the calendar could not be asked. */
  offered: string[];
  /** A booking may or may not have happened; a person has to look before anything else is said. */
  verifyBooking: boolean;
}

async function askBrain(deps: ChatbotDeps, job: ChatbotJob, run: Run, state: State, now: Date): Promise<Brained> {
  const brain = deps.brain!;
  // Every step, not just the scheduling calls: the brain's loop breaker,
  // echo check and "did we just ask the focus question" gate all read this.
  const history = await recentTurns(deps, job);
  const step = await brain.step({
    conversation: toBdConversation(job.conversationId, state), text: state.text, now, history,
  });
  const propose = step.actions.find((a): a is ProposeSlots => a.type === 'propose_slots');

  // `step` only decides to book; choosing when needs a calendar and a reading
  // of what the contact asked for, which the booking endpoint owns.
  if (step.actions.some((a) => a.type === 'book_meeting')) return bookOnce(deps, job, run, step, propose, now);
  if (!propose) return { step, booking: null, offered: [], verifyBooking: false };

  // Agreement with no time named yet — the turn a lead is most likely lost
  // on, so it is never left unanswered. Reuses the same turns `step` just read.
  try {
    const result = await brain.proposeSlots({
      conversation: step.conversation, fallbackText: propose.fallback_text, fallbackKey: propose.fallback_key,
      history, now,
    });
    return { step, booking: null, offered: result.messages, verifyBooking: false };
  } catch (err) {
    log('chatbot_scheduling_failed', { ...idsOf(job), runId: run.runId, action: 'propose_slots', error: errorText(err) });
    return { step, booking: null, offered: [propose.fallback_text], verifyBooking: false };
  }
}

/**
 * At most one call to the booking endpoint per inbound message, ever. The
 * attempt is committed before the call, so a run re-claimed after a crash, a
 * timeout or a failed write knows an event may already be on the calendar and
 * hands the conversation to a person instead of booking a second one.
 */
async function bookOnce(
  deps: ChatbotDeps, job: ChatbotJob, run: Run, step: BdStep, propose: ProposeSlots | undefined, now: Date,
): Promise<Brained> {
  const unsure: Brained = { step, booking: null, offered: propose ? [propose.fallback_text] : [], verifyBooking: true };
  const first = run.bookingAttemptedAt === null && await withTenant(deps.db, job.tenantId, (tx) =>
    markBookingAttempted({ tx, tenantId: job.tenantId, divisionId: job.divisionId }, run.runId),
  { divisionId: job.divisionId });
  if (!first) return unsure;

  const history = await recentTurns(deps, job);
  try {
    const booking = await deps.brain!.book({ conversation: step.conversation, history, now });
    return { step, booking, offered: [], verifyBooking: false };
  } catch (err) {
    log('chatbot_scheduling_failed', { ...idsOf(job), runId: run.runId, action: 'book_meeting', error: errorText(err) });
    return unsure;
  }
}

/** The last few turns, oldest first — what the brain reads for the loop
 * breaker, the echo check, and to find a day and hour the contact named a
 * message or two ago. `at` is real so the brain's time-windowed guards
 * count real minutes, not a turn placed an hour ago by default. */
async function recentTurns(deps: ChatbotDeps, job: ChatbotJob): Promise<BdTurn[]> {
  return withTenant(deps.db, job.tenantId, async (tx) => {
    const rows = await tx.query<{ direction: string; body_enc: string | null; created_at: Date; status: string }>(
      `select direction, body_enc, created_at, status from messages
        where tenant_id = $1 and conversation_id = $2
        order by created_at desc limit 8`,
      [job.tenantId, job.conversationId],
    );
    const keys = await tenantKeys(tx, deps.kek, job.tenantId);
    return [...rows]
      .reverse()
      // An outbound row the customer never actually received (still
      // `queued`, or `failed` after the bridge send didn't confirm) is not
      // something the bot already said — leaving it in here fed bd-brain's
      // own loop guard a message it thinks it already sent, so a customer
      // repeating themselves after a failed send got no reply at all
      // ("refusing to send the same message twice") instead of a retry.
      .filter((r) => r.direction === 'inbound' || ['sent', 'delivered', 'read'].includes(r.status))
      .map((r) => ({
        direction: (r.direction === 'inbound' ? 'in' : 'out') as 'in' | 'out',
        body: r.body_enc ? openField(keys, job.tenantId, r.body_enc) : '',
        at: new Date(r.created_at).toISOString(),
      }))
      .filter((t) => t.body);
  }, { divisionId: job.divisionId });
}

/* ------------------------------------------------------------ 3 — the apply */

interface Handoff { handling: Exclude<Handling, 'bot'>; reason: string }

type Applied =
  | { kind: 'skip'; reason: ChatbotSkipReason }
  | {
      kind: 'applied'; status: 'replied' | 'handover' | 'skipped';
      messageIds: string[]; handoff: Handoff | null; deferred: string[];
    };

/** Who holds the conversation after this step, if not the bot any more. */
function handoffOf(intent: string, node: string, verifyBooking: boolean): Handoff | null {
  if (verifyBooking) return { handling: 'needs_human', reason: 'verify_booking' };
  // Honoured permanently: a contact who opted out is never resumed.
  if (intent === 'opt_out' && node === 'stopped') return { handling: 'human', reason: 'opt_out' };
  if (TERMINAL_NODES.has(node)) return { handling: 'needs_human', reason: node };
  return null;
}

/** The action list as recorded on the run: kinds, keys and nodes, never text. */
function actionSummary(actions: BdAction[]): Record<string, unknown>[] {
  return actions.map((a) => {
    switch (a.type) {
      case 'send': return { type: a.type, key: a.key };
      case 'schedule': return { type: a.type, timer: a.timer, fire_at: a.fire_at };
      case 'set_node': return { type: a.type, node: a.node, outcome: a.outcome };
      case 'propose_slots': return { type: a.type, fallback_key: a.fallback_key };
      case 'escalate': return { type: a.type, reason: a.reason };
      default: return { type: a.type };
    }
  });
}

/**
 * The brain returns the mutated state; `set_node` carries the node change
 * separately because the flow never writes `convo.node` itself.
 */
function nextState(brained: Brained): BdConversation {
  const { step, booking } = brained;
  const setNode = [...step.actions].reverse().find((a) => a.type === 'set_node');
  const node = setNode?.type === 'set_node' ? setNode.node : step.conversation.node;
  const optOut = step.intent === 'opt_out' && node === 'stopped';
  return {
    ...step.conversation,
    node,
    outcome: setNode?.type === 'set_node' ? setNode.outcome : step.conversation.outcome,
    // The booking call advanced the conversation further than `step` did —
    // it is the one that knows the meeting time and the Meet link, and it
    // is the one that moved the node: the flow's `on_meeting_booked` sets
    // SCHEDULED inside `/v1/book`, not inside `/v1/step`. Taking only the
    // meeting fields left the row at `scheduling` after a successful
    // booking, so the brand's next "ok, terima kasih" re-entered the
    // booking branch instead of the meeting-day handling, and the
    // reminder/no-show ladder never armed.
    ...(booking ? {
      meeting_at: booking.meeting_at, meet_link: booking.meet_link,
      ...(booking.conversation.node ? { node: booking.conversation.node } : {}),
      ...(booking.conversation.outcome ? { outcome: booking.conversation.outcome } : {}),
    } : {}),
    ...(optOut ? { stopped_reason: 'opt_out' } : {}),
  };
}

async function applyStep(
  deps: ChatbotDeps, job: ChatbotJob, run: Run, state: State, brained: Brained, now: Date,
): Promise<Applied> {
  const { step } = brained;
  const next = nextState(brained);
  const handoff = handoffOf(step.intent, next.node ?? 'new', brained.verifyBooking);
  const escalate = step.actions.find((a) => a.type === 'escalate');
  const escalationReason = brained.verifyBooking ? 'verify_booking'
    : escalate?.type === 'escalate' ? escalate.reason : null;
  const handled = new Set(HANDLED);
  if (brained.booking) handled.add('book_meeting');
  if (brained.offered.length) handled.add('propose_slots');
  const deferred = [...new Set(step.actions.filter((a) => !handled.has(a.type)).map((a) => a.type))];
  const finish = { runId: run.runId, intent: step.intent, escalationReason, actions: actionSummary(step.actions) };

  return withTenant(deps.db, job.tenantId, async (tx) => {
    const ctx = { tx, tenantId: job.tenantId, kek: deps.kek, divisionId: job.divisionId };
    const current = await tx.query<{ handling: Handling }>(
      'select handling from conversations where tenant_id = $1 and id = $2 for update',
      [job.tenantId, job.conversationId],
    );
    if (current[0]?.handling !== 'bot') {
      await applyAfterTakeover(ctx, job, run, state, brained, next, finish);
      return { kind: 'skip', reason: 'human_active' } as const;
    }

    const sends = step.actions.filter((a): a is Extract<BdAction, { type: 'send' }> => a.type === 'send');
    await writeBdState(ctx, job.conversationId, next, sends.length ? now : null);
    const messageIds = await queueReplies(ctx, job.conversationId, [
      ...sends.map((s) => s.text), ...(brained.booking?.messages ?? []), ...brained.offered,
    ], now);
    await recordBrandAndMeeting(ctx, job.conversationId, state.row, step, brained.booking);
    if (escalate) {
      await tx.query(
        `update conversations set autopilot_mode = 'off', status = 'open' where tenant_id = $1 and id = $2`,
        [job.tenantId, job.conversationId],
      );
    }
    if (deferred.length || escalate) {
      await audit(tx, job.tenantId, {
        actorType: 'system', action: 'chatbot.reply', resourceType: 'conversation', resourceId: job.conversationId,
        meta: { intent: step.intent, node: next.node, sends: sends.length, deferred, escalated: escalationReason },
      });
    }
    if (handoff) await setHandling(ctx, { conversationId: job.conversationId, handling: handoff.handling });

    const status = handoff ? 'handover' : messageIds.length ? 'replied' : 'skipped';
    const finished = await finishChatbotRun(ctx, {
      ...finish, status, skipReason: status === 'skipped' ? 'no_reply' : null, replyMessageIds: messageIds,
    });
    // Swept as stalled and possibly re-claimed elsewhere: roll all of this back.
    if (!finished) throw new LeaseLostError();
    return { kind: 'applied', status, messageIds, handoff, deferred } as const;
  }, { divisionId: job.divisionId });
}

type ApplyCtx = { tx: Sql; tenantId: string; kek: Buffer; divisionId: string };

/**
 * A person took the thread while the brain was working, so the bot says
 * nothing more. A meeting the booking endpoint already put on the calendar is
 * still real: it is recorded (engine state, task, calendar link) and named on
 * the run, so the person now holding the thread sees it and confirms it —
 * and the bot, if handed back, does not book it a second time.
 */
async function applyAfterTakeover(
  ctx: ApplyCtx, job: ChatbotJob, run: Run, state: State, brained: Brained, next: BdConversation,
  finish: { runId: string; intent: string; escalationReason: string | null; actions: Record<string, unknown>[] },
): Promise<void> {
  const booked = brained.booking?.booked === true;
  if (booked) {
    await writeBdState(ctx, job.conversationId, next, null);
    await recordBrandAndMeeting(ctx, job.conversationId, state.row, brained.step, brained.booking);
  }
  const recorded = await finishChatbotRun(ctx, {
    ...finish, status: 'skipped', skipReason: 'human_active',
    escalationReason: booked ? 'booked_during_takeover' : finish.escalationReason,
  });
  if (!recorded) throw new LeaseLostError();
  log('chatbot_skipped_human_active', { ...idsOf(job), runId: run.runId, stage: 'apply', booked });
}

async function writeBdState(ctx: ApplyCtx, conversationId: string, next: BdConversation, sentAt: Date | null) {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  await ctx.tx.query(
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
      ctx.tenantId, conversationId, next.node ?? 'new', next.outcome ?? 'followup',
      next.gadget_loops ?? 0, next.unknown_streak ?? 0, next.price_stage ?? 0,
      next.email ? sealField(keys, ctx.tenantId, next.email) : null,
      next.meet_link ?? '', next.stopped_reason ?? '',
      next.last_inbound_at ?? null,
      sentAt ? sentAt.toISOString() : (next.last_outbound_at ?? null),
      next.meeting_at ?? null,
    ],
  );
}

/** Through the outbox like every other reply, so delivery and its retries are the bridges' business. */
async function queueReplies(ctx: ApplyCtx, conversationId: string, texts: string[], now: Date): Promise<string[]> {
  const ids: string[] = [];
  for (const body of texts) {
    const { messageId } = await queueOutboundMessage(ctx, { conversationId, body, senderType: 'bot', now });
    ids.push(messageId);
  }
  return ids;
}

/**
 * Strip what chat formatting leaves on a captured name — the first one
 * captured live came through as "* MCNASIA". A name that is nothing but
 * markup, or long enough to be a sentence, is dropped.
 */
function cleanBrandName(raw: string | undefined): string {
  const name = (raw ?? '')
    .replace(/[*_~`]/g, '')
    .replace(/^[\s•\-–—:]+/, '')
    .replace(/[\s•\-–—:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[a-z0-9]/i.test(name) || name.length > 60) return '';
  return name;
}

/**
 * The brand the bot read off the lead form, and a booked meeting as a task on
 * Tugas / Kalender / Client On Proses — so nobody retypes what the client
 * already typed, and the people attending can see the meeting.
 */
async function recordBrandAndMeeting(
  ctx: ApplyCtx, conversationId: string, row: StateRow, step: BdStep, booking: BdBooking | null,
): Promise<void> {
  const capturedBrand = cleanBrandName(step.conversation.brand);
  if (!row.brand_name && capturedBrand) {
    await recordBrandFromChat(ctx, {
      contactId: row.contact_id, name: capturedBrand, category: step.conversation.category || null,
    });
    await fillContactStoreFromChat(ctx, { contactId: row.contact_id, storeName: capturedBrand, storeStatus: 'aktif' });
  }
  if (!booking?.booked || !booking.meeting_at) return;

  const { id: taskId, deduped } = await createTask(ctx, {
    contactId: row.contact_id,
    conversationId,
    title: `Meeting ${step.conversation.brand || step.conversation.name || 'Client'} x MCN Asia`,
    dueAt: new Date(booking.meeting_at),
    kind: 'meeting',
    meetingLink: booking.meet_link || null,
    notes: 'Dijadwalkan otomatis oleh chatbot BD.',
    assigneeId: row.assignee_id,
    createdBy: row.assignee_id,
  });
  if (deduped) {
    console.warn(JSON.stringify({ event: 'chatbot_meeting_task_deduped', tenantId: ctx.tenantId, conversationId }));
  }
  if (booking.event_id) {
    await setTaskCalendarEvent(ctx, {
      taskId, calendarEventId: booking.event_id, calendarEventLink: booking.html_link ?? null,
    });
  }
  // Client On Proses lists contacts tagged `customer`.
  await ctx.tx.query(
    `update contacts set tags = (
       select array_agg(distinct t) from unnest(tags || array['customer']) as t
     ) where tenant_id = $1 and id = $2 and not ('customer' = any(tags))`,
    [ctx.tenantId, row.contact_id],
  );
}

/* ---------------------------------------------------------- exhausted jobs */

/**
 * The queue gave up on this message (retries spent, or an error no retry can
 * fix). The contact is still waiting, so the conversation goes to a person.
 */
export async function markChatbotExhausted(db: Database, job: ChatbotJob, error: string): Promise<void> {
  const moved = await withTenant(db, job.tenantId, async (tx) => {
    const ctx = { tx, tenantId: job.tenantId, divisionId: job.divisionId };
    const runs = await tx.query<{ id: string; status: string }>(
      'select id, status from chatbot_runs where tenant_id = $1 and inbound_message_id = $2',
      [job.tenantId, job.messageId],
    );
    const run = runs[0];
    // Answered, handed over or deliberately skipped: nothing is left waiting.
    if (run && run.status !== 'running' && run.status !== 'failed') return false;
    if (run) await markChatbotRunExhausted(ctx, { runId: run.id, error: error.slice(0, 500) });
    return setHandling(ctx, { conversationId: job.conversationId, handling: 'needs_human', onlyFrom: ['bot'] });
  }, { divisionId: job.divisionId });

  if (moved) log('chatbot_handoff', { ...idsOf(job), handling: 'needs_human', reason: 'exhausted' });
}
