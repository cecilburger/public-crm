/**
 * The price list. This module is the single source of truth: the marketing
 * site's configurator, the in-app estimator and the invoice run all read these
 * numbers, and tests/pricing.test.ts pins them to what the website publishes.
 *
 * All amounts are IDR (rupiah, integers — never floats for money).
 */

export type PlanCode = 'starter' | 'growth' | 'scale' | 'custom';
export type BillingInterval = 'monthly' | 'annual';

export interface Plan {
  code: Exclude<PlanCode, 'custom'>;
  label: string;
  /** Billable conversations included per month. */
  chats: number;
  priceIdr: number;
  includedNumbers: number;
  includedSeats: number;
  includedAiReplies: number;
  extraNumberIdr: number;
  extraSeatIdr: number;
  aiPackIdr: number;
  /** Charged per conversation beyond `chats`. */
  overagePerChatIdr: number;
  /** 0 means the voice channel is already included. */
  voiceAddonIdr: number;
  features: string[];
}

export const AI_PACK_REPLIES = 5_000;
export const CSM_MONTHLY_IDR = 3_000_000;
export const GREEN_TICK_IDR = 2_500_000;
export const MIGRATION_IDR = 5_000_000;

/** Annual = pay for ten months, get twelve. */
export const ANNUAL_FACTOR = 10 / 12;
/** Annual totals are rounded to a clean 10k so the invoice reads like a price. */
export const ANNUAL_ROUNDING_IDR = 10_000;

/** PPN. Configurable because the rate and the DPP mechanism move with regulation. */
export const PPN_RATE = 0.11;

export const PLANS: Record<Exclude<PlanCode, 'custom'>, Plan> = {
  starter: {
    code: 'starter', label: 'Starter', chats: 1_000, priceIdr: 1_500_000,
    includedNumbers: 1, includedSeats: 5, includedAiReplies: 2_000,
    extraNumberIdr: 450_000, extraSeatIdr: 175_000, aiPackIdr: 500_000,
    overagePerChatIdr: 1_800, voiceAddonIdr: 750_000,
    features: ['inbox', 'autopilot', 'orders', 'pipeline', 'api:read'],
  },
  growth: {
    code: 'growth', label: 'Growth', chats: 3_000, priceIdr: 3_900_000,
    includedNumbers: 3, includedSeats: 15, includedAiReplies: 10_000,
    extraNumberIdr: 400_000, extraSeatIdr: 150_000, aiPackIdr: 450_000,
    overagePerChatIdr: 1_500, voiceAddonIdr: 650_000,
    features: ['inbox', 'autopilot', 'orders', 'pipeline', 'api:*'],
  },
  scale: {
    code: 'scale', label: 'Scale', chats: 5_000, priceIdr: 5_900_000,
    includedNumbers: 5, includedSeats: 40, includedAiReplies: 25_000,
    extraNumberIdr: 350_000, extraSeatIdr: 125_000, aiPackIdr: 400_000,
    overagePerChatIdr: 1_300, voiceAddonIdr: 0,
    // Entitlements name only what ships. Adding 'broadcast' here before the
    // feature exists is how a price list starts lying.
    features: ['inbox', 'autopilot', 'orders', 'pipeline', 'api:*', 'audit', 'roles:custom'],
  },
};

export function planOf(code: PlanCode): Plan {
  if (code === 'custom') throw new Error('Custom plans are priced per contract, not from the catalogue');
  return PLANS[code];
}

export function hasFeature(code: PlanCode, feature: string): boolean {
  if (code === 'custom') return true;
  const f = PLANS[code].features;
  return f.includes(feature) || f.includes(`${feature.split(':')[0]}:*`);
}

export interface Subscription {
  plan: Exclude<PlanCode, 'custom'>;
  interval: BillingInterval;
  extraNumbers: number;
  extraSeats: number;
  aiPacks: number;
  addons?: { csm?: boolean; voice?: boolean; greenTick?: boolean; migration?: boolean };
}

export interface EstimateLine {
  key: string;
  label: string;
  qty: number;
  unitIdr: number;
  amountIdr: number;
}

export interface Estimate {
  lines: EstimateLine[];
  subtotalMonthlyIdr: number;
  annualDiscountIdr: number;
  totalMonthlyIdr: number;
  billedYearlyIdr: number;
  oneOffIdr: number;
  ppnIdr: number;
  totalMonthlyInclPpnIdr: number;
}

