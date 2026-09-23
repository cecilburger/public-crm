import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { deliveredAndStayed, settleSurface } from '../apps/fb-bridge/src/sessionManager.ts';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { env, type Env } from '@kirana/core';
import {
  withTenant, withoutTenant, ensureMessengerBridgeChannel, type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { parseFacebookComments, countOwnCommentReplies } from '../apps/fb-bridge/src/parsers/comments.ts';
import {
  BIZ_CONVERSATION_ID_RE, BIZ_INBOX, BIZ_MESSENGER_THREAD_TYPE, BIZ_THREAD_TYPE_RE, BIZ_URLS,
  COMMENT_ACTIONS, COMMENTS, POST_ID_RE, URLS,
} from '../apps/fb-bridge/src/selectors.ts';
import { links, parseHtml, queryFirst } from '../apps/fb-bridge/src/parsers/dom.ts';
import { selectPostSurfaceHtml } from '../apps/fb-bridge/src/pageHtml.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'facebook');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

/**
 * `channels` is unique on (kind, external_id) ACROSS tenants — one Facebook
 * Page belongs to exactly one workspace — so every test file needs a Page id
 * nobody else claims, or the second insert silently rewrites the first one's
 * tenant and the tests start reading each other's rows.
 */
const PAGE = { id: '900000000000077', name: 'Toko Runtime' };

/**
 * The runtime defects: the plumbing, not the parsing.
 *
 * Every failure guarded here was found on a live Page rather than reasoned
 * about, and every one of them was silent — a message dropped forever, a
 * comment attributed to "<name> a few seconds ago", an Instagram thread filed
 * as a Facebook DM. None of them raised an error anywhere, which is why they
 * need tests rather than monitoring.
 *
 * Nothing in this file talks to Facebook, Redis, or any running service: the
 * selectors and parsers are pure, and the ingest path runs against a real
 * migrated database (PGlite, in-process).
 */

/* ------------------------------------------ spool / inbound persistence */

describe('a Facebook message the bridge keeps re-sending', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;

  /** One thread, two of the Page's customers' messages on it. */
  const THREAD = '100000000000077';
  const SENDER = '100000000000077';
  const FIRST_MID = 'mid.$cAABruntime000001';
  const SECOND_MID = 'mid.$cAABruntime000002';

  const post = (body: unknown) => app.inject({
    method: 'POST', url: '/v1/webhooks/fb-bridge',
    headers: { authorization: `Bearer ${e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  /** The exact bytes the bridge re-emits on every reconciliation pass: same
   * mid, same text, same seq. Only the CRM holding the message stops it. */
  const messageEvent = (mid: string, over: Record<string, unknown> = {}) => ({
    event: 'message', tenantId: t.tenantId, at: new Date().toISOString(),
    message: {
      threadId: THREAD, externalMessageId: mid, senderId: SENDER, senderName: 'Rudi Hartono',
      text: 'halo kak, masih buka?', sentAt: null, direction: 'inbound', seq: 0, ...over,
    },
  });

  const messages = () => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ id: string; conversation_id: string; direction: string; sender_type: string; provider_message_id: string }>(
      `select m.id, m.conversation_id, m.direction, m.sender_type, m.provider_message_id
         from messages m
         join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
        where m.tenant_id = $1 and ch.kind = 'messenger_bridge'
        order by m.created_at`,
      [t.tenantId]));

  const conversations = () => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ id: string }>(
      `select c.id from conversations c
         join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
        where c.tenant_id = $1 and ch.kind = 'messenger_bridge'`,
      [t.tenantId]));

  const spooled = (externalId: string) => withoutTenant(db, 'reading the spool a test just wrote', (tx) =>
    tx.query<{ status: string; error: string | null }>(
      `select status, error from webhook_events where provider = 'fb_bridge' and external_id = $1`,
      [externalId]));

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbruntime');
    e = env();

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      // Inline, so one injected request exercises route → spool → worker and a
      // failure inside the processor surfaces here instead of in a queue.
      dispatch: async ({ queue, payload }) => {
        if (queue !== 'inbound.normalise') return;
        await processInboundWebhook(
          { db, control: db, kek: TEST_KEK, dispatch: async () => {} },
          (payload as { webhookEventId: string }).webhookEventId,
        );
      },
    });
    await app.ready();
    // Deliberately NO messenger_bridge channel yet. This is a customer writing
    // in before the operator has connected the Page, which is what happened
    // live: two real DMs arrived into a workspace with nowhere to put them.
  });

  afterAll(async () => { await app.close(); await db.close(); });

  it('leaves no message row at all while there is no messenger_bridge channel', async () => {
    // Arrange / Act: the bridge reports a real customer message; nothing is
    // connected yet, so the processor refuses it.
    const res = await post(messageEvent(FIRST_MID));

    // Assert: the route acknowledged — the bridge must not retry-storm — but
    // nothing was invented to hold the message. A channel conjured here would
    // be a Page nobody configured.
    expect(res.statusCode).toBe(200);
    expect(await messages()).toHaveLength(0);
    expect(await conversations()).toHaveLength(0);
    // And the spool row says *failed*, which is the state the next delivery
    // depends on being allowed to reopen.
    expect((await spooled(`fb_dm:${t.tenantId}:${FIRST_MID}`))[0])
      .toMatchObject({ status: 'failed' });
  });

  it('stores the same event once the Page is connected and the bridge re-sends it', async () => {
    // THE DEFECT THIS PREVENTS: the spool's `on conflict do nothing` treated a
    // row that had FAILED in the processor as a duplicate. The bridge re-emits
    // a message on every reconciliation until the CRM says it holds it, so the
    // event was refused at the barrier forever and the CRM dropped it every
    // single time — a customer nobody ever answers, with no error anywhere.
    // "Webhook accepted" is not evidence of anything; the rows are.

    // Arrange: the operator connects the Page, exactly as the console does.
    await withTenant(db, t.tenantId, (tx) =>
      ensureMessengerBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        pageId: PAGE.id, pageName: PAGE.name, status: 'connected',
      }));

    // Act: the bridge re-sends the byte-identical event it has been re-sending
    // all along.
    expect((await post(messageEvent(FIRST_MID))).statusCode).toBe(200);

    // Assert: a conversation, and the customer's message inside it, keyed on
    // the mid Facebook itself assigned.
    const rows = await messages();
    expect(await conversations()).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 'inbound',
      sender_type: 'contact',
      provider_message_id: `fb_dm:${t.tenantId}:${FIRST_MID}`,
      conversation_id: (await conversations())[0]!.id,
    });
  });

  it('adds nothing on a third delivery of a message it already holds', async () => {
    // The other half of the same fix: reopening a FAILED spool row must not
    // reopen a PROCESSED one, or every reconciliation pass would insert the
    // customer's message again and the inbox would fill with echoes.
    const before = await messages();

    expect((await post(messageEvent(FIRST_MID))).statusCode).toBe(200);

    const after = await messages();
    expect(after).toHaveLength(1);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });

  it('files two different mids from one thread as two messages on one conversation', async () => {
    // A conversation is per (contact, channel), not per message. Keying it any
    // more finely would give one customer a new thread for every sentence they
    // send, and an agent would answer each of them separately.
    expect((await post(messageEvent(SECOND_MID, { text: 'jadi ada stoknya ga kak?', seq: 1 }))).statusCode).toBe(200);

    const rows = await messages();
    expect(rows).toHaveLength(2);
    expect(rows.map((m) => m.provider_message_id)).toEqual([
      `fb_dm:${t.tenantId}:${FIRST_MID}`, `fb_dm:${t.tenantId}:${SECOND_MID}`,
    ]);
    expect(new Set(rows.map((m) => m.conversation_id)).size).toBe(1);
    expect(await conversations()).toHaveLength(1);
  });
});

/* ---------------------------------------------- page / comment identity */

describe('reading a post id off a Page permalink', () => {
  it('accepts a pfbid slug rather than dropping the post for having no digits', () => {
    // THE DEFECT THIS PREVENTS: POST_ID_RE required digits, and the live Page
    // feed writes every permalink as `story_fbid=pfbid0…`. Every comment on
    // the Page was therefore discarded as "no post" — droppedNoPost climbing
    // while the CRM showed an empty comment list.
    const href = 'https://www.facebook.com/permalink.php'
      + '?story_fbid=pfbid0SYNTHETICPOSTSLUG000000000&id=900000000000077';

    const match = POST_ID_RE.exec(href);

    expect(match).not.toBeNull();
    expect(match!.slice(1).find((g) => g !== undefined)).toBe('pfbid0SYNTHETICPOSTSLUG000000000');
  });

  it('still accepts the numeric id an older post permalink carries', () => {
    // The slug did not replace the numeric form; both are live on one Page, so
    // narrowing the pattern to pfbid would only move the outage.
    expect(POST_ID_RE.exec('https://www.facebook.com/permalink.php?story_fbid=998877665544&id=900000000000077')?.[1])
      .toBe('998877665544');
    expect(POST_ID_RE.exec('https://www.facebook.com/tokodemo/posts/pfbid0ABCDEF123456')?.[2])
      .toBe('pfbid0ABCDEF123456');
  });
});

describe('choosing which URL a Page\'s posts live at', () => {
  it('routes a 14-digit Page id to profile.php rather than to /<id>/posts', () => {
    // THE DEFECT THIS PREVENTS: the profile-style branch demanded 15+ digits
    // while the real Page id is 14, so the sweeper went to `/<id>/posts` — a
    // URL that renders "Konten Ini Tidak Tersedia Saat Ini". A Page with no
    // posts and a Page that will not load are indistinguishable to a comment
    // parser, so this failed as a permanently quiet inbox.
    const pageId = '61594393176093';
    expect(pageId).toHaveLength(14);

    const url = URLS.pagePosts(pageId);

    expect(url).toBe(`https://www.facebook.com/profile.php?id=${pageId}`);
    expect(url).not.toContain('/posts');
  });

  it('still sends a vanity handle to the classic /<handle>/posts shape', () => {
    // A handle is not a numeric id and profile.php would 404 on it, so the two
    // branches both have to keep working.
    expect(URLS.pagePosts('tokodemo')).toBe('https://www.facebook.com/tokodemo/posts');
  });
});

describe('naming the person who left a comment', () => {
  it('reports the bare name rather than the name with the time glued onto it', async () => {
    // THE DEFECT THIS PREVENTS: the only aria-label on a comment is
    // "Comment by Gabe a few seconds ago" — no comma, no separator the regex
    // could stop at — so the CRM filed a real customer under the display name
    // "Gabe a few seconds ago" and created a fresh contact on every sweep as
    // the relative time ticked over.
    const { comments } = parseFacebookComments(await fixture('page-comment-live.html'));

    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorName).toBe('Sinta Dewi');
    expect(comments[0]!.authorName).not.toMatch(/\b(ago|lalu|minutes?|menit)\b/i);
  });

  it('strips an Indonesian time tail as readily as an English one', async () => {
    // Facebook geo-localises the time inside this label, so the same Page
    // renders "3 minutes ago" for one operator and "3 menit yang lalu" for the
    // next. A fix that stopped at the English wording would leave every
    // Indonesian-language session — which is all of them, here — filing
    // customers under a name that changes as the clock ticks.
    const html = (await fixture('page-comment-live.html'))
      .replace('Comment by Sinta Dewi 3 minutes ago', 'Comment by Sinta Dewi 3 menit yang lalu');
    // Without this the test could pass for the wrong reason: a replacement that
    // silently missed would leave the English wording in place.
    expect(html).toContain('Comment by Sinta Dewi 3 menit yang lalu');

    const { comments } = parseFacebookComments(html);

    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorName).toBe('Sinta Dewi');
  });
});

