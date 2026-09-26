import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runPrivateReply, confirmPrivateDelivery, waitForSendEnabled, enterPrivateText, PrivateReplyError,
  type PrivateReplySteps,
} from '../apps/fb-bridge/src/privateReply.ts';
import { commentActionStatus, commentActionBody } from '../apps/fb-bridge/src/commentActionErrors.ts';
import { resolvePrivateReplySurface, SendNotConfirmedError } from '../apps/fb-bridge/src/sessionManager.ts';
import { privateMessageDialogsFromHtml, validatePrivateMessageSurface } from '../apps/fb-bridge/src/pageHtml.ts';
import { BIZ_COMPOSER, COMMENT_ACTIONS } from '../apps/fb-bridge/src/selectors.ts';
import {
  withTenant, ensureMessengerBridgeChannel, recordFacebookComment, getFacebookComment,
  claimCommentForPublicReply, markCommentPublicReplied, findMessengerBridgeChannel, claimMessengerEcho,
  recordMessengerAgentReply, type Database,
} from '@kirana/db';
import { messageIdsWithText, parseBusinessSuiteTranscript } from '../apps/fb-bridge/src/parsers/businessSuiteThread.ts';
import { fbBridgeFailure } from '../apps/worker/src/fbBridgeClient.ts';
import {
  processCommentDm, type CommentBridge, type CommentDeps, type CommentEnv,
} from '../apps/worker/src/processors/facebookComments.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * Facebook comment → private Messenger DM ("Kirim DM"), end to end but without
 * a browser.
 *
 * Measured live, 2026-09-26, on the Red Panda Test Page:
 * - "Send message" on a comment opens `div[role="dialog"][aria-label="Message
 *   <name>"]` in the SAME tab within ~0.5–6s: no popup, no navigation. Its
 *   composer is `role=textbox data-lexical-editor aria-placeholder="Send a
 *   message as <Page>"`, beside the post's PUBLIC composers ("Reply to <name>",
 *   "Comment as <Page>"). Its "Send Message" button is `aria-disabled="true"`
 *   until the text registers, a few hundred ms after it is typed.
 * - The one live attempt (13:58) DID deliver the message to the customer, but
 *   the confirmation read a Business Suite tab opened before the send, which
 *   never showed it; a fresh load showed it. The CRM recorded a failure — with
 *   the PUBLIC reply's wording — inviting a second, duplicate DM.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'facebook');

/* --------------------------------------------- 6. which composer is private */

describe('the private-reply composer on the live markup', () => {
  const expected = { contactId: '900000000000018', contactName: 'Sinta' };
  const noSuite = { detailView: false, editor: false, selectedThreadId: null, selectedThreadType: null, headerHtml: null };

  it('is the "Message <commenter>" dialog, never the post\'s public reply box beside it', async () => {
    const html = await readFile(join(FIXTURES, 'private-reply-dialog-live.html'), 'utf8');

    const dialogs = privateMessageDialogsFromHtml(html);

    expect(dialogs).toEqual([{ label: 'Message Sinta', editor: true, sendControl: true }]);
    expect(validatePrivateMessageSurface({ dialogs, businessSuite: noSuite }, expected)).toBe('dialog');
    // Someone else's name on the dialog is not this commenter's DM.
    expect(validatePrivateMessageSurface({ dialogs, businessSuite: noSuite }, { ...expected, contactName: 'Budi' })).toBeNull();
  });

  it('finds no private surface at all while only the post and its public composers are open', async () => {
    const html = await readFile(join(FIXTURES, 'private-reply-dialog-live.html'), 'utf8');
    const postOnly = html.replace(/<div aria-label="Message Sinta"[\s\S]*$/, '</div>');

    const dialogs = privateMessageDialogsFromHtml(postOnly);

    expect(postOnly).toContain('aria-label="Reply to Sinta"');
    expect(dialogs).toEqual([]);
    expect(validatePrivateMessageSurface({ dialogs, businessSuite: noSuite }, expected)).toBeNull();
  });
});

