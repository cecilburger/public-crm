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

  constructor(private authDir: string, private onEvent: (ev: BridgeEvent) => void) {}

  isConnected(channelId: string): boolean {
    return this.clients.has(channelId);
  }

  async start(channelId: string): Promise<void> {
    if (this.clients.has(channelId)) return;

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: channelId, dataPath: this.authDir }),
      puppeteer: { headless: true },
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
      this.onEvent({ channelId, event: 'authenticated', at: new Date().toISOString() });
    });

    client.on('auth_failure', (message) => {
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

    const sent = await client.sendMessage(chatId, body);
    // Belt and suspenders: whatsapp-web.js resolves `chatId` to a chat before
    // sending anything, and returns `undefined` — not a rejected promise —
    // if that somehow still fails. Retrying that would just fail the same
    // way forever, so it is reported as the permanent failure it is instead
    // of crashing on `sent.id` with no explanation.
    if (!sent) {
      const err = new Error('WhatsApp could not find that number — it may not be on WhatsApp') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    return { providerMessageId: sent.id._serialized };
  }

  async stop(channelId: string): Promise<void> {
    const client = this.clients.get(channelId);
    if (!client) return;
    this.clients.delete(channelId);
    await client.logout().catch(() => {});
    await client.destroy().catch(() => {});
  }
}