describe('proving a public reply to a comment actually landed', () => {
  const PAGE_NAME = 'Toko Demo';
  const REPLY = 'Check DM ya kak!!!';
  const ownReply = (name: string, text: string) =>
    `<div role="article" aria-label="Reply by ${name} 1m">`
    + `<a href="/profile.php?id=900000000000077">${name}</a><div>${text}</div><div>Like</div></div>`;

  it('counts the Page\'s own reply carrying exactly that text, and nothing else', async () => {
    // Arrange: the same post before and after the Page replied.
    const before = await fixture('page-comment-live.html');
    const after = before.replace('</div>\n', ownReply(PAGE_NAME, REPLY) + '</div>\n');
    expect(after).toContain(REPLY);

    // Assert: a count taken across the pair is the only reading that means "a
    // NEW reply appeared". An emptied composer proves nothing, and "our text
    // is somewhere on the post" would report success off last week's reply.
    expect(countOwnCommentReplies(before, { pageName: PAGE_NAME, text: REPLY })).toBe(0);
    expect(countOwnCommentReplies(after, { pageName: PAGE_NAME, text: REPLY })).toBe(1);
  });

  it('refuses to count the customer\'s identical words as the Page\'s reply', async () => {
    // THE DEFECT THIS PREVENTS: a customer who quotes us — or simply writes the
    // same short line — would otherwise be read as our own reply having landed,
    // and the comment would be marked replied without anyone having answered.
    const echoed = (await fixture('page-comment-live.html'))
      .replace('mau tau jasa ini gimana?', REPLY);
    expect(echoed).toContain(REPLY);

    expect(countOwnCommentReplies(echoed, { pageName: PAGE_NAME, text: REPLY })).toBe(0);
  });

  // THE LIVE INCIDENT THIS FILE EXISTS FOR NOW. On the single-comment
  // permalink view a reply is confirmed against, a reply to a comment is NOT
  // rendered as a descendant of that comment's own `div[role="article"]` — it
  // is a SIBLING, in the post's own surface. Read off the live DOM: the
  // matched comment article had zero nested articles, no matter how long a
  // reply was waited for, while the reply sat right there as the next
  // sibling. A real reply landed, twice, on two different fresh comments, and
  // both times the confirmation that only ever looked INSIDE the comment
  // reported failure — because there was never anything inside to find.
  it('finds nothing inside a comment scoped narrowly to itself, even once a reply exists as its sibling', () => {
    // The exact shape read off Facebook live: the comment's own article has
    // its own action row and nothing nested — the reply is a sibling.
    const narrowCommentOnly = '<div role="article" aria-label="Comment by Gabe 5 minutes ago">'
      + '<a href="/profile.php?id=100036687631918">Gabe</a><div>haloo</div>'
      + '<div>Like</div><div>Reply</div><div>Send message</div><div>Hide</div></div>';
    const widerSurfaceWithReply = narrowCommentOnly + ownReply(PAGE_NAME, REPLY);

    // The bug: reading just the comment's own scope never sees a reply that
    // exists beside it, however the reply is phrased or how long it is given.
    expect(countOwnCommentReplies(narrowCommentOnly, { pageName: PAGE_NAME, text: REPLY })).toBe(0);
    // The fix: the same reply, on the wider surface that actually contains
    // it, is found immediately — no waiting required, because the earlier
    // failure was never about time.
    expect(countOwnCommentReplies(widerSurfaceWithReply, { pageName: PAGE_NAME, text: REPLY })).toBe(1);
  });

  it('refuses to count our own reply when it says something else', async () => {
    // Matching on authorship alone would call any earlier reply of ours the
    // proof that this one sent.
    const after = (await fixture('page-comment-live.html'))
      .replace('</div>\n', ownReply(PAGE_NAME, 'Sudah kami balas ya kak') + '</div>\n');

    expect(countOwnCommentReplies(after, { pageName: PAGE_NAME, text: REPLY })).toBe(0);
  });

  it('refuses to count a reply left by a different Page', async () => {
    const after = (await fixture('page-comment-live.html'))
      .replace('</div>\n', ownReply('Warung Sebelah', REPLY) + '</div>\n');

    expect(countOwnCommentReplies(after, { pageName: PAGE_NAME, text: REPLY })).toBe(0);
  });
});