/* ------------------------------------------- 1–5. where the surface opens */

type Browser = Parameters<typeof resolvePrivateReplySurface>[0];
type Page = NonNullable<Awaited<ReturnType<typeof resolvePrivateReplySurface>>>;

function fakePage(shows: 'dialog' | 'business-suite' | null = null) {
  const state = { shows, closed: false, dead: false };
  const page = {
    isClosed: () => state.closed,
    url: () => 'https://www.facebook.com/fake',
    evaluate: async (source: string) => {
      if (state.dead) throw new Error('Protocol error: Target closed');
      if (source.includes(JSON.stringify(COMMENT_ACTIONS.messageEditor))) return state.shows === 'dialog';
      if (source.includes(JSON.stringify(BIZ_COMPOSER.box))) return state.shows === 'business-suite';
      return false;
    },
  } as unknown as Page;
  return Object.assign(state, { page });
}
const browserOf = (open: Array<{ page: Page }>) => ({ pages: async () => open.map((p) => p.page) }) as unknown as Browser;
const BUDGET = 3_000;

describe('finding the private-reply surface after "Send message"', () => {
  it('1. takes the dialog opened in the same tab', async () => {
    const post = fakePage('dialog');
    expect(await resolvePrivateReplySurface(browserOf([post]), new Set([post.page]), BUDGET)).toBe(post.page);
  });

  it('2. takes the dialog in a tab the click opened', async () => {
    const post = fakePage();
    const opened = fakePage('dialog');
    expect(await resolvePrivateReplySurface(browserOf([post, opened]), new Set([post.page]), BUDGET)).toBe(opened.page);
  });

  it('3. survives an intermediate tab that opens and closes, and finds the dialog where it settles', async () => {
    const post = fakePage();
    const open = [post];
    const flash = fakePage();
    setTimeout(() => { open.push(flash); }, 200);
    setTimeout(() => { flash.closed = true; flash.dead = true; post.shows = 'dialog'; }, 700);

    expect(await resolvePrivateReplySurface(browserOf(open), new Set([post.page]), BUDGET)).toBe(post.page);
  });

  it('4. ignores a dead page among the candidates', async () => {
    const dead = fakePage('dialog');
    dead.dead = true;
    const live = fakePage('dialog');
    expect(await resolvePrivateReplySurface(browserOf([dead, live]), new Set(), BUDGET)).toBe(live.page);
  });

  it('5. waits for a composer that paints after the click', async () => {
    const post = fakePage();
    setTimeout(() => { post.shows = 'dialog'; }, 1_200);
    expect(await resolvePrivateReplySurface(browserOf([post]), new Set([post.page]), BUDGET)).toBe(post.page);
  });

  it('never takes a conversation tab another job opened during the click, only the private dialog', async () => {
    // The watcher's thread reads and outbound sends open Business Suite tabs of
    // their own; one on this commenter's thread would pass every identity check.
    const post = fakePage();
    const otherJobsTab = fakePage('business-suite');
    expect(await resolvePrivateReplySurface(browserOf([post, otherJobsTab]), new Set([post.page]), BUDGET)).toBeNull();
  });

  it('never falls back to a conversation tab that was already open before the click', async () => {
    // The bridge's long-lived inbox tab is a Business Suite conversation too.
    // Typing into it would send an ordinary DM from the watcher's own tab,
    // unlinked from the comment — so no dialog within budget means nothing typed.
    const post = fakePage();
    const inboxTab = fakePage('business-suite');
    expect(await resolvePrivateReplySurface(browserOf([post, inboxTab]), new Set([post.page, inboxTab.page]), BUDGET))
      .toBeNull();
  });
});

/* ------------------------------------------------ 7–9. the send, once */

