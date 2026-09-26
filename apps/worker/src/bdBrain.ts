import { UnrecoverableError } from 'bullmq';

/**
 * The only code path that asks the BD brain (`apps/bd-brain`, served by
 * `python -m bd_bot brain-serve`) what to say next — the BD counterpart to
 * `AutopilotModel`, the way `WaBridgeClient` is the unofficial counterpart to
 * `GraphMetaClient`.
 *
 * The service is stateless: this sends the conversation's current state and
 * the inbound text, and gets back the same state (mutated) plus a list of
 * actions. Nothing is stored there, so a restart loses nothing and two tenants
 * cannot meet — the state never leaves this database except for the duration
 * of one call.
 *
 * Two things ride along with the state, because the brain runs the bot's
 * real engine and that engine looks them up in a database it does not have
 * here: `source`, which tells the flow whether this is a WhatsApp thread or
 * an Instagram/Facebook DM (the jid is a UUID, so nothing else can), and
 * `history`, the recent turns, which feed the loop breaker, the echo check,
 * the "did we just ask for the focus" gate and slot picking. Both come out
 * of this database on every call, so the brain still keeps nothing.
 */

/** Mirrors `bd_bot.models.Conversation`, field for field. */
export interface BdConversation {
  jid: string;
  name?: string;
  brand?: string;
  category?: string;
  node?: string;
  outcome?: string;
  gadget_loops?: number;
  email?: string;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  meeting_at?: string | null;
  meet_link?: string;
  unknown_streak?: number;
  price_stage?: number;
  stopped_reason?: string;
  /** `''` for WhatsApp, `'instagram'` or `'facebook'` for a Meta DM. Decides
   * the DM opener over the WhatsApp form and switches on the DM → WhatsApp
   * hand-off (`bd_bot.flow.dm_channel`). */
  source?: string;
}

/** One recent turn, oldest first in a list. `at` lets the brain's
 * time-windowed guards (the loop breaker) see real timestamps; without it
 * the brain places the turn an hour ago. */
export interface BdTurn {
  direction: 'in' | 'out';
  body: string;
  at?: string;
}

export type BdAction =
  | { type: 'send'; text: string; key: string; attach_company_profile: boolean;
      attach_opening: boolean; attach_case_study: boolean; attach_ads_deck: boolean }
  | { type: 'schedule'; timer: string; fire_at: string }
  | { type: 'cancel_timers' }
  | { type: 'set_node'; node: string; outcome: string }
  | { type: 'book_meeting'; preferred: string }
  | { type: 'propose_slots'; fallback_text: string; fallback_key: string }
  | { type: 'notify_group'; text: string }
  | { type: 'escalate'; reason: string; inbound_text: string };

export interface BdStep {
  intent: string;
  conversation: Required<Pick<BdConversation, 'jid'>> & BdConversation;
  actions: BdAction[];
}

/** `BD_BRAIN_TIMEOUT_MS` when unset or unreadable. */
export const DEFAULT_BD_BRAIN_TIMEOUT_MS = 10_000;

/** Booking and slot proposals talk to Google Calendar and may read the
 * conversation with an LLM, so they never get less than this. */
const SCHEDULING_TIMEOUT_FLOOR_MS = 45_000;

/**
 * `BD_BRAIN_TIMEOUT_MS` is held under this so a step plus a booking stays well
 * inside the thread's lease (`CHATBOT_LEASE_STALE_MS`, 2 minutes); past it the
 * lease is swept from under a run that is still working.
 */
export const MAX_BD_BRAIN_TIMEOUT_MS = 30_000;

/** trained-cb reads "now" as Jakarta wall-clock time, so the offset travels with it. */
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export function jakartaIso(d: Date): string {
  return new Date(d.getTime() + JAKARTA_OFFSET_MS).toISOString().replace('Z', '+07:00');
}

/** Null when `BD_BRAIN_URL` is unset — the chatbot then records every run as `brain_not_configured`. */
export function bdBrainFromEnv(source: NodeJS.ProcessEnv = process.env): BdBrainClient | null {
  if (!source.BD_BRAIN_URL) return null;
  const timeout = Number(source.BD_BRAIN_TIMEOUT_MS);
  return new BdBrainClient(
    source.BD_BRAIN_URL,
    source.BD_BRAIN_SECRET ?? '',
    Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_BD_BRAIN_TIMEOUT_MS) : DEFAULT_BD_BRAIN_TIMEOUT_MS,
  );
}

/**
 * 400 is our payload being wrong, 401 our secret, 404 a route this brain does
 * not serve; none is fixed by trying again eight times with backoff, so the
 * queue is told not to.
 */