/* -------------------------------------------- Business Suite transport */

describe('which Business Suite inbox the Page watcher opens', () => {
  const ASSET_ID = '1000000000000077';

  it('opens the Messenger-only view rather than the all-channels inbox', () => {
    // THE DEFECT THIS PREVENTS: `/latest/inbox/all` lists the Page's Instagram
    // threads beside its Messenger ones with nothing on a row to tell them
    // apart, and a first version of this transport ingested an Instagram
    // conversation into the CRM as a Facebook DM. Instagram is another
    // bridge's job; this one must not see those threads at all.
    const url = BIZ_URLS.inbox(ASSET_ID);

    expect(url).toBe(`https://business.facebook.com/latest/inbox/messenger/?asset_id=${ASSET_ID}`);
    expect(url).not.toContain('/inbox/all');
  });

  it('admits a FB_MESSAGE conversation and rejects an IG_MESSAGE one', () => {
    // The id alone cannot say which platform a selected conversation belongs
    // to — a 15-digit id was Messenger and a 39-digit one Instagram on the day
    // this was probed, and nothing guarantees that shape — so the thread type
    // stated in the link is the only safe gate.
    const messenger = `/latest/inbox/all?asset_id=${ASSET_ID}&selected_item_id=100000000000009&thread_type=FB_MESSAGE`;
    const instagram = `/latest/inbox/all?asset_id=${ASSET_ID}&selected_item_id=17900000000000000&thread_type=IG_MESSAGE`;

    expect(BIZ_THREAD_TYPE_RE.exec(messenger)?.[1]).toBe(BIZ_MESSENGER_THREAD_TYPE);
    expect(BIZ_THREAD_TYPE_RE.exec(instagram)?.[1]).not.toBe(BIZ_MESSENGER_THREAD_TYPE);
    expect(BIZ_MESSENGER_THREAD_TYPE).toBe('FB_MESSAGE');
  });

  it('rebuilds a thread URL that states FB_MESSAGE, so a rebuild cannot widen the gate', () => {
    // `threadUrl` falls back to this shape for a conversation known only from a
    // previous run. Dropping the thread type here would quietly reopen the
    // all-channels behaviour for exactly those threads.
    expect(BIZ_URLS.thread(ASSET_ID, '100000000000009'))
      .toContain(`thread_type=${BIZ_MESSENGER_THREAD_TYPE}`);
  });
});