function steps(over: Partial<PrivateReplySteps> = {}) {
  const calls: string[] = [];
  const surface = { id: 'dialog-page' };
  const base: PrivateReplySteps = {
    baseline: async () => { calls.push('baseline'); return 0; },
    openSurface: async () => { calls.push('openSurface'); return surface; },
    proveSurface: async () => { calls.push('proveSurface'); return 'dialog'; },
    enterText: async () => { calls.push('enterText'); },
    sendEnabled: async () => { calls.push('sendEnabled'); return true; },
    pressSend: async () => { calls.push('pressSend'); },
    confirm: async () => { calls.push('confirm'); return true; },
    isPassthrough: () => false,
    log: () => {},
  };
  return { steps: { ...base, ...over } as PrivateReplySteps, calls };
}

describe('one private reply', () => {
  it('9. proves the surface, types once, sends exactly once, and confirms delivery', async () => {
    const { steps: s, calls } = steps();

    await runPrivateReply(s);

    expect(calls.filter((c) => c === 'pressSend')).toHaveLength(1);
    expect(calls.indexOf('enterText')).toBeGreaterThan(calls.indexOf('proveSurface'));
    expect(calls.indexOf('pressSend')).toBeGreaterThan(calls.indexOf('sendEnabled'));
    expect(calls.at(-1)).toBe('confirm');
  });

  it('7. fails as "nothing sent" when the dialog never opens, the text does not take, or the button never enables', async () => {
    const cases: Array<[Partial<PrivateReplySteps>, string]> = [
      [{ openSurface: async () => null }, 'private_surface_not_found'],
      [{ proveSurface: async () => null }, 'private_composer_not_found'],
      [{ enterText: async () => { throw new PrivateReplyError('empty', 'private_type_failed'); } }, 'private_type_failed'],
      [{ sendEnabled: async () => false }, 'private_send_not_attempted'],
      [{ enterText: async () => { throw new Error('Protocol error: Target closed'); } }, 'private_send_not_attempted'],
    ];
    for (const [over, code] of cases) {
      const { steps: s, calls } = steps(over);
      const err = await runPrivateReply(s).then(() => null, (e: unknown) => e);
      expect(err, code).toBeInstanceOf(PrivateReplyError);
      expect((err as PrivateReplyError).code, code).toBe(code);
      expect((err as PrivateReplyError).nothingSent, code).toBe(true);
      expect(calls, code).not.toContain('pressSend');
    }
  });

  it('never sends when the proven surface changed between typing and sending', async () => {
    const answers: Array<'dialog' | null> = ['dialog', 'dialog', null];
    const { steps: s, calls } = steps({ proveSurface: async () => answers.shift() ?? null });

    const err = await runPrivateReply(s).then(() => null, (e: unknown) => e) as PrivateReplyError;

    expect(err.code).toBe('private_composer_closed');
    expect(err.nothingSent).toBe(true);
    expect(calls).not.toContain('pressSend');
  });

  it('8. reports "may have been sent" — never "nothing sent" — once the send was pressed and delivery is not seen', async () => {
    for (const over of [
      { confirm: async () => false },
      { confirm: async () => { throw new Error('Protocol error: Target closed'); } },
    ]) {
      const { steps: s, calls } = steps(over);
      const err = await runPrivateReply(s).then(() => null, (e: unknown) => e) as PrivateReplyError;
      expect(err.code).toBe('private_send_unconfirmed');
      expect(err.nothingSent).toBe(false);
      expect(calls.filter((c) => c === 'pressSend')).toHaveLength(1);
    }
  });

  it('reports "may have been sent" even when the session dies after the send was pressed', async () => {
    class SessionGone extends Error {}
    const { steps: s } = steps({
      confirm: async () => { throw new SessionGone('checkpoint'); }, isPassthrough: (e) => e instanceof SessionGone,
    });
    const err = await runPrivateReply(s).then(() => null, (e: unknown) => e) as PrivateReplyError;
    expect(err).toBeInstanceOf(PrivateReplyError);
    expect(err.code).toBe('private_send_unconfirmed');
  });

  it('passes session errors through untouched', async () => {
    class SessionGone extends Error {}
    const { steps: s } = steps({ baseline: async () => { throw new SessionGone('login'); }, isPassthrough: (e) => e instanceof SessionGone });
    await expect(runPrivateReply(s)).rejects.toBeInstanceOf(SessionGone);
  });
});