async function brainFailure(what: string, res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  const message = `bd-brain ${what} failed: ${res.status} ${text}`;
  return res.status === 400 || res.status === 401 || res.status === 404
    ? new UnrecoverableError(message)
    : new Error(message);
}

export class BdBrainClient {
  constructor(
    private baseUrl: string,
    private secret: string,
    readonly timeoutMs = DEFAULT_BD_BRAIN_TIMEOUT_MS,
  ) {}

  /**
   * One inbound message through the BD flow.
   *
   * The timeout is this side's business: the brain runs Indonesian pattern
   * rules in microseconds, but `intents.classify` falls through to Claude for
   * what the rules cannot place, and an SDK call with no ceiling would hold a
   * worker for minutes. Ten seconds is generous for the fallback and still
   * short enough that the queue's backoff, not this call, decides how long a
   * message waits.
   *
   * `history` is the same recent-turns list `book` and `proposeSlots` get.
   * It may include the message being stepped as its newest turn — the CRM
   * records a message before it asks about it — and the brain drops that
   * copy itself, so the caller need not.
   */
  async step(args: {
    conversation: BdConversation;
    text: string;
    now: Date;
    history?: BdTurn[];
    intent?: string;
  }): Promise<BdStep> {
    const res = await fetch(`${this.baseUrl}/v1/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({
        conversation: args.conversation,
        text: args.text,
        now: jakartaIso(args.now),
        history: args.history ?? [],
        ...(args.intent ? { intent: args.intent } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) throw await brainFailure('step', res);

    return (await res.json()) as BdStep;
  }

  /**
   * Ask the brain to actually book the meeting it just decided on.
   *
   * `/v1/step` is a pure state machine — it answers "book a meeting" and
   * stops, because choosing *when* needs a calendar and a reading of what the
   * contact asked for, and `step` has neither. This second call is where that
   * happens, on the side that owns both: it reads the requested day and hour
   * out of the conversation, checks the calendar for a genuinely free slot,
   * and books it with a Meet link.
   *
   * `history` is what makes that possible — the preferred hour is routinely
   * mentioned a message or two before the one that triggered the booking.
   *
   * It may legitimately come back `booked: false`: the day can be full, the
   * hour taken, or the calendar unreachable. The messages it returns still
   * have to go out — a contact who just agreed to a meeting and then hears
   * nothing is the one outcome worse than a late booking.
   */
  async book(args: {
    conversation: BdConversation;
    history: BdTurn[];
    now: Date;
  }): Promise<BdBooking> {
    const res = await fetch(`${this.baseUrl}/v1/book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({
        conversation: args.conversation,
        history: args.history,
        now: jakartaIso(args.now),
      }),
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, SCHEDULING_TIMEOUT_FLOOR_MS)),
    });

    if (!res.ok) throw await brainFailure('book', res);

    return (await res.json()) as BdBooking;
  }

  /**
   * Offer the free slots the flow just asked us to offer.
   *
   * This is what answers an agreement — the contact said yes but not when,
   * and `book_meeting` does not fire until they name a time. Leaving it
   * unhandled is silence at the single turn where silence costs a lead.
   *
   * `fallback` is the flow's own wording for an unreachable calendar, so
   * agreement still gets an answer when Google cannot be asked.
   */
  async proposeSlots(args: {
    conversation: BdConversation;
    fallbackText: string;
    fallbackKey: string;
    history: BdTurn[];
    now: Date;
  }): Promise<{ messages: string[]; conversation: BdConversation }> {
    const res = await fetch(`${this.baseUrl}/v1/propose-slots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({
        conversation: args.conversation,
        fallback_text: args.fallbackText,
        fallback_key: args.fallbackKey,
        history: args.history,
        now: jakartaIso(args.now),
      }),
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, SCHEDULING_TIMEOUT_FLOOR_MS)),
    });

    if (!res.ok) throw await brainFailure('propose-slots', res);

    return await res.json() as { messages: string[]; conversation: BdConversation };
  }
}

export interface BdBooking {
  booked: boolean;
  meeting_at: string | null;
  meet_link: string;
  /** Google's own event id and the event's own Calendar link. Present only
   * when this call is the one that actually booked something — absent when
   * `_book` offered slots, failed, or (a re-run) found a meeting already on
   * the conversation. `chatbotReply.ts` links the task through `event_id` when it
   * has one; `apps/console/components/TaskCalendar.tsx` falls back to
   * matching on `meet_link` for the tasks booked before this existed. */
  event_id: string | null;
  html_link: string | null;
  /** What to say to the contact — already written by the bot, whether the
   * booking succeeded, the slot was taken, or the calendar failed. */
  messages: string[];
  conversation: BdConversation;
}
