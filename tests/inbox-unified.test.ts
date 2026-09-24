import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  channelOfConversation, inboxHref, instagramCommentItems, toInboxItems,
  shouldShowCommentsUnavailable, shouldShowInstagramNotReady,
  canReplyPublic, canSendDm,
  type CommentLike, type ConversationLike,
} from '../apps/console/lib/inbox.ts';

/** The fields the adapter reads, plus the few the list renders. Declared here
 * rather than imported from the console's API client, which is typed against
 * the browser and cannot be pulled into this program. */
type ConversationSummary = ConversationLike & {
  status: string; display_name: string | null; phone: string | null;
  assignee_id: string | null; channel_id: string; contact_id: string;
};
type FacebookComment = CommentLike & {
  pageId: string; pageName: string | null; postId: string; commentId: string;
  authorName: string | null; body: string; status: string;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One inbox holding DMs and public comments.
 *
 * The rule under test throughout: a comment is never turned into a
 * conversation. It is merged into the list as a view-model and stays a
 * `facebook_comments` row everywhere else.
 */

const conversation = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c1', status: 'open', assignee_id: null,
  last_message_at: '2026-09-22T10:00:00.000Z',
  display_name: 'Sinta', phone: '0800000001',
  channel_kind: 'whatsapp', channel_id: 'ch1', contact_id: 'ct1', ...over,
});

const comment = (over: Partial<FacebookComment> = {}): FacebookComment => ({
  id: 'k1', pageId: '900000000000001', pageName: 'Toko Demo',
  postId: '900000000000009', commentId: '900000000000010',
  authorName: 'Rudi', body: 'mau tanya harga',
  commentedAt: '2026-09-22T11:00:00.000Z', createdAt: '2026-09-22T11:00:00.000Z',
  status: 'new', ...over,
});

describe('which filter a conversation belongs under', () => {
  it('puts both transports for a platform on one filter', () => {
    // A customer on Messenger does not care whether the CRM reached them
    // through the Graph API or a browser, and neither does the agent filtering.
    expect(channelOfConversation('messenger')).toBe('facebook_dm');
    expect(channelOfConversation('messenger_bridge')).toBe('facebook_dm');
    expect(channelOfConversation('whatsapp')).toBe('whatsapp');
    expect(channelOfConversation('whatsapp_web')).toBe('whatsapp');
    expect(channelOfConversation('instagram')).toBe('instagram_dm');
    expect(channelOfConversation('instagram_bridge')).toBe('instagram_dm');
  });

  it('leaves a channel with no filter of its own unfiled rather than guessing', () => {
    // Null keeps an email conversation visible under "Semua" instead of
    // quietly tucked behind the nearest-looking tab.
    expect(channelOfConversation('email')).toBeNull();
    expect(channelOfConversation('tokopedia')).toBeNull();
    expect(channelOfConversation('something-new')).toBeNull();
  });
});

describe('merging one inbox', () => {
  it('orders DMs and comments together, newest first', () => {
    const items = toInboxItems(
      [conversation({ id: 'older', last_message_at: '2026-09-22T09:00:00.000Z' }),
        conversation({ id: 'newest', last_message_at: '2026-09-22T12:00:00.000Z' })],
      [comment({ id: 'middle', commentedAt: '2026-09-22T11:00:00.000Z' })],
    );

    expect(items.map((i) => i.id)).toEqual(['newest', 'middle', 'older']);
  });

  it('sinks an item with no timestamp instead of floating it to the top', () => {
    // A conversation with no last_message_at has had nothing happen in it. A
    // missing date is not a recent one.
    const items = toInboxItems(
      [conversation({ id: 'nothing-yet', last_message_at: null }),
        conversation({ id: 'real', last_message_at: '2026-09-22T09:00:00.000Z' })],
      [],
    );

    expect(items.map((i) => i.id)).toEqual(['real', 'nothing-yet']);
  });

  it('falls back to when the comment was stored when Facebook gave no time', () => {
    const items = toInboxItems([], [comment({ commentedAt: null, createdAt: '2026-09-22T08:00:00.000Z' })]);

    expect(items[0]!.at).toBe('2026-09-22T08:00:00.000Z');
  });

  it('keeps a comment a comment', () => {
    const items = toInboxItems([conversation()], [comment()]);
    const commentItem = items.find((i) => i.kind === 'comment');

    expect(commentItem).toBeDefined();
    expect(commentItem?.channel).toBe('facebook_comment');
    // The row is carried through untouched: nothing is invented, and nothing
    // conversation-shaped is attached to it.
    expect(commentItem?.kind === 'comment' ? commentItem.comment.commentId : null)
      .toBe('900000000000010');
    expect(items.filter((i) => i.kind === 'conversation')).toHaveLength(1);
  });
});