describe('opening the post a comment sits on', () => {
  const PAGE_ID = '900000000000077';
  const POST_ID = 'pfbid0SYNTHETICPOSTSLUG000000000';
  const COMMENT_ID = '900000000000031';

  it('builds a permalink from the post and the Page, not from the Page timeline', () => {
    // THE DEFECT THIS PREVENTS: acting on a comment used to start at the
    // Page's whole timeline and hunt for it, which worked only while the
    // comment was still near the top. Confirmed live: the public reply landed
    // and the private message on the SAME comment minutes later returned
    // "comment not found", because the feed had not rendered that far.
    expect(URLS.postPermalink(PAGE_ID, POST_ID))
      .toBe(`https://www.facebook.com/permalink.php?story_fbid=${POST_ID}&id=${PAGE_ID}`);
  });

  it('asks Facebook to surface the one comment when given its id', () => {
    expect(URLS.postPermalink(PAGE_ID, POST_ID, COMMENT_ID))
      .toBe(`https://www.facebook.com/permalink.php?story_fbid=${POST_ID}&id=${PAGE_ID}&comment_id=${COMMENT_ID}`);
  });

  it('round-trips through the post-id pattern the comment parser reads back', () => {
    // The permalink this builds is also the href the parser later reads a post
    // id out of. Two halves of one contract, so they are asserted together.
    const url = URLS.postPermalink(PAGE_ID, POST_ID, COMMENT_ID);

    expect(POST_ID_RE.exec(url)?.[1]).toBe(POST_ID);
  });
});

/* ------------------------------- both languages Facebook renders comments in */

