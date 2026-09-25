import {
  withTenant, tenantKeys, openField, sealField, queueOutboundMessage, createTask, setTaskCalendarEvent,
  recordBrandFromChat, fillContactStoreFromChat, audit, type Database, type Sql,
} from '@kirana/db';
import type { BdAction, BdBooking, BdBrainClient, BdConversation, BdTurn } from '../bdBrain.ts';

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

/**
 * What the flow calls the channel a conversation is on.
 *
 * `bd_bot.flow.dm_channel` reads `Conversation.source` ('' / 'instagram' /
 * 'facebook') to choose the DM opener over the WhatsApp form and to switch
 * on the DM → WhatsApp hand-off. In the bot the Meta transport records it;
 * here the channel row already knows, and the flow cannot infer it from a
 * UUID jid. Before this existed (24 Sep 2026) an Instagram DM was answered
 * with the WhatsApp qualification form and could never be moved to WhatsApp.
 */
export function bdSourceOf(channelKind: string | null | undefined): '' | 'instagram' | 'facebook' {
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

interface Row {
  contact_id: string; status: string; assignee_id: string | null;
  channel_kind: string;
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
    source: bdSourceOf(row.channel_kind),
  };

  // The recent turns go with every call, not just the booking ones: the
  // brain's engine needs them to know whether OUR last message asked the
  // focus question (so "lebih ke sales" is read as the answer and not as an
  // unclassifiable turn), whether the contact is repeating themselves, and
  // whether the text is our own message forwarded back. Read once, reused.
  const history = await withTenant(deps.db, job.tenantId, (tx) =>
    recentTurns({ tx, tenantId: job.tenantId, kek: deps.kek }, job.conversationId));

  const step = await deps.brain.step({ conversation, text: job.text, now, history });

  /* 2b — a decision to book is not a booking */
  //
  // `step` only says "book a meeting": choosing when needs a calendar and a
  // reading of what the contact actually asked for, neither of which a pure
  // state machine has. The brain's booking endpoint owns both, so the
  // decision is handed straight back to it along with the recent turns the
  // requested hour is usually hiding in.
  let booking: BdBooking | null = null;
  let offered: string[] = [];
  const propose = step.actions.find((a) => a.type === 'propose_slots');
  const wantsBooking = step.actions.some((a) => a.type === 'book_meeting');

  if (wantsBooking || propose) {
    try {
      if (wantsBooking) {
        booking = await deps.brain.book({ conversation: step.conversation, history, now });
      } else if (propose?.type === 'propose_slots') {
        // Agreement, with no time named yet. This is the turn a lead is most
        // likely to be lost on, so it must never go unanswered — the flow
        // even carries its own wording for a calendar it cannot reach.
        const result = await deps.brain.proposeSlots({
          conversation: step.conversation,
          fallbackText: propose.fallback_text,
          fallbackKey: propose.fallback_key,
          history,
          now,
        });
        offered = result.messages;
      }
    } catch (err) {
      // Never fatal to the reply. The contact agreed to a meeting; failing
      // the whole job here would leave them with silence, which is the one
      // outcome the flow's own failure paths exist to prevent.
      console.warn('[bd] scheduling step failed, continuing without it:', (err as Error).message);
      // The flow's own fallback is better than nothing when the calendar
      // could not be reached at all.
      if (!wantsBooking && propose?.type === 'propose_slots') offered = [propose.fallback_text];
    }
  }

  /* 3 — apply what came back */
  return applyActions(deps, {
    tenantId: job.tenantId,
    conversationId: job.conversationId,
    contactId: row.contact_id,
    assigneeId: row.assignee_id,
    knewBrand: !!row.brand_name,
    now,
    step,
    booking,
    offered,
  });
}

/**
 * Strip what WhatsApp's own formatting leaves on a captured name.
 *
 * The brand is read out of chat with a regex, and chat carries `*bold*`,
 * bullets and stray punctuation — the first name this captured live came
 * through as "* MCNASIA". Cleaning it here rather than in the flow keeps the
 * repair next to the thing that stores it, and a name that is nothing but
 * markup is dropped instead of written.
 */
