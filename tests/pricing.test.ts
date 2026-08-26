import { describe, it, expect } from 'vitest';
import { PLANS, estimate, overage, cheaperPlanAt, formatIdr, planOf } from '@kirana/core';

/**
 * The published price list. If a number here changes, the website is wrong —
 * that is the point of the test.
 */
describe('published pricing', () => {
  it('matches the rate card on the website', () => {
    expect(PLANS.starter.priceIdr).toBe(1_500_000);
    expect(PLANS.growth.priceIdr).toBe(3_900_000);
    expect(PLANS.scale.priceIdr).toBe(5_900_000);
    expect(PLANS.starter.chats).toBe(1_000);
    expect(PLANS.growth.chats).toBe(3_000);
    expect(PLANS.scale.chats).toBe(5_000);
  });

  it('gets cheaper per conversation as volume grows', () => {
    const perChat = (p: keyof typeof PLANS) => PLANS[p].priceIdr / PLANS[p].chats;
    expect(perChat('starter')).toBe(1_500);
    expect(perChat('growth')).toBe(1_300);
    expect(perChat('scale')).toBe(1_180);
    expect(perChat('growth')).toBeLessThan(perChat('starter'));
    expect(perChat('scale')).toBeLessThan(perChat('growth'));
  });

  it('prices the Starter plan with no add-ons at exactly Rp 1.500.000', () => {
    const e = estimate({ plan: 'starter', interval: 'monthly', extraNumbers: 0, extraSeats: 0, aiPacks: 0 });
    expect(e.totalMonthlyIdr).toBe(1_500_000);
    expect(formatIdr(e.totalMonthlyIdr)).toBe('Rp 1.500.000');
  });

  it('adds phone numbers and seats at the plan rate', () => {
    const e = estimate({ plan: 'growth', interval: 'monthly', extraNumbers: 2, extraSeats: 3, aiPacks: 0 });
    // 3.900.000 + 2×400.000 + 3×150.000
    expect(e.totalMonthlyIdr).toBe(3_900_000 + 800_000 + 450_000);
    expect(e.lines.map((l) => l.key)).toEqual(['plan', 'numbers', 'seats']);
  });

  it('gives two months free on annual billing', () => {
    const monthly = estimate({ plan: 'growth', interval: 'monthly', extraNumbers: 0, extraSeats: 0, aiPacks: 0 });
    const annual = estimate({ plan: 'growth', interval: 'annual', extraNumbers: 0, extraSeats: 0, aiPacks: 0 });
    expect(annual.totalMonthlyIdr).toBe(3_250_000);
    expect(annual.billedYearlyIdr).toBe(39_000_000);
    expect(annual.billedYearlyIdr).toBe(monthly.totalMonthlyIdr * 10);
  });

  it('keeps one-time services out of the recurring total', () => {
    const e = estimate({
      plan: 'scale', interval: 'monthly', extraNumbers: 0, extraSeats: 0, aiPacks: 0,
      addons: { greenTick: true, migration: true, csm: true },
    });
    expect(e.oneOffIdr).toBe(7_500_000);
    expect(e.totalMonthlyIdr).toBe(5_900_000 + 3_000_000);
  });

  it('does not charge for voice on Scale, where it is included', () => {
    const scale = estimate({ plan: 'scale', interval: 'monthly', extraNumbers: 0, extraSeats: 0, aiPacks: 0, addons: { voice: true } });
    const growth = estimate({ plan: 'growth', interval: 'monthly', extraNumbers: 0, extraSeats: 0, aiPacks: 0, addons: { voice: true } });
    expect(scale.lines.some((l) => l.key === 'voice')).toBe(false);
    expect(growth.lines.find((l) => l.key === 'voice')?.amountIdr).toBe(650_000);
  });

  it('charges overage only beyond the included volume', () => {
    expect(overage('starter', 900).amountIdr).toBe(0);
    expect(overage('starter', 1_200)).toEqual({ chats: 200, amountIdr: 360_000 });
    expect(overage('scale', 6_000)).toEqual({ chats: 1_000, amountIdr: 1_300_000 });
  });

  it('honours the promise that upgrading always beats paying overage', () => {
    // A Starter doing 3.000 chats would pay 1.5jt + 2.000×1.800 = 5,1jt.
    // Growth covers the same volume for 3,9jt, so the recommendation must move.
    expect(cheaperPlanAt(3_000)).toBe('growth');
    expect(cheaperPlanAt(900)).toBe('starter');
    expect(cheaperPlanAt(5_000)).toBe('scale');
    expect(cheaperPlanAt(20_000)).toBe('custom');
  });

  it('computes PPN on top rather than inside the headline price', () => {
    const e = estimate({ plan: 'starter', interval: 'monthly', extraNumbers: 0, extraSeats: 0, aiPacks: 0 });
    expect(e.ppnIdr).toBe(165_000);
    expect(e.totalMonthlyInclPpnIdr).toBe(1_665_000);
  });

  it('refuses to price a custom contract from the catalogue', () => {
    expect(() => planOf('custom')).toThrow(/per contract/i);
  });
});
