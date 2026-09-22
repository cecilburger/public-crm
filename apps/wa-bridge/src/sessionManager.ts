import path from 'node:path';
import fs from 'node:fs/promises';
import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';

const { Client, LocalAuth } = pkg;
type WAClient = InstanceType<typeof Client>;

// WhatsApp's own bookkeeping — a contact changing number, an e2e re-key, a
// call log entry — rides the same 'message' event as real chat content, just
// with no text a person wrote. Left in, each one lands as a visible
// "[type message]" that looks like an empty reply from a customer.
const SYSTEM_MESSAGE_TYPES = new Set([
  'notification', 'notification_template', 'e2e_notification', 'gp2', 'group_notification',
  'call_log', 'ciphertext', 'protocol', 'broadcast_notification', 'debug', 'hsm',
]);

export interface BridgeEvent {
  channelId: string;
  event: 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure' | 'message';
  at: string;
  qr?: { dataUrl: string; expiresInMs: number };
  ready?: { phoneE164: string };
  disconnected?: { reason: string };
  message?: {
    id: string; from: string; to: string; body: string; type: string;
    timestampSec: number; fromMe: boolean; displayName: string | null;
  };
}

/**
 * One Puppeteer-backed Client per channel, keyed by `channelId`. `LocalAuth`'s
 * own `clientId` option namespaces each session's files under one shared
 * `dataPath`, which is what lets one process hold several tenants' WhatsApp
 * Web sessions without them fighting over the same login.
 */
export class SessionManager {
  private clients = new Map<string, WAClient>();

  // `message_create` fires for a message this process just sent via `send()`
  // just as much as for one a customer sent — WhatsApp echoes both directions
  // through the same event. `send()`'s own caller already records that
  // message once; without this, the echo reports it a second time as if it
  // were new, racing whichever side's write lands first. `selfSentIds` covers
  // the common case (the echo arrives after `send()` has the real id to
  // match); `inFlightSends` covers the rarer case where the echo fires before
  // `send()` itself has resolved, so there is no id yet to match against.
  private selfSentIds = new Set<string>();
  private inFlightSends = new Map<string, number>();

  constructor(private authDir: string, private onEvent: (ev: BridgeEvent) => void) {}

  isConnected(channelId: string): boolean {
    return this.clients.has(channelId);
  }

  /**
   * A marker written next to a session's files the moment it authenticates,
   * and removed when it logs out.
   *
   * `LocalAuth` leaves a directory behind for every channel that ever started
   * a session, authenticated or not — this workspace has 47 of them, all but
   * one abandoned by old development runs. "Has a folder" is therefore not
   * the same question as "should be running", and resuming on the folder
   * alone would launch dozens of browsers at boot.
   */
  private activeMarker(channelId: string): string {
    return path.join(this.authDir, `session-${channelId}`, '.active');
  }

