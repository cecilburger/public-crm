import { env, loadKek } from '@kirana/core';
import { connectPostgres } from '@kirana/db';
import { buildApp } from './app.ts';
import { RedisRateLimitStore } from './redis-store.ts';

const e = env();
const kek = loadKek(e.KIRANA_KEK);

// Two pools, two roles. The tenant pool cannot read the webhook spool or the
// tenants table; the control pool never runs tenant queries.
const db = await connectPostgres(e.DATABASE_URL, {
  max: e.DATABASE_MAX_CONNECTIONS, poolMode: e.DATABASE_POOL_MODE,
});
const control = await connectPostgres(e.DATABASE_URL, { max: 4, poolMode: e.DATABASE_POOL_MODE });

// One shared counter across every replica. Without this each pod allows the
// full budget on its own, which is the same as having no limit at all.
const IORedis = await import('ioredis');
const Redis = (IORedis as unknown as { default?: typeof IORedis.Redis }).default ?? IORedis.Redis;
const redis = new Redis(e.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
redis.on('error', (err: Error) => console.error('[redis] rate-limit store:', err.message));
const rateLimits = new RedisRateLimitStore(redis, (err) =>
  console.error('[redis] rate limiting degraded, failing open:', err.message));

const { Queue } = await import('bullmq');
const connection = { url: e.REDIS_URL };
const queues = new Map<string, InstanceType<typeof Queue>>();

const app = buildApp({
  db, control, kek, env: e, rateLimits,
  dispatch: async ({ queue, payload }) => {
    let q = queues.get(queue);
    if (!q) {
      q = new Queue(queue, { connection });
      queues.set(queue, q);
    }
    await q.add(queue, payload, {
      attempts: 8,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 1_000,
      removeOnFail: 10_000,
    });
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.all([...queues.values()].map((q) => q.close()));
  redis.disconnect();
  await Promise.all([db.close(), control.close()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: e.PORT, host: '0.0.0.0' });
