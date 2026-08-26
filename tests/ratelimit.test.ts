import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRateLimitStore, checkLimit, loginKey, tenantKey, ipKey } from '@kirana/core';
import { RedisRateLimitStore } from '../apps/api/src/redis-store.ts';

describe('rate limit counters', () => {
  afterEach(() => vi.useRealTimers());

  it('counts hits inside a window and refuses past the limit', async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 1; i <= 3; i += 1) {
      const verdict = await checkLimit(store, 'k', 3, 60_000);
      expect(verdict.allowed).toBe(true);
      expect(verdict.remaining).toBe(3 - i);
    }
    const over = await checkLimit(store, 'k', 3, 60_000);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps separate keys separate', async () => {
    const store = new MemoryRateLimitStore();
    await checkLimit(store, 'a', 1, 60_000);
    expect((await checkLimit(store, 'b', 1, 60_000)).allowed).toBe(true);
    expect((await checkLimit(store, 'a', 1, 60_000)).allowed).toBe(false);
  });

  it('starts a fresh window once the old one expires', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-03-01T12:00:00Z'));
    const store = new MemoryRateLimitStore();
    await checkLimit(store, 'k', 1, 60_000);
    expect((await checkLimit(store, 'k', 1, 60_000)).allowed).toBe(false);

    vi.setSystemTime(new Date('2026-03-01T12:01:01Z'));
    expect((await checkLimit(store, 'k', 1, 60_000)).allowed).toBe(true);
  });

  it('forgets a key on reset, so a correct password clears a near-lockout', async () => {
    const store = new MemoryRateLimitStore();
    await checkLimit(store, 'k', 2, 60_000);
    await checkLimit(store, 'k', 2, 60_000);
    await store.reset('k');
    expect((await checkLimit(store, 'k', 2, 60_000)).allowed).toBe(true);
  });

  it('does not grow forever as keys expire', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-03-01T12:00:00Z'));
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 50; i += 1) await checkLimit(store, `k${i}`, 5, 1_000);
    expect(store.size).toBe(50);

    vi.setSystemTime(new Date('2026-03-01T12:01:00Z'));
    await checkLimit(store, 'trigger-sweep', 5, 1_000);
    expect(store.size).toBe(1);
  });

  it('keys login on the target, not the source address', () => {
    // Credential stuffing rotates IPs and does not rotate targets.
    expect(loginKey('Toko-Demo', ' Owner@Toko.ID ')).toBe('login:toko-demo:owner@toko.id');
    expect(tenantKey('t1')).not.toBe(ipKey('t1'));
  });
});

describe('the Redis store', () => {
  it('sets the expiry only on the first hit of a window', async () => {
    const calls: unknown[][] = [];
    const fake = { eval: async (...args: unknown[]) => { calls.push(args); return [1, 60_000]; } };
    const store = new RedisRateLimitStore(fake);

    const result = await store.hit('k', 60_000);
    expect(result.count).toBe(1);
    // The script itself guards PEXPIRE behind `count == 1`.
    expect(String(calls[0]![0])).toContain('if count == 1 then');
    expect(String(calls[0]![0])).toContain('PEXPIRE');
  });

  it('fails open when Redis is unreachable, rather than locking everyone out', async () => {
    const errors: Error[] = [];
    const broken = { eval: async () => { throw new Error('ECONNREFUSED'); } };
    const store = new RedisRateLimitStore(broken, (err) => errors.push(err));

    const verdict = await checkLimit(store, 'k', 1, 60_000);
    expect(verdict.allowed).toBe(true);
    expect(errors[0]!.message).toBe('ECONNREFUSED');
  });
});