  /**
   * Launch a browser, or take over one that is already running on this
   * session's profile.
   *
   * Chrome refuses a second launch against a `userDataDir` it already holds,
   * and this process restarts far more often than the browser it leaves
   * behind: `tsx watch` on every save, plus any crash or redeploy. Confirmed
   * live — the resume failed with "The browser is already running for
   * …session-…", the client never initialised, no `ready` event was ever
   * emitted, and the channel sat on "MEMULAI…" indefinitely while WhatsApp
   * itself was perfectly logged in. Nothing surfaced that: the process was
   * healthy and `/healthz` answered fine.
   *
   * Chrome writes its own debugging port into the profile so that something
   * else can find it, which is exactly the situation here — adopting the
   * browser is both cheaper and safer than fighting it for the lock.
   * `apps/ig-bridge` learned the same lesson first.
   */
  private async puppeteerFor(channelId: string): Promise<Record<string, unknown>> {
    const portFile = path.join(this.authDir, `session-${channelId}`, 'DevToolsActivePort');
    try {
      const contents = await fs.readFile(portFile, 'utf8');
      const port = contents.split('\n')[0]?.trim() ?? '';
      const wsPath = contents.split('\n')[1]?.trim() ?? '';
      if (/^\d+$/.test(port)) {
        // Reachable only if that browser is genuinely still up; the file
        // outlives the process that wrote it.
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(2000),
        }).catch(() => null);
        if (res?.ok) {
          const info = await res.json() as { webSocketDebuggerUrl?: string };
          const endpoint = info.webSocketDebuggerUrl
            ?? (wsPath ? `ws://127.0.0.1:${port}${wsPath}` : null);
          if (endpoint) return { browserWSEndpoint: endpoint };
        }
      }
    } catch {
      // No port file, or nothing listening — launch our own below.
    }
    return { headless: true };
  }

  /**
   * Every channel whose session is worth bringing back up.
   *
   * Nothing called this before: `start()` only ever ran because a request
   * asked for it, so a restart — which `tsx watch` does on every save —
   * silently stopped WhatsApp from receiving anything. The process stayed
   * up, `/healthz` kept answering ok, and the channel row kept saying
   * 'connected', so there was no symptom until someone noticed messages had
   * quietly stopped hours earlier.
   */
  async resumable(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.authDir);
    } catch {
      return [];
    }

    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith('session-')) continue;
      const channelId = entry.slice('session-'.length);
      try {
        await fs.access(this.activeMarker(channelId));
        out.push(channelId);
      } catch {
        // Never authenticated, or logged out since.
      }
    }
    return out;
  }

  private isSelfEcho(channelId: string, providerMessageId: string): boolean {
    if (this.selfSentIds.delete(providerMessageId)) return true;
    return (this.inFlightSends.get(channelId) ?? 0) > 0;
  }

  async start(channelId: string): Promise<void> {
    if (this.clients.has(channelId)) return;

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: channelId, dataPath: this.authDir }),
      puppeteer: await this.puppeteerFor(channelId),
    });
    this.clients.set(channelId, client);

    client.on('qr', async (qr) => {
      const dataUrl = await QRCode.toDataURL(qr);
      // WhatsApp Web rotates the code roughly every 20-45s until it is
      // scanned; the console re-polls faster than that so it never shows a
      // dead one.
      this.onEvent({ channelId, event: 'qr', at: new Date().toISOString(),
        qr: { dataUrl, expiresInMs: 45_000 } });
    });

    client.on('authenticated', () => {
      // Written here, not on 'ready': authentication is the moment this
      // session becomes one worth restoring after a restart.
      void fs.writeFile(this.activeMarker(channelId), new Date().toISOString(), 'utf8').catch(() => {});
      this.onEvent({ channelId, event: 'authenticated', at: new Date().toISOString() });
    });

    client.on('auth_failure', (message) => {
      // The stored login is no longer good, so stop advertising it as
      // resumable — otherwise every restart retries a session that can only
      // fail, and the QR the user actually needs never gets asked for.
      void fs.rm(this.activeMarker(channelId), { force: true }).catch(() => {});
      this.onEvent({ channelId, event: 'auth_failure', at: new Date().toISOString(),
        disconnected: { reason: message } });
    });

    client.on('ready', async () => {
      // WhatsApp's newer accounts identify themselves by a LID (a masked,
      // rotating ID) rather than their real number — `client.info.wid` is
      // whichever one the account happens to have, so `.user` alone is not
      // reliably a phone number any more. `getContactLidAndPhone` resolves
      // the actual number behind either kind of ID; a plain phone-based wid
      // just resolves back to itself.
      let digits = client.info?.wid?.user ?? '';
      const wid = client.info?.wid?._serialized;
      if (wid) {
        try {
          const [resolved] = await client.getContactLidAndPhone([wid]);
          if (resolved?.pn) digits = resolved.pn.split('@')[0]!;
        } catch {
          // Falls back to whatever whatsapp-web.js gave us directly.
        }
      }
      this.onEvent({ channelId, event: 'ready', at: new Date().toISOString(),
        ready: { phoneE164: digits ? `+${digits}` : '' } });
    });

    client.on('disconnected', (reason) => {
      this.clients.delete(channelId);
      this.onEvent({ channelId, event: 'disconnected', at: new Date().toISOString(),
        disconnected: { reason: String(reason) } });
    });

    // whatsapp-web.js's own 'message' event is inbound-only by design — it
    // fires `message_create` for every message first, then returns early
    // before firing 'message' at all when the message is `fromMe`. A reply
    // typed on the phone never reaches a 'message' listener no matter what it
    // checks; 'message_create' is the one event that sees both directions.
    client.on('message_create', async (msg) => {
      // The customer's identity sits in `from` for an incoming message but in
      // `to` for one the owner sent — whatsapp-web.js swaps which field holds
      // it depending on `fromMe`, not the app.
      const counterpartField = msg.fromMe ? 'to' : 'from';
      const counterpart = msg[counterpartField];

      // Only individual chats carry a phone number we can file a message
      // under. `status@broadcast` (a contact's WhatsApp Status) and group
      // chats (`…@g.us`) arrive over this same event but are not a contact
      // we know how to record — forwarding one crashes the ingest path
      // trying to parse it as a phone number instead of just being skipped.
      if (!counterpart.endsWith('@c.us') && !counterpart.endsWith('@lid')) return;
      if (SYSTEM_MESSAGE_TYPES.has(msg.type)) return;
      if (msg.fromMe && this.isSelfEcho(channelId, msg.id._serialized)) return;

      // Same LID privacy ID that `ready` resolves for our own number can show
      // up on either side of a chat — the customer's id is then a `…@lid`,
      // not a phone number, and it lands on the contact record as-is. Only
      // worth the extra round trip for the contacts it actually affects.
      let from = msg.from;
      let to = msg.to;
      if (counterpart.endsWith('@lid')) {
        try {
          const [resolved] = await client.getContactLidAndPhone([counterpart]);
          if (resolved?.pn) {
            if (msg.fromMe) to = resolved.pn; else from = resolved.pn;
          }
        } catch {
          // Falls back to the LID itself; better than dropping the message.
        }
      }

      // `.name` is how *this* WhatsApp account has the contact saved on their
      // own phone — the thing an agent actually recognises. `.pushname` (the
      // contact's own public display name) is the fallback for someone not
      // saved to the phone yet, still better than a bare number.
      let displayName: string | null = null;
      try {
        const contact = await client.getContactById(counterpart);
        displayName = contact.name || contact.pushname || null;
      } catch {
        // No contact record yet — the phone number alone is still enough to file the message under.
      }

      this.onEvent({
        channelId, event: 'message', at: new Date().toISOString(),
        message: {
          id: msg.id._serialized, from, to, body: msg.body,
          type: msg.type, timestampSec: msg.timestamp, fromMe: msg.fromMe, displayName,
        },
      });
    });

    await client.initialize();
  }

  async send(channelId: string, to: string, body: string): Promise<{ providerMessageId: string }> {
    const client = this.clients.get(channelId);
    if (!client) {
      const err = new Error('Session is not connected') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    // A `phone@c.us` id built by hand only works while WhatsApp still
    // addresses that contact by phone number. Since the LID migration, some
    // contacts are only reachable by their LID — sending to a hand-built
    // `@c.us` id for one of those silently resolves to no chat at all.
    // `getNumberId` asks WhatsApp for whichever id that number is actually
    // reachable at right now, `@c.us` or `@lid`, so it works for both.
    let chatId = to;
    if (!chatId.includes('@c.us') && !chatId.includes('@lid')) {
      const numberId = await client.getNumberId(to.replace(/^\+/, ''));
      if (!numberId) {
        const err = new Error('WhatsApp could not find that number — it may not be on WhatsApp') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      chatId = numberId._serialized;
    }

    this.inFlightSends.set(channelId, (this.inFlightSends.get(channelId) ?? 0) + 1);
    let sent;
    try {
      sent = await client.sendMessage(chatId, body);
    } finally {
      const remaining = (this.inFlightSends.get(channelId) ?? 1) - 1;
      if (remaining <= 0) this.inFlightSends.delete(channelId);
      else this.inFlightSends.set(channelId, remaining);
    }
    // `sendMessage` resolving with `undefined` does NOT mean the send failed.
    // Confirmed live: the reply arrived on the recipient's phone while this
    // returned nothing, and the old code called that "WhatsApp could not find
    // that number" — reporting a delivered message as a permanent failure,
    // under an error about the number that had nothing to do with it.
    //
    // A rejection means the send failed; resolving means WhatsApp Web
    // accepted it and the library merely could not build the Message object
    // to hand back (its serialisation breaks whenever WhatsApp updates its
    // own internals). So this is treated as sent, with no id to match the
    // echo against.
    if (!sent) {
      // Nothing can match the echo by id, so the channel is kept "sending"
      // for a while instead — otherwise `message_create` sees our own
      // message as new and files a second copy of it.
      this.inFlightSends.set(channelId, (this.inFlightSends.get(channelId) ?? 0) + 1);
      setTimeout(() => {
        const left = (this.inFlightSends.get(channelId) ?? 1) - 1;
        if (left <= 0) this.inFlightSends.delete(channelId);
        else this.inFlightSends.set(channelId, left);
      }, 15_000);

      return { providerMessageId: `unconfirmed:${Date.now()}` };
    }
    // The echo can still take a moment to round-trip back through
    // `message_create` after this call already returned, so the id is kept
    // around rather than cleared the instant `inFlightSends` drops.
    const providerMessageId = sent.id._serialized;
    this.selfSentIds.add(providerMessageId);
    setTimeout(() => this.selfSentIds.delete(providerMessageId), 15_000);
    return { providerMessageId };
  }

  /**
   * Ask each live session whether it is actually still there.
   *
   * WhatsApp Web updates itself and reloads its own interface; the page
   * scripts `whatsapp-web.js` injects die with it, and nothing raises. The
   * process stays healthy, `/healthz` answers, the channel row still reads
   * 'connected' — and inbound messages simply stop. Confirmed three separate
   * times in one afternoon, each found only because somebody sent a message
   * and waited for a reply that never came.
   *
   * `getState()` has to round-trip through the page to answer, so a client
   * whose page is gone cannot fake it: it throws, or it hangs, and the
   * timeout treats a hang as the death it is.
   */
  private heartbeat: NodeJS.Timeout | null = null;

  startHeartbeat(onDead: (channelId: string) => void, everyMs = 2 * 60_000): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => void this.checkAll(onDead), everyMs);
    this.heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async checkAll(onDead: (channelId: string) => void): Promise<void> {
    for (const [channelId, client] of [...this.clients]) {
      let alive = false;
      try {
        const state = await Promise.race([
          client.getState(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getState timed out')), 15_000)),
        ]);
        alive = state === 'CONNECTED';
      } catch {
        alive = false;
      }
      if (alive) continue;

      // Drop it before re-initialising, or `start` returns early on the
      // dead client still sitting in the map and nothing is repaired.
      this.clients.delete(channelId);
      await client.destroy().catch(() => {});
      onDead(channelId);
    }
  }

  async stop(channelId: string): Promise<void> {
    // Removed before the client is torn down, so a logout that then fails
    // half way cannot leave a session marked resumable that the user
    // believes they disconnected.
    await fs.rm(this.activeMarker(channelId), { force: true }).catch(() => {});

    const client = this.clients.get(channelId);
    if (!client) return;
    this.clients.delete(channelId);
    await client.logout().catch(() => {});
    await client.destroy().catch(() => {});
  }
}
