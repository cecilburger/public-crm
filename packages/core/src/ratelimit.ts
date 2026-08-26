/**
 * Rate limiting that survives a second replica.
 *
 * The algorithm lives here, the storage behind an interface. In development and
 * tests that store is a Map; in production it is Redis, so two API pods share
 * one counter instead of each politely allowing the full limit.
 *
 * Fixed windows, not sliding: a sliding log is more precise and costs a sorted
 * set per key. For "stop the flood" and "stop credential stuffing" the extra
 * precision buys nothing, and the burst at a window boundary is bounded at 2×.
 */
export interface RateLimitStore {
  /** Increment the counter for `key` and return the new count plus its expiry. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  reset(key: string): Promise<void>;
}

export interface LimitVerdict {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export async function checkLimit(
  store: RateLimitStore, key: string, max: number, windowMs: number,
): Promise<LimitVerdict> {
  const { count, resetAt } = await store.hit(key, windowMs);
  const allowed = count <= max;
  return {
    allowed,
    count,
    remaining: Math.max(0, max - count),
    resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
  };
}

/** Single-process store. Correct on one node, wrong on two — hence the interface. */
export class MemoryRateLimitStore implements RateLimitStore {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    this.sweep(now);

    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      return { ...fresh };
    }
    existing.count += 1;
    return { ...existing };
  }

  async reset(key: string) {
    this.windows.delete(key);
  }

  /** Expired keys are dropped lazily; an unbounded Map is a slow memory leak. */
  private sweep(now: number) {
    if (now - this.lastSweep < 30_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  get size() { return this.windows.size; }
}

/**
 * Keys.
 *
 * Login is keyed on (workspace, email) rather than IP because credential
 * stuffing rotates IPs and does not rotate targets. API traffic is keyed on the
 * tenant once known, so one noisy workspace behind a shared office NAT cannot
 * spend everyone else's budget.
 */
export const loginKey = (workspace: string, email: string) =>
  `login:${workspace.toLowerCase()}:${email.trim().toLowerCase()}`;

export const tenantKey = (tenantId: string) => `api:tenant:${tenantId}`;
export const ipKey = (ip: string) => `api:ip:${ip}`;
