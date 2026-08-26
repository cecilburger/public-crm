/**
 * What a customer pays for.
 *
 * One billable conversation = one contact talking to one tenant inside a
 * rolling 24-hour window, no matter how many messages, agents or channels are
 * involved. This is deliberately more generous than Meta's own model (which
 * bills per business-number *and* per category) and simpler to explain, which
 * matters more than the margin difference.
 *
 * The Meta fee itself is metered separately in `metaCost` and passed through at
 * cost — see docs/ARCHITECTURE.md, "Two meters".
 */

export const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OpenWindow {
  id: string;
  expiresAt: Date;
}

export function windowExpiry(openedAt: Date): Date {
  return new Date(openedAt.getTime() + CONVERSATION_WINDOW_MS);
}

/**
 * Pure decision function — the database transaction that acts on it is in
 * packages/db/src/metering.ts, and it takes an advisory lock so two messages
 * arriving in the same millisecond cannot open two billable windows.
 */
export function shouldOpenWindow(active: OpenWindow | null, now: Date): boolean {
  return active === null || active.expiresAt.getTime() <= now.getTime();
}

export type UsageMetric =
  | 'conversations'      // the billable unit above
  | 'ai_replies'         // Autopilot generations, against the plan's allowance
  | 'messages_out'       // operational, not billed
  | 'meta_cost_micros'   // pass-through, in IDR micros to avoid rounding drift
  | 'broadcasts';

export interface UsageSnapshot {
  conversations: number;
  ai_replies: number;
  messages_out: number;
  meta_cost_micros: number;
  broadcasts: number;
}

export const emptyUsage = (): UsageSnapshot => ({
  conversations: 0, ai_replies: 0, messages_out: 0, meta_cost_micros: 0, broadcasts: 0,
});

/* --------------------------------------------------------- billing periods */

/**
 * Periods are anchored to the day the subscription started, not to the 1st of
 * the month — a customer who signs on the 20th should not get a 10-day first
 * invoice at full price.
 */
export function periodFor(anchor: Date, now: Date): { startsAt: Date; endsAt: Date } {
  const start = new Date(anchor);
  while (addMonth(start, 1) <= now) start.setTime(addMonth(start, 1).getTime());
  return { startsAt: new Date(start), endsAt: addMonth(start, 1) };
}

function addMonth(d: Date, n: number): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCMonth(out.getUTCMonth() + n, 1);
  // Clamp: a 31st anchor lands on the 30th/28th in shorter months.
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

/** IDR micros keep pass-through arithmetic exact until the invoice rounds once. */
export const toMicros = (idr: number): number => Math.round(idr * 1_000_000);
export const fromMicros = (micros: number): number => Math.round(micros / 1_000_000);