describe('Instagram comments on this branch', () => {
  it('returns nothing, because the storage is on another branch', () => {
    // The whole integration boundary. When the teammate's igComments work
    // merges, this function is the only thing that changes.
    expect(instagramCommentItems()).toEqual([]);
  });

  it('does not reach into any teammate-owned Instagram code to do it', async () => {
    const source = await readFile(join(ROOT, 'apps/console/lib/inbox.ts'), 'utf8');

    expect(source).not.toMatch(/from '.*ig-bridge|igComments\(|instagram_comments/);
  });
});

describe('where an inbox item opens', () => {
  it('keeps comments in their own URL space', () => {
    // Both ids are UUIDs. Sharing a route would turn one mistyped id into a
    // confusing 404 or, worse, somebody else's thread.
    const items = toInboxItems([conversation({ id: 'aaa' })], [comment({ id: 'bbb' })]);
    const conv = items.find((i) => i.kind === 'conversation')!;
    const com = items.find((i) => i.kind === 'comment')!;

    expect(inboxHref(conv)).toBe('/obrolan/aaa');
    expect(inboxHref(com)).toBe('/obrolan/komentar/bbb');
  });

  it('honours the base path, so a per-channel inbox still works', () => {
    const [item] = toInboxItems([conversation({ id: 'aaa' })], []);

    expect(inboxHref(item!, '/chat-wa')).toBe('/chat-wa/aaa');
  });
});

describe('who may read comments in the inbox', () => {
  it('guards the inbox route with conversation:read, not channel:manage', async () => {
    // This is the entire reason the route exists as a second one. An agent
    // holds `conversation:read` and not `channel:manage`, so reusing the
    // settings listing would 403 for exactly the people the inbox is for —
    // and a 403 inside a layout takes the whole page down, not one section.
    //
    // Asserted against the source because the failure it guards against is
    // somebody later "simplifying" the two routes back into one.
    const source = await readFile(join(ROOT, 'apps/api/src/routes/facebookBridge.ts'), 'utf8');
    const inboxRoute = source.slice(source.indexOf("'/v1/inbox/comments'"));
    const body = inboxRoute.slice(0, inboxRoute.indexOf('});'));

    expect(body).toMatch(/ctx\.guard\(req, 'conversation:read'\)/);
    expect(body).not.toMatch(/channel:manage/);
  });

  it('leaves the settings listing on channel:manage', async () => {
    // Widening that one instead would have handed every agent the permission
    // that also exposes connection state and the disconnect control.
    const source = await readFile(join(ROOT, 'apps/api/src/routes/facebookBridge.ts'), 'utf8');
    const settingsRoute = source.slice(source.indexOf("'/v1/facebook-bridge/comments'"));

    expect(settingsRoute.slice(0, settingsRoute.indexOf('});')))
      .toMatch(/ctx\.guard\(req, 'channel:manage'\)/);
  });
});

describe('telling a broken comment feed from an empty one', () => {
  it('says nothing when the request succeeded and there simply were none', () => {
    // The failure this guards against, found in runtime review: 67 consecutive
    // 404s rendered a calm, empty, entirely convincing inbox. An agent reads
    // that as "nobody commented" and stops looking.
    expect(shouldShowCommentsUnavailable({ unavailable: false, channel: 'semua' })).toBe(false);
    expect(shouldShowCommentsUnavailable({ unavailable: false, channel: 'facebook_comment' })).toBe(false);
  });

  it('says so when the request failed', () => {
    expect(shouldShowCommentsUnavailable({ unavailable: true, channel: 'semua' })).toBe(true);
    expect(shouldShowCommentsUnavailable({ unavailable: true, channel: 'facebook_comment' })).toBe(true);
  });

  it('stays quiet on a view no comment would have appeared in', () => {
    // Warning about missing comments on a WhatsApp-only list is noise, and
    // noise is how a notice stops being read.
    for (const channel of ['whatsapp', 'facebook_dm', 'instagram_dm']) {
      expect(shouldShowCommentsUnavailable({ unavailable: true, channel })).toBe(false);
    }
  });

  it('leaves the DM inbox fully usable when comments fail', () => {
    // A failed comment fetch arrives as an empty list plus the flag. The
    // conversations are untouched: a broken comment endpoint must never cost
    // an agent their WhatsApp threads.
    const items = toInboxItems(
      [conversation({ id: 'wa1' }), conversation({ id: 'wa2', channel_kind: 'messenger_bridge' })],
      [],
    );

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind)).toEqual(['conversation', 'conversation']);
    expect(items.map((i) => i.channel)).toContain('facebook_dm');
  });

  it('still reports Instagram comments as not ready, only on their own filter', () => {
    expect(shouldShowInstagramNotReady('instagram_comment')).toBe(true);
    // Not under "Semua": a standing notice about a platform nobody asked for
    // becomes permanent furniture.
    expect(shouldShowInstagramNotReady('semua')).toBe(false);
    expect(shouldShowInstagramNotReady('facebook_comment')).toBe(false);
  });
});

