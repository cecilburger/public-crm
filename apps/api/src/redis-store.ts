import type { RateLimitStore } from '@kirana/core';

/** The slice of ioredis this needs — narrow enough to fake in a test. */
export interface RedisLike {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Redis-backed counters. INCR then PEXPIRE only on the first hit, so the window
 * starts when the first request in it arrives and is not extended by later ones.
 *
 * Deliberately fails **open**: if Redis is unreachable, requests are allowed
 * rather than everyone being locked out of their own inbox by a cache outage.
 * The trade is explicit — availability over throttling — and it is logged.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private redis: RedisLike,
    private onError: (err: Error) => void = () => {},
  ) {}

  private static readonly SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
    local ttl = redis.call('PTTL', KEYS[1])
    return {count, ttl}
  `;

  async hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    try {
      const result = await this.redis.eval(
        RedisRateLimitStore.SCRIPT, 1, key, String(windowMs),
      ) as [number, number];
      const ttl = result[1] > 0 ? result[1] : windowMs;
      return { count: Number(result[0]), resetAt: Date.now() + ttl };
    } catch (err) {
      this.onError(err as Error);
      return { count: 1, resetAt: Date.now() + windowMs };
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.eval(`return redis.call('DEL', KEYS[1])`, 1, key);
    } catch (err) {
      this.onError(err as Error);
    }
  }
}
