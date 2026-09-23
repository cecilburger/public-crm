/**
 * The only code path that asks `trained-cb` what to say next — the BD
 * counterpart to `AutopilotModel`, the way `WaBridgeClient` is the unofficial
 * counterpart to `GraphMetaClient`.
 *
 * The service is stateless: this sends the conversation's current state and
 * the inbound text, and gets back the same state (mutated) plus a list of
 * actions. Nothing is stored there, so a restart loses nothing and two tenants
 * cannot meet — the state never leaves this database except for the duration
 * of one call.
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

export class BdBrainClient {
  constructor(
    private baseUrl: string,
    private secret: string,
    private timeoutMs = 10_000,
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
   */
  async step(args: {
    conversation: BdConversation;
    text: string;
    now: Date;
    intent?: string;
  }): Promise<BdStep> {
    const res = await fetch(`${this.baseUrl}/v1/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({
        conversation: args.conversation,
        text: args.text,
        now: args.now.toISOString(),
        ...(args.intent ? { intent: args.intent } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`bd-brain step failed: ${res.status} ${text}`) as Error & { permanent?: boolean };
      // 400 is our payload being wrong and 401 our secret being wrong; neither
      // is fixed by trying again eight times with exponential backoff.
      err.permanent = res.status === 400 || res.status === 401 || res.status === 404;
      throw err;
    }

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
    history: { direction: 'in' | 'out'; body: string }[];
    now: Date;
  }): Promise<BdBooking> {
    const res = await fetch(`${this.baseUrl}/v1/book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({
        conversation: args.conversation,
        history: args.history,
        now: args.now.toISOString(),
      }),
      // Booking talks to Google Calendar and may read the conversation with
      // an LLM, so it is slower than a `step` by design.
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 45_000)),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`bd-brain book failed: ${res.status} ${text}`) as Error & { permanent?: boolean };
      err.permanent = res.status === 400 || res.status === 401 || res.status === 404;
      throw err;
    }

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
    history: { direction: 'in' | 'out'; body: string }[];
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
        now: args.now.toISOString(),
      }),
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 45_000)),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`bd-brain propose-slots failed: ${res.status} ${text}`) as Error & { permanent?: boolean };
      err.permanent = res.status === 400 || res.status === 401 || res.status === 404;
      throw err;
    }

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
   * the conversation. `bdDraft.ts` links the task through `event_id` when it
   * has one; `apps/console/components/TaskCalendar.tsx` falls back to
   * matching on `meet_link` for the tasks booked before this existed. */
  event_id: string | null;
  html_link: string | null;
  /** What to say to the contact — already written by the bot, whether the
   * booking succeeded, the slot was taken, or the calendar failed. */
  messages: string[];
  conversation: BdConversation;
}