const round = (n: number, to: number) => Math.round(n / to) * to;

/**
 * Recurring subscription cost. Deliberately does NOT include usage overage or
 * Meta's pass-through conversation fees — those are metered after the fact and
 * appear on the invoice as separate lines.
 */
export function estimate(sub: Subscription): Estimate {
  const plan = planOf(sub.plan);
  const lines: EstimateLine[] = [
    { key: 'plan', label: `${plan.label} — ${plan.chats.toLocaleString('id-ID')} chats`,
      qty: 1, unitIdr: plan.priceIdr, amountIdr: plan.priceIdr },
  ];

  if (sub.extraNumbers > 0) {
    lines.push({ key: 'numbers', label: 'Extra WhatsApp numbers', qty: sub.extraNumbers,
      unitIdr: plan.extraNumberIdr, amountIdr: sub.extraNumbers * plan.extraNumberIdr });
  }
  if (sub.extraSeats > 0) {
    lines.push({ key: 'seats', label: 'Extra agent seats', qty: sub.extraSeats,
      unitIdr: plan.extraSeatIdr, amountIdr: sub.extraSeats * plan.extraSeatIdr });
  }
  if (sub.aiPacks > 0) {
    lines.push({ key: 'ai', label: `Autopilot packs (${(sub.aiPacks * AI_PACK_REPLIES).toLocaleString('id-ID')} replies)`,
      qty: sub.aiPacks, unitIdr: plan.aiPackIdr, amountIdr: sub.aiPacks * plan.aiPackIdr });
  }
  if (sub.addons?.voice && plan.voiceAddonIdr > 0) {
    lines.push({ key: 'voice', label: 'Voice channel', qty: 1,
      unitIdr: plan.voiceAddonIdr, amountIdr: plan.voiceAddonIdr });
  }
  if (sub.addons?.csm) {
    lines.push({ key: 'csm', label: 'Dedicated success manager', qty: 1,
      unitIdr: CSM_MONTHLY_IDR, amountIdr: CSM_MONTHLY_IDR });
  }

  const subtotal = lines.reduce((s, l) => s + l.amountIdr, 0);
  const total = sub.interval === 'annual' ? round(subtotal * ANNUAL_FACTOR, ANNUAL_ROUNDING_IDR) : subtotal;
  const oneOff = (sub.addons?.greenTick ? GREEN_TICK_IDR : 0) + (sub.addons?.migration ? MIGRATION_IDR : 0);
  const ppn = Math.round(total * PPN_RATE);

  return {
    lines,
    subtotalMonthlyIdr: subtotal,
    annualDiscountIdr: subtotal - total,
    totalMonthlyIdr: total,
    billedYearlyIdr: sub.interval === 'annual' ? total * 12 : 0,
    oneOffIdr: oneOff,
    ppnIdr: ppn,
    totalMonthlyInclPpnIdr: total + ppn,
  };
}

/** Conversations beyond the plan allowance, billed at the plan's overage rate. */
export function overage(plan: Exclude<PlanCode, 'custom'>, chatsUsed: number): { chats: number; amountIdr: number } {
  const p = PLANS[plan];
  const chats = Math.max(0, chatsUsed - p.chats);
  return { chats, amountIdr: chats * p.overagePerChatIdr };
}

/**
 * Upgrading is always cheaper than paying overage — this finds the point where
 * that becomes true, which is what the "we move you up automatically" promise
 * on the pricing page is enforced against.
 */
export function cheaperPlanAt(chatsUsed: number, interval: BillingInterval = 'monthly'): Exclude<PlanCode, 'custom'> | 'custom' {
  const candidates = (Object.values(PLANS) as Plan[]).map((p) => {
    const base = interval === 'annual' ? round(p.priceIdr * ANNUAL_FACTOR, ANNUAL_ROUNDING_IDR) : p.priceIdr;
    return { code: p.code, cost: base + overage(p.code, chatsUsed).amountIdr };
  });
  const best = candidates.reduce((a, b) => (b.cost < a.cost ? b : a));
  // Past Scale + 100% overage the answer is a contract, not a plan.
  return chatsUsed > PLANS.scale.chats * 2 ? 'custom' : best.code;
}

export const formatIdr = (n: number): string => `Rp ${n.toLocaleString('id-ID')}`;