/* ------------------------------------------------- typing and the button */

describe('entering the text and waiting for the send button', () => {
  it('refuses to go on when the composer does not hold exactly the intended text', async () => {
    const page = {
      evaluate: vi.fn(async (src: string) => (src.includes('.focus()') ? true : 'Halo')),   // focus ok, readback wrong
      keyboard: { sendCharacter: vi.fn(async () => {}) },
    };
    const err = await enterPrivateText(page as never, COMMENT_ACTIONS.messageEditor, 'Halo kak')
      .then(() => null, (e: unknown) => e) as PrivateReplyError;
    expect(err.code).toBe('private_type_failed');
    expect(page.keyboard.sendCharacter).toHaveBeenCalledTimes(1);
  });

  it('reports a composer that could not be focused as closed, having typed nothing', async () => {
    const page = { evaluate: vi.fn(async () => false), keyboard: { sendCharacter: vi.fn(async () => {}) } };
    const err = await enterPrivateText(page as never, COMMENT_ACTIONS.messageEditor, 'Halo kak')
      .then(() => null, (e: unknown) => e) as PrivateReplyError;
    expect(err.code).toBe('private_composer_closed');
    expect(page.keyboard.sendCharacter).not.toHaveBeenCalled();
  });

  it('waits for "Send Message" to enable instead of clicking it while Facebook still has it disabled', async () => {
    let enabledAt = Date.now() + 600;
    const page = { evaluate: vi.fn(async () => (Date.now() >= enabledAt ? 'enabled' : 'disabled')) };
    expect(await waitForSendEnabled(page as never, 2_000)).toBe(true);
    enabledAt = Number.POSITIVE_INFINITY;
    expect(await waitForSendEnabled(page as never, 500)).toBe(false);
  });
});

/* ------------------------------------------------------ confirmation */

describe('confirming a private reply arrived', () => {
  const sleep = async () => {};

  it('confirms only a message that appears in a fresh read and is still there after a dwell', async () => {
    const reads = [0, 0, 1, 1];
    expect(await confirmPrivateDelivery(async () => reads.shift() ?? 1, 0, { checksAtMs: [0, 1, 2], dwellMs: 1, sleep })).toBe(true);
  });

  it('does not confirm a message that never appears, or appears and is gone again', async () => {
    const never = [0, 0, 0];
    expect(await confirmPrivateDelivery(async () => never.shift() ?? 0, 0, { checksAtMs: [0, 1, 2], dwellMs: 1, sleep })).toBe(false);
    const flicker = [1, 0, 0, 0, 0];
    expect(await confirmPrivateDelivery(async () => flicker.shift() ?? 0, 0, { checksAtMs: [0, 1], dwellMs: 1, sleep })).toBe(false);
  });

  it('treats an unreadable read as "not seen yet", never as delivered', async () => {
    const reads: Array<number | null> = [null, null, 2, 2];
    expect(await confirmPrivateDelivery(async () => reads.shift() ?? 2, 1, { checksAtMs: [0, 1, 2], dwellMs: 1, sleep })).toBe(true);
    expect(await confirmPrivateDelivery(async () => null, 0, { checksAtMs: [0, 1], dwellMs: 1, sleep })).toBe(false);
  });
});