describe('a comment on an Indonesian-language session', () => {
  /**
   * A CSS attribute match is case-sensitive, so `[aria-label*="omment"]`
   * matches "Comment by Sinta Dewi" and misses "Komentar oleh Sinta Dewi"
   * completely. On an Indonesian session every comment on the Page was
   * invisible to the parser — no error, no dropped count, just an inbox that
   * never showed a comment. Exactly the silent shape of failure this feature
   * keeps producing, so it gets a test in both localisations.
   */
  const inLanguage = async (label: string) =>
    (await fixture('page-comment-live.html'))
      .replace(/aria-label="Comment by [^"]*"/, `aria-label="${label}"`);

  it('reads a comment labelled in Indonesian', async () => {
    const parsed = parseFacebookComments(await inLanguage('Komentar oleh Sinta Dewi 3 menit yang lalu'));

    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]!.commentId).toBe('900000000000031');
  });

  it('still reads one labelled in English', async () => {
    const parsed = parseFacebookComments(await inLanguage('Comment by Sinta Dewi a few seconds ago'));

    expect(parsed.comments).toHaveLength(1);
  });

  it('counts the Page\'s own reply whichever word Facebook used for it', async () => {
    const reply = (word: string) =>
      `<div role="article" aria-label="${word} Toko Demo 1m">`
      + '<a href="/profile.php?id=900000000000001">Toko Demo</a><div>Check DM ya kak!!!</div></div>';
    const base = await fixture('page-comment-live.html');

    for (const word of ['Reply by', 'Balasan oleh', 'Komentar oleh']) {
      const html = base.replace('</div>\n', reply(word) + '</div>\n');
      expect(countOwnCommentReplies(html, { pageName: 'Toko Demo', text: 'Check DM ya kak!!!' })).toBe(1);
    }
  });
});

/* ------------------------- which tab states the selected conversation */

