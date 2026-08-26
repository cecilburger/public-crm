import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTenant, ingestInboundMessage, currentUsage, type Database } from '@kirana/db';
import { CONVERSATION_WINDOW_MS } from '@kirana/core';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * What the customer is billed for. The rule on the pricing page — "one customer
 * inside a rolling 24-hour window counts once" — is asserted here against the
 * real advisory-lock path, not a mock.
 */
describe('billable conversation windows', () => {
  let db: Database;
  let t: TestTenant;
  const T0 = new Date('2026-03-01T09:00:00Z');

  const send = (body: string, at: Date, from = '08123456789', id = `wamid.${Math.random()}`) =>
    withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from, body, providerMessageId: id, now: at,
      }));

  const usage = () => withTenant(db, t.tenantId, (tx) => currentUsage(tx, t.tenantId, T0));

  beforeEach(async () => { db = await freshDb(); t = await makeTenant(db, 'meter'); });
  afterEach(async () => { await db.close(); });

  it('bills a burst of messages from one customer as a single conversation', async () => {
    const first = await send('halo', T0);
    const second = await send('masih ada stok?', new Date(T0.getTime() + 60_000));
    const third = await send('kirim hari ini ya', new Date(T0.getTime() + 3 * 3600_000));

    expect(first.billed).toBe(true);
    expect(second.billed).toBe(false);
    expect(third.billed).toBe(false);
    expect((await usage()).usage.conversations).toBe(1);
  });

  it('opens a second billable window once 24 hours have passed', async () => {
    await send('hari ini', T0);
    const justInside = await send('masih hari ini', new Date(T0.getTime() + CONVERSATION_WINDOW_MS - 1000));
    const justOutside = await send('besok', new Date(T0.getTime() + CONVERSATION_WINDOW_MS + 1000));

    expect(justInside.billed).toBe(false);
    expect(justOutside.billed).toBe(true);
    expect((await usage()).usage.conversations).toBe(2);
  });

  it('bills two different customers separately', async () => {
    await send('dari sari', T0, '08111111111');
    await send('dari budi', T0, '08222222222');
    expect((await usage()).usage.conversations).toBe(2);
  });

  it('does not double-bill when the provider redelivers the same message', async () => {
    const first = await send('halo', T0, '08123456789', 'wamid.retry');
    const retry = await send('halo', T0, '08123456789', 'wamid.retry');

    expect(first.billed).toBe(true);
    expect(retry.duplicate).toBe(true);
    expect(retry.billed).toBe(false);
    expect(retry.messageId).toBe(first.messageId);
    expect((await usage()).usage.conversations).toBe(1);
  });

  it('counts one conversation when messages race in concurrently', async () => {
    // Same contact, five messages, no ordering guarantees. The advisory lock in
    // recordConversationActivity is the only thing preventing five bills.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        send(`pesan ${i}`, new Date(T0.getTime() + i * 100), '08123456789', `wamid.race.${i}`)),
    );
    expect((await usage()).usage.conversations).toBe(1);
  });
});