describe('the delivered bubble\'s own id', () => {
  it('is read off every transcript row that says exactly the text', () => {
    const html = `<div role="region" aria-label="Message list container">
      <div data-message-id="mid.$cAAQAAold111">Halo kak</div>
      <div data-message-id="mid.$cAAQAAother1">Halo kak, ada lagi?</div>
      <div data-message-id="mid.$cAAQAAnew222"> Halo kak </div></div>`;
    expect(messageIdsWithText(html, 'Halo kak')).toEqual(['mid.$cAAQAAold111', 'mid.$cAAQAAnew222']);
  });

  it('is the same id the inbox watcher reads the bubble back as', () => {
    const html = `<div role="region" aria-label="Message list container">
      <div data-message-id="mid.$cAAQAA9Gb1RinDj2Y5mg3PhO-Ns6U" data-kirana-direction="outbound">Halo kak</div></div>`;
    const watched = parseBusinessSuiteTranscript(html).messages.map((m) => m.externalMessageId);
    expect(watched).toEqual(['mid.$cAAQAA9Gb1RinDj2Y5mg3PhO-Ns6U']);
    expect(messageIdsWithText(html, 'Halo kak')).toEqual(watched);
  });
});

/* -------------------------------------------- the bridge's HTTP answer */

describe('the bridge\'s answer for a failed private reply', () => {
  it('says "not sent" (503) or "may have been sent" (502), with the private stage — never the public reply\'s code', () => {
    const notSent = new PrivateReplyError('button never enabled', 'private_send_not_attempted');
    const maybe = new PrivateReplyError('sent, not seen', 'private_send_unconfirmed');

    expect(commentActionStatus(notSent)).toBe(503);
    expect(commentActionBody(notSent)).toEqual({ error: 'button never enabled', code: 'private_send_not_attempted' });
    expect(commentActionStatus(maybe)).toBe(502);
    expect(commentActionBody(maybe)).toEqual({ error: 'sent, not seen', code: 'private_send_unconfirmed' });
    // The public reply's own unconfirmed send keeps its code.
    expect(commentActionBody(new SendNotConfirmedError('typed, not seen'))).toMatchObject({ code: 'reply_not_confirmed' });
  });
});

/* --------------------------------------- 8–10. the CRM row, in the worker */