describe('reading the selected Business Suite conversation', () => {
  /**
   * Two defects in one place, both found live and both silent.
   *
   * The first: a single `<a>`'s outerHTML was read and then searched for links
   * INSIDE it — an element does not contain itself, so the id was never found,
   * every row failed to reveal, and the sweep reported "rendered 1, read 0"
   * for as long as anyone cared to watch.
   *
   * The second: the channel tabs do not agree with each other. The Messenger
   * tab carries the selected Messenger conversation while the Instagram tab
   * simultaneously carries a different Instagram one, so "the first link with
   * an id" reads whichever platform the DOM happens to list first — and
   * Instagram is another bridge's to read.
   */
  const TABS = `<div data-surface="/bizweb:inbox/channel_selector">
    <a href="/latest/inbox/all?asset_id=1225922357281590&selected_item_id=100036687631918&thread_type=FB_MESSAGE">All</a>
    <a href="/latest/inbox/messenger?asset_id=1225922357281590&selected_item_id=100036687631918&thread_type=FB_MESSAGE">Messenger</a>
    <a href="/latest/inbox/instagram_direct?asset_id=1225922357281590&selected_item_id=340282366841710301244260225248396121238&thread_type=IG_MESSAGE">Instagram</a>
  </div>`;

  /** What `readSelectedConversation` does, over the same selectors. */
  const pick = (html: string) => {
    const root = parseHtml(html);
    const container = queryFirst(root, BIZ_INBOX.selectedLinkContainer) ?? root;
    const candidates = links(container).filter((l) => BIZ_CONVERSATION_ID_RE.test(l.href));
    const link = candidates.find((l) => BIZ_INBOX.selectedLinkPreferredRe.test(l.href))
      ?? candidates.find((l) => BIZ_THREAD_TYPE_RE.exec(l.href)?.[1] === BIZ_MESSENGER_THREAD_TYPE);
    return link ? BIZ_CONVERSATION_ID_RE.exec(link.href)?.[1] ?? null : null;
  };

  it('finds the id inside the container, not by searching a link for itself', () => {
    expect(pick(TABS)).toBe('100036687631918');
  });

  it('takes the Messenger tab, never the Instagram one beside it', () => {
    // The Instagram tab's id is 39 digits and belongs to another bridge.
    expect(pick(TABS)).not.toBe('340282366841710301244260225248396121238');
  });

  it('falls back to any FB_MESSAGE tab when the Messenger tab is absent', () => {
    const withoutMessenger = TABS.replace(/<a href="\/latest\/inbox\/messenger[^<]*<\/a>/, '');

    expect(pick(withoutMessenger)).toBe('100036687631918');
  });

  it('answers nothing when only an Instagram conversation is selected', () => {
    const igOnly = `<div data-surface="/bizweb:inbox/channel_selector">
      <a href="/latest/inbox/instagram_direct?asset_id=1&selected_item_id=340282366841710301244260225248396121238&thread_type=IG_MESSAGE">Instagram</a>
    </div>`;

    expect(pick(igOnly)).toBeNull();
  });
});

/**
 * Two rules learned the same way, live, on the same afternoon.
 *
 * A message was typed into Business Suite three seconds after the thread URL
 * was opened, Enter was pressed, the bubble appeared, the send was confirmed
 * off that bubble, and the CRM recorded the message as sent. It had not been
 * sent. Business Suite answers a thread URL by dropping `selected_item_id`,
 * redirecting, and re-rendering the conversation it picks — and the re-render
 * threw the pending send away. Reading the whole Page inbox afterwards found
 * the message in no conversation at all.
 *
 * So: do not type into a surface that is still rewriting itself, and do not
 * believe a message you have only seen once.
 */
describe('typing into a page that has not stopped moving', () => {
  const page = (urls: string[]) => {
    let at = 0;
    return { url: () => urls[Math.min(at++, urls.length - 1)]!, isClosed: () => false } as unknown as
      Parameters<typeof settleSurface>[0];
  };
  const HERE = 'https://business.facebook.com/latest/inbox/all?asset_id=1';

  it('waits for two identical reads before calling a surface settled', async () => {
    const reads = ['<div>loading</div>', '<div>halo</div>', '<div>halo</div>'];
    let taken = 0;

    const settled = await settleSurface(page([HERE]), async () => reads[taken++] ?? reads.at(-1)!, 10_000);

    expect(settled).toBe(true);
    expect(taken).toBe(3);
  });

  it('refuses to settle while the address keeps changing under it', async () => {
    // The redirect itself: same markup, different page. Typing here is typing
    // into a conversation that is on its way out.
    const moving = page([HERE, `${HERE}&business_id=2`, `${HERE}&business_id=3`, `${HERE}&business_id=4`]);

    const settled = await settleSurface(moving, async () => '<div>halo</div>', 2_500);

    expect(settled).toBe(false);
  });

  it('does not treat an empty read as a settled surface', async () => {
    // Nothing rendered twice is not a transcript that has stopped changing;
    // it is a transcript that has not arrived.
    expect(await settleSurface(page([HERE]), async () => '', 2_500)).toBe(false);
  });
});

describe('deciding a message really was delivered', () => {
  const soon = () => Date.now() + 5_000;

  it('rejects a bubble that appears and is then thrown away', async () => {
    // THE SILENT SUCCESS. Facebook paints the message the moment Enter is
    // pressed, whether or not the send behind it succeeds.
    const counts = [1, 0, 0, 0];
    let at = 0;

    const delivered = await deliveredAndStayed(async () => counts[Math.min(at++, counts.length - 1)]!, 0, soon(), 50);

    expect(delivered).toBe(false);
  });

  it('accepts a message that is still there after the dwell', async () => {
    const delivered = await deliveredAndStayed(async () => 1, 0, soon(), 50);

    expect(delivered).toBe(true);
  });

  it('counts against the baseline, so an older copy of the same words is not delivery', async () => {
    // "baik kak" twice in one thread: what makes it delivered is one MORE of
    // them than there was before, never the presence of the words.
    expect(await deliveredAndStayed(async () => 2, 2, soon(), 50)).toBe(false);
  });

  it('gives up at the deadline rather than waiting forever', async () => {
    const started = Date.now();

    expect(await deliveredAndStayed(async () => 0, 0, Date.now() + 1_200, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

/**
 * Which dialog is "the dialog".
 *
 * THE MOST EXPENSIVE BUG IN THIS FILE. `permalink.php` renders the post itself
 * inside `div[role="dialog"][aria-modal="true"]`, so selectors scoped to "the
 * modal" matched the POST's modal. The private reply was typed into the
 * comment box under the post, and Enter published it — twice, on the Page's
 * own post, as a public reply carrying what was meant to be a private message.
 *
 * The markup below is the shape that did it: a post in a modal, with a comment
 * reply box, and no message dialog anywhere.
 */
describe('telling the private-message dialog from the post it was opened over', () => {
  const POST_IN_A_MODAL = `
    <div role="dialog" aria-modal="true" aria-label="Red Panda Test's post">
      <div role="article" aria-label="Comment by Gabe">mau tau jasa ini dimana ta</div>
      <div role="textbox" data-lexical-editor="true" aria-placeholder="Write a comment"></div>
      <div role="button" aria-label="Send Message">Send message</div>
    </div>`;
  const MESSAGE_DIALOG = `
    <div role="dialog" aria-modal="true" aria-label="Message Gabe">
      <div role="textbox" data-lexical-editor="true"></div>
      <div role="button" aria-label="Send Message">Send</div>
    </div>`;

  const find = (html: string, selectors: readonly string[]) => queryFirst(parseHtml(html), selectors);

  it('finds no composer on a post rendered in a modal', () => {
    expect(find(POST_IN_A_MODAL, COMMENT_ACTIONS.messageEditor)).toBeNull();
  });

  it('finds no send button on a post rendered in a modal, whatever its buttons are called', () => {
    expect(find(POST_IN_A_MODAL, COMMENT_ACTIONS.messageSendButton)).toBeNull();
  });

  it('does not mistake the post modal for the message dialog', () => {
    expect(find(POST_IN_A_MODAL, COMMENT_ACTIONS.messageDialog)).toBeNull();
  });

  it('still finds all three in the real message dialog', () => {
    expect(find(MESSAGE_DIALOG, COMMENT_ACTIONS.messageDialog)).not.toBeNull();
    expect(find(MESSAGE_DIALOG, COMMENT_ACTIONS.messageEditor)).not.toBeNull();
    expect(find(MESSAGE_DIALOG, COMMENT_ACTIONS.messageSendButton)).not.toBeNull();
  });

  it('finds the message dialog even when the post modal is open behind it', () => {
    // The live shape: both are on the page at once, and only one of them is
    // somewhere a private message may be typed.
    const both = `<div>${POST_IN_A_MODAL}${MESSAGE_DIALOG}</div>`;

    expect(find(both, COMMENT_ACTIONS.messageEditor)?.getAttribute('aria-placeholder')).toBeUndefined();
    expect(find(both, COMMENT_ACTIONS.messageDialog)?.getAttribute('aria-label')).toBe('Message Gabe');
  });

  it('scopes every message-dialog selector by that dialog\'s own label', () => {
    // The rule that keeps the bug from coming back in a new selector: none of
    // these may be satisfied by an unnamed modal.
    for (const selector of [
      ...COMMENT_ACTIONS.messageDialog, ...COMMENT_ACTIONS.messageEditor, ...COMMENT_ACTIONS.messageSendButton,
    ]) {
      expect(selector).toMatch(/\[role="dialog"\]\[aria-modal="true"\]\[aria-label\^=/);
    }
  });
});

/**
 * Which comment a comment is.
 *
 * Live shape, read off the Page timeline: a comment's own permalink carries
 * `comment_id=` base64 of `comment:<post>_<comment>`, not the bare digits the
 * pattern used to require. Falling through to the next `comment_id=` in the
 * markup found the PARENT's numeric id, so the Page's own reply came back
 * carrying the customer's comment id — two different comments, one id. The
 * table's unique index then swallowed the second one, which is why a sweep
 * could report nothing new while the post plainly had something new on it.
 */
describe('reading a comment id off the markup Facebook actually renders', () => {
  // Built from the live capture: Gabe's comment and the Page's reply to it,
  // each with its own base64 permalink, and the reply also linking back to the
  // comment it answers — which is the link that used to win.
  const GABE = 'Y29tbWVudDoxMjIxMDU0MzQ1Mzk0Nzk3NzJfMTA5MDY0NDUzMzM2OTg1MQ%3D%3D';
  const REPLY = 'Y29tbWVudDoxMjIxMDU0MzQ1Mzk0Nzk3NzJfMTQwNTYyODE0MDk0NTQxNA%3D%3D';
  const FEED = `
    <div role="feed">
      <div role="article" aria-label="Red Panda Test's post">
        <a href="/permalink.php?story_fbid=pfbid0Test&id=61594393176093">post</a>
        <div role="article" aria-label="Comment by Gabe 2 hours ago">
          <a href="https://www.facebook.com/profile.php?id=100036687631918&comment_id=${GABE}">Gabe</a>
          <div dir="auto">mau tau jasa ini dimana ta</div>
        </div>
        <div role="article" aria-label="Reply by Red Panda Test to Gabe's comment 13 minutes ago">
          <a href="https://www.facebook.com/profile.php?id=61594393176093&comment_id=${REPLY}">Red Panda Test</a>
          <a href="https://www.facebook.com/permalink.php?story_fbid=pfbid0Test&comment_id=1090644533369851">in reply to</a>
          <div dir="auto">Halo kak, boleh dibantu lewat chat ya</div>
        </div>
      </div>
    </div>`;

  it('gives the comment and the reply to it two different ids', () => {
    const { comments } = parseFacebookComments(FEED);

    expect(comments.map((c) => c.commentId)).toEqual(['1090644533369851', '1405628140945414']);
  });

  it('keeps each one attributed to whoever wrote it', () => {
    const { comments } = parseFacebookComments(FEED);

    expect(comments.map((c) => c.authorName)).toEqual(['Gabe', 'Red Panda Test']);
    expect(comments.map((c) => c.authorId)).toEqual(['100036687631918', '61594393176093']);
  });

  it('still reads the bare numeric form older markup uses', () => {
    const plain = `
      <div role="feed"><div role="article" aria-label="Red Panda Test's post">
        <a href="/permalink.php?story_fbid=pfbid0Test&id=61594393176093">post</a>
        <div role="article" aria-label="Comment by Sinta">
          <a href="/permalink.php?story_fbid=pfbid0Test&comment_id=778899001122334">Sinta</a>
          <div dir="auto">masih ada kak?</div>
        </div>
      </div></div>`;

    expect(parseFacebookComments(plain).comments.map((c) => c.commentId)).toEqual(['778899001122334']);
  });
});

/**
 * Which posts a reading of the Page timeline names.
 *
 * The watcher needs these because the timeline is a summary: it renders the
 * first comment or two under each post and hides the rest. Reading it alone
 * left a customer's second question sitting on the post for an hour with
 * nothing in the CRM and nothing in the log.
 */
describe('naming the posts a feed reading saw', () => {
  const FEED = `
    <div role="feed">
      <div role="article" aria-label="Red Panda Test's post">
        <a href="/permalink.php?story_fbid=pfbid0NEWEST&id=61594393176093">newest</a>
        <div role="article" aria-label="Comment by Gabe">
          <a href="/permalink.php?story_fbid=pfbid0NEWEST&comment_id=111111111111111">Gabe</a>
          <div dir="auto">masih buka kak?</div>
        </div>
      </div>
      <div role="article" aria-label="Red Panda Test's post">
        <a href="/permalink.php?story_fbid=pfbid0OLDER&id=61594393176093">older</a>
      </div>
    </div>`;

  it('names every post, including one with no comment rendered under it', () => {
    // The one with nothing under it matters most: a post whose only comment is
    // hidden looks exactly like a post with no comments.
    expect(parseFacebookComments(FEED).postIds).toEqual(['pfbid0NEWEST', 'pfbid0OLDER']);
  });

  it('keeps them newest first, which is the order the feed renders', () => {
    expect(parseFacebookComments(FEED).postIds[0]).toBe('pfbid0NEWEST');
  });

  it('does not count a comment as a post', () => {
    expect(parseFacebookComments(FEED).postIds).not.toContain('111111111111111');
  });

  it('prefers the post modal over the feed still rendered behind it', () => {
    // On permalink.php both exist. Reading the feed gets the timeline's
    // comments and none of this post's, which looks exactly like a post with
    // nothing new on it.
    expect(COMMENTS.postSurface[0]).toBe('div[role="dialog"][aria-modal="true"]');
    expect(COMMENTS.postSurface).toContain('div[role="feed"]');
    expect(COMMENTS.postSurface.indexOf('div[role="feed"]'))
      .toBeGreaterThan(COMMENTS.postSurface.indexOf('div[role="main"]'));
  });

  it('reads comments out of a post rendered in a permalink modal', () => {
    const PERMALINK = `
      <body>
        <div role="dialog" aria-modal="true" aria-label="Red Panda Test's post">
          <a href="/permalink.php?story_fbid=pfbid0NEWEST&id=61594393176093">post</a>
          <div role="article" aria-label="Comment by Gabe">
            <a href="/permalink.php?story_fbid=pfbid0NEWEST&comment_id=222222222222222">Gabe</a>
            <div dir="auto">halo pgn tau lebih lanjut dong</div>
          </div>
        </div>
      </body>`;

    const { comments } = parseFacebookComments(PERMALINK);

    expect(comments.map((c) => c.text)).toEqual(['halo pgn tau lebih lanjut dong']);
    expect(comments[0]?.commentId).toBe('222222222222222');
  });

  it('reads only the requested post modal, never an earlier dialog or the feed behind it', () => {
    // The order here is deliberate. `permalink.php` can leave a background
    // feed in the DOM and may have another foreground dialog before the post
    // dialog. Selector order alone accepts the first dialog and silently
    // assigns that other surface's comments to the post being swept.
    const target = 'pfbid0TARGETPOST123456';
    const html = `
      <body>
        <div role="feed">
          <div role="article" aria-label="Toko Runtime's post">
            <a href="/permalink.php?story_fbid=pfbid0BACKGROUNDPOST123456&id=${PAGE.id}">background</a>
            <div role="article" aria-label="Comment by Background Customer">
              <a href="/permalink.php?story_fbid=pfbid0BACKGROUNDPOST123456&comment_id=333333333333333">Background Customer</a>
              <div dir="auto">this must stay behind the modal</div>
            </div>
          </div>
        </div>
        <div role="dialog" aria-modal="true" aria-label="Unrelated Facebook dialog">
          <div role="article" aria-label="Comment by Wrong Dialog">
            <a href="/permalink.php?story_fbid=pfbid0WRONGDIALOG123456&comment_id=444444444444444">Wrong Dialog</a>
            <div dir="auto">this must not be ingested either</div>
          </div>
        </div>
        <div role="dialog" aria-modal="true" aria-label="Toko Runtime's post">
          <a href="/permalink.php?story_fbid=${target}&id=${PAGE.id}">target post</a>
          <div role="article" aria-label="Comment by Target Customer">
            <a href="/permalink.php?story_fbid=${target}&comment_id=555555555555555">Target Customer</a>
            <div dir="auto">this is the latest comment</div>
          </div>
        </div>
      </body>`;

    const surface = selectPostSurfaceHtml(html, target);

    expect(surface).not.toBeNull();
    expect(parseFacebookComments(surface!, { defaultPostId: target }).comments).toMatchObject([{
      commentId: '555555555555555', postId: target, text: 'this is the latest comment',
    }]);
  });

  it('fails closed when no rendered surface owns the requested post', () => {
    const html = `
      <div role="feed"><a href="/permalink.php?story_fbid=pfbid0BACKGROUNDPOST123456&id=${PAGE.id}">background</a></div>
      <div role="dialog" aria-modal="true"><a href="/permalink.php?story_fbid=pfbid0WRONGDIALOG123456&id=${PAGE.id}">wrong</a></div>`;

    expect(selectPostSurfaceHtml(html, 'pfbid0TARGETPOST123456')).toBeNull();
  });

  it('does not treat a comment permalink alone as proof of the post surface', () => {
    // A comment's own permalink repeats story_fbid for routing. That says the
    // comment belongs to the post, not that this container is the rendered
    // post/modal surface the sweep intended to read. Qualifying on this alone
    // reintroduces the background-surface bug under a different shape.
    const html = `
      <body>
        <div role="dialog" aria-modal="true" aria-label="Comments popover">
          <div role="article" aria-label="Comment by Target Customer">
            <a href="/permalink.php?story_fbid=pfbid0TARGETPOST123456&id=${PAGE.id}&comment_id=555555555555555">
              comment permalink
            </a>
            <div dir="auto">this mentions the target post but is not the post surface</div>
          </div>
        </div>
      </body>`;

    expect(selectPostSurfaceHtml(html, 'pfbid0TARGETPOST123456')).toBeNull();
  });
});