describe('which comment actions an agent may start', () => {
  /**
   * Every status the row can hold, and what each one offers. The table is the
   * state machine in `packages/db/src/facebookBridge.ts` read from the
   * agent's side: new -> public reply -> DM, pending while the worker has it,
   * and `failed` open to a person who has read the reason.
   */
  const EXPECTED: Record<string, { reply: boolean; dm: boolean }> = {
    new: { reply: true, dm: false },
    public_reply_pending: { reply: false, dm: false },
    public_replied: { reply: false, dm: true },
    dm_pending: { reply: false, dm: false },
    dm_sent: { reply: false, dm: false },
    failed: { reply: true, dm: true },
  };

  it.each(Object.entries(EXPECTED))('decides both actions for %s', (status, expected) => {
    expect(canReplyPublic(status)).toBe(expected.reply);
    expect(canSendDm(status)).toBe(expected.dm);
  });

  it('offers nothing while the worker holds the comment', () => {
    // A browser is mid-typing on a customer's post. A second job queued from
    // the screen would be refused by the claim anyway; the button says so first.
    for (const status of ['public_reply_pending', 'dm_pending']) {
      expect(canReplyPublic(status)).toBe(false);
      expect(canSendDm(status)).toBe(false);
    }
  });

  it('never offers a DM before the public reply has landed', () => {
    // The order is the product: reply on the post, then take it private.
    expect(canSendDm('new')).toBe(false);
    expect(canReplyPublic('new')).toBe(true);
  });

  it('refuses an unknown status rather than guessing', () => {
    // A status this build has never heard of is not one it should act on.
    expect(canReplyPublic('')).toBe(false);
    expect(canSendDm('')).toBe(false);
    expect(canReplyPublic('something-new')).toBe(false);
    expect(canSendDm('something-new')).toBe(false);
  });

  it('no longer shows the "not available" placeholder anywhere in the UI path', async () => {
    // The actions exist now. The copy key is kept as a fallback, but if it
    // reappears in either component an agent is being told a live button is
    // dead — the exact confusion the placeholder was written to prevent.
    const thread = await readFile(join(ROOT, 'apps/console/components/CommentThread.tsx'), 'utf8');
    const actions = await readFile(join(ROOT, 'apps/console/components/CommentActions.tsx'), 'utf8');

    expect(thread).not.toMatch(/actionsDisabled/);
    expect(actions).not.toMatch(/actionsDisabled/);
    expect(actions).toMatch(/canReplyPublic\(/);
    expect(actions).toMatch(/canSendDm\(/);
  });
});