describe('the CRM row for a private reply', () => {
  const PAGE = { id: '900000000000001', name: 'Toko Demo' };
  let db: Database;
  let t: TestTenant;
  let seq = 0;
  const ENV: CommentEnv = {
    FB_COMMENT_AUTO_DM: false, FB_COMMENT_COOLDOWN_MS: 0, FB_COMMENT_BATCH: 10, FB_COMMENT_MAX_ATTEMPTS: 3,
    FB_COMMENT_AUTO_REPLY_TEXT: 'Check DM ya kak!!!', FB_COMMENT_AUTO_DM_TEXT: 'Halo kak',
  };

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbprivatedm');
    await withTenant(db, t.tenantId, (tx) => ensureMessengerBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
      pageId: PAGE.id, pageName: PAGE.name, status: 'connected',
    }));
  });
  afterAll(async () => { await db.close(); });

  const ctx = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => ({ tx, tenantId: t.tenantId, kek: TEST_KEK });
  const givenReplied = async () => {
    seq += 1;
    const row = await withTenant(db, t.tenantId, (tx) => recordFacebookComment(ctx(tx), {
      pageId: PAGE.id, pageName: PAGE.name, postId: 'pfbid0Test', commentId: `71000000000${seq}`,
      authorExternalId: `10000000001${seq}`, authorName: 'Sinta', body: 'ada size M?', commentedAt: new Date(),
    }));
    await withTenant(db, t.tenantId, (tx) => claimCommentForPublicReply(ctx(tx), { id: row.id }));
    await withTenant(db, t.tenantId, (tx) => markCommentPublicReplied(ctx(tx), { id: row.id }));
    return row.id;
  };
  const rowOf = async (id: string) => (await withTenant(db, t.tenantId, (tx) => getFacebookComment(ctx(tx), { id })))!;
  const bridge = (dm: () => Promise<{ threadId: string }>) => {
    const calls: string[] = [];
    const b: CommentBridge = {
      replyToComment: async () => {},
      privateReplyToComment: async (args) => { calls.push(args.commentId); return dm(); },
    };
    return { b, calls };
  };
  const deps = (b: CommentBridge): CommentDeps => ({ db, kek: TEST_KEK, fbBridge: b, dispatch: async () => {}, env: ENV });
  const answer = (status: number, code: string) => async (): Promise<never> => {
    throw fbBridgeFailure('private reply', status, JSON.stringify({ error: 'x', code }));
  };

  it('8. records "may have been sent" in private-DM words, and never retries it on its own', async () => {
    const id = await givenReplied();
    const { b, calls } = bridge(answer(502, 'private_send_unconfirmed'));

    const outcome = await processCommentDm(deps(b), { tenantId: t.tenantId, commentId: id, text: 'Halo kak' });

    expect(outcome.status).toBe('failed');
    const row = await rowOf(id);
    expect(row.status).toBe('public_replied');
    expect(row.dmError).toMatch(/mungkin sudah terkirim|sudah dikirim sekali/i);
    expect(row.dmError).toMatch(/Messenger/);
    expect(row.dmError).not.toMatch(/postingan|Balasan sudah diketik/);
    // A queue retry of the same job is refused at the claim: still one call.
    expect((await processCommentDm(deps(b), { tenantId: t.tenantId, commentId: id, text: 'Halo kak' })).status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('7. records "not sent, safe to try again" for a failure before the send', async () => {
    const id = await givenReplied();
    const { b } = bridge(answer(503, 'private_send_not_attempted'));

    await processCommentDm(deps(b), { tenantId: t.tenantId, commentId: id, text: 'Halo kak' }).catch(() => {});

    const row = await rowOf(id);
    expect(row.status).toBe('public_replied');
    expect(row.dmError).toMatch(/belum dikirim|belum ada yang dikirim/i);
    expect(row.dmError).toMatch(/aman dicoba lagi/i);
  });

  it('files the delivered private reply under Facebook\'s own message id, so the inbox reconciliation adds no second copy', async () => {
    // Live, 2026-09-26 16:07/16:08: the private reply was recorded under the
    // comment's key, and the inbox watcher then ingested the same bubble under
    // `fb_dm:<session>:<mid>` — one DM on Facebook, two in the CRM.
    const id = await givenReplied();
    const mid = 'mid.$cAAQAAsyntheticPrivateReply01';
    const { b } = bridge(async () => ({ threadId: '100000000000888', messageId: mid }));

    expect((await processCommentDm(deps(b), { tenantId: t.tenantId, commentId: id, text: 'Halo kak' })).status).toBe('sent');
    // What the watcher does when it later reads the same bubble off the thread.
    const channel = await withTenant(db, t.tenantId, (tx) => findMessengerBridgeChannel(ctx(tx)));
    const echoKey = `fb_dm:${t.tenantId}:${mid}`;
    await withTenant(db, t.tenantId, async (tx) => {
      const common = { channelId: channel!.channelId, fbUserId: '100000000000888', threadId: '100000000000888', body: 'Halo kak', providerMessageId: echoKey };
      return (await claimMessengerEcho(ctx(tx), common)) ?? recordMessengerAgentReply(ctx(tx), common);
    });

    const copies = await withTenant(db, t.tenantId, (tx) => tx.query<{ provider_message_id: string }>(
      `select provider_message_id from messages where tenant_id = $1 and channel_id = $2 and conversation_id in (
         select conversation_id from messages where tenant_id = $1 and provider_message_id = $3)`,
      [t.tenantId, channel!.channelId, echoKey]));
    expect(copies.map((r) => r.provider_message_id)).toEqual([echoKey]);
  });

  it('9–10. marks a confirmed private reply dm_sent, and never sends it again', async () => {
    const id = await givenReplied();
    const { b, calls } = bridge(async () => ({ threadId: '100000000000999' }));

    expect((await processCommentDm(deps(b), { tenantId: t.tenantId, commentId: id, text: 'Halo kak' })).status).toBe('sent');
    expect((await rowOf(id)).status).toBe('dm_sent');
    expect((await processCommentDm(deps(b), { tenantId: t.tenantId, commentId: id, text: 'Halo kak' })).status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });
});
