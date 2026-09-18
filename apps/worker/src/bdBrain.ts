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
}