function cleanBrandName(raw: string | undefined): string {
  const name = (raw ?? '')
    .replace(/[*_~`]/g, '')
    .replace(/^[\s•\-–—:]+/, '')
    .replace(/[\s•\-–—:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Nothing left but punctuation, or long enough to be a sentence rather
  // than a name.
  if (!/[a-z0-9]/i.test(name) || name.length > 60) return '';
  return name;
}

/** The last few turns, oldest first — what the brain reads to find a day and
 * hour the contact named a message or two ago, and to see its own last
 * message. `at` is real so the brain's loop breaker counts real minutes. */
async function recentTurns(
  ctx: { tx: Sql; tenantId: string; kek: Buffer }, conversationId: string,
): Promise<BdTurn[]> {
  const rows = await ctx.tx.query<{ direction: string; body_enc: string | null; created_at: Date }>(
    `select direction, body_enc, created_at from messages
      where tenant_id = $1 and conversation_id = $2
      order by created_at desc limit 8`,
    [ctx.tenantId, conversationId],
  );
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return rows
    .reverse()
    .map((r) => ({
      direction: (r.direction === 'inbound' ? 'in' : 'out') as 'in' | 'out',
      body: r.body_enc ? openField(keys, ctx.tenantId, r.body_enc) : '',
      at: new Date(r.created_at).toISOString(),
    }))
    .filter((t) => t.body);
}

async function applyActions(
  deps: BdDeps,
  args: {
    tenantId: string; conversationId: string; contactId: string; assigneeId: string | null;
    knewBrand: boolean; now: Date;
    step: { intent: string; conversation: BdConversation; actions: BdAction[] };
    booking: BdBooking | null;
    offered: string[];
  },
): Promise<BdOutcome> {
  const { step, booking, offered } = args;

  // The brain returns the mutated state; `set_node` carries the node change
  // separately, because the flow never writes `convo.node` itself. Applying
  // one without the other leaves a conversation that answers correctly once
  // and then never advances.
  const setNode = [...step.actions].reverse().find((a) => a.type === 'set_node');
  const next = {
    ...step.conversation,
    node: setNode?.type === 'set_node' ? setNode.node : step.conversation.node,
    outcome: setNode?.type === 'set_node' ? setNode.outcome : step.conversation.outcome,
    // The booking call advanced the conversation further than `step` did —
    // it is the one that knows the meeting time and the Meet link, and it
    // is the one that moved the node: the flow's `on_meeting_booked` sets
    // SCHEDULED inside `/v1/book`, not inside `/v1/step`. Taking only the
    // meeting fields left the row at `scheduling` after a successful
    // booking (found by the end-to-end smoke, 25 Sep 2026), so the brand's
    // next "ok, terima kasih" re-entered the booking branch instead of the
    // meeting-day handling — and the reminder/no-show ladder never armed.
    ...(booking ? {
      meeting_at: booking.meeting_at, meet_link: booking.meet_link,
      ...(booking.conversation.node ? { node: booking.conversation.node } : {}),
      ...(booking.conversation.outcome ? { outcome: booking.conversation.outcome } : {}),
    } : {}),
  };

  // A booking that ran is no longer deferred work — it happened, and its own
  // messages are below.
  const handled = new Set(HANDLED);
  if (booking) handled.add('book_meeting');
  if (offered.length) handled.add('propose_slots');
  const deferred = [...new Set(step.actions.filter((a) => !handled.has(a.type)).map((a) => a.type))];
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

    // What the booking decided to say — a confirmation, a list of open slots
    // when the requested hour was taken, or the "jadwalnya sedang saya
    // siapkan" holding line when the calendar could not be reached. Queued
    // the same way as any other reply so the outbox and the bridges handle
    // delivery unchanged.
    for (const text of [...(booking?.messages ?? []), ...offered]) {
      const { messageId } = await queueOutboundMessage(ctx, {
        conversationId: args.conversationId,
        body: text,
        senderType: 'autopilot',
        now: args.now,
      });
      messageIds.push(messageId);
    }

    // The bot reads "Nama Brand: …" off the form it asks every new lead to
    // fill in. Writing it down here is what stops an agent retyping what the
    // client already typed — and what keeps a meeting from being titled after
    // whatever the contact happened to be called.
    const capturedBrand = cleanBrandName(step.conversation.brand);
    if (!args.knewBrand && capturedBrand) {
      await recordBrandFromChat(ctx, {
        contactId: args.contactId,
        name: capturedBrand,
        category: step.conversation.category || null,
      });
      // The Client page reads its store columns off the contact, not off the
      // brand row — so filling one without the other leaves the page looking
      // exactly as empty as before.
      await fillContactStoreFromChat(ctx, {
        contactId: args.contactId,
        storeName: capturedBrand,
        storeStatus: 'aktif',
      });
    }

    // A booked meeting has to be visible to the people who will attend it,
    // not just recorded in the bot's own state. A `meeting` task carries it
    // onto Tugas and Kalender, and onto Client On Proses — which lists
    // contacts tagged `customer` and shows each one's nearest open meeting.
    if (booking?.booked && booking.meeting_at) {
      const { id: taskId, deduped } = await createTask(ctx, {
        contactId: args.contactId,
        conversationId: args.conversationId,
        title: `Meeting ${step.conversation.brand || step.conversation.name || 'Client'} x MCN Asia`,
        dueAt: new Date(booking.meeting_at),
        kind: 'meeting',
        meetingLink: booking.meet_link || null,
        notes: 'Dijadwalkan otomatis oleh chatbot BD.',
        assigneeId: args.assigneeId,
        createdBy: args.assigneeId,
      });
      // Not an error — `tasks_meeting_booking_key` doing exactly its job —
      // but worth a line in the log. This job re-running for a booking it
      // already wrote a task for is the stalled-lock scenario the raised
      // `lockDuration` in apps/worker/src/main.ts exists to prevent; seeing
      // this line again after that change would mean something else is now
      // causing the same double run.
      if (deduped) {
        console.warn(
          `[bd] duplicate meeting task suppressed for conversation ${args.conversationId} `
          + `at ${booking.meeting_at} — the booking task-creation step ran more than once`,
        );
      }
      // `createTask` has no column for this — it is a narrow follow-up write,
      // same as the official Google-connect path uses (see `syncMeetingCalendarEvent`
      // in apps/api/src/routes/tasks.ts). Only present when this very call is
      // the one that booked the event; a deduped re-run or a booking made
      // before `trained-cb` returned this id leaves it unset, and the
      // calendar view falls back to matching on the Meet link instead.
      if (booking.event_id) {
        await setTaskCalendarEvent(ctx, {
          taskId, calendarEventId: booking.event_id, calendarEventLink: booking.html_link ?? null,
        });
      }

      // Without the tag the meeting exists but the contact never appears on
      // Client On Proses, which is where the team looks for exactly this.
      await tx.query(
        `update contacts set tags = (
           select array_agg(distinct t) from unnest(tags || array['customer']) as t
         ) where tenant_id = $1 and id = $2 and not ('customer' = any(tags))`,
        [args.tenantId, args.contactId],
      );
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

  // A booking confirmation or a slot list is a reply too: the turn that
  // books the meeting has no `send` action of its own (its messages come
  // back from `/v1/book`), and reporting it as 'skipped' read as the bot
  // having said nothing on the one turn that mattered most (25 Sep 2026).
  const said = sends.length + (booking?.messages.length ?? 0) + offered.length;
  return {
    status: escalation ? 'handover' : said ? 'replied' : 'skipped',
    intent: step.intent,
    deferred,
  };
}
