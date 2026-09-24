/**
 * One inbox, several kinds of thing in it.
 *
 * The rule this file exists to hold: a comment is never turned into a
 * conversation. Everything here is a view-model assembled for the list. No row
 * is written, no contact is created, and opening a comment changes nothing on
 * the server — `facebook_comments` stays the only home a Facebook comment has.
 *
 * DELIBERATELY IMPORTS NOTHING. The shapes below are the few fields this file
 * actually reads, and the console's own `ConversationSummary` and
 * `FacebookComment` satisfy them structurally. Importing those types instead
 * would drag the console's browser-typed API client into every program that
 * touches this one — which is exactly what broke the test build the first time
 * round. An adapter that depends on nothing can be tested from anywhere.
 */

/** What a conversation must expose to be placed in the inbox. */
export interface ConversationLike {
  id: string;
  channel_kind: string;
  last_message_at: string | null;
}

/** What a public comment must expose. */
export interface CommentLike {
  id: string;
  commentedAt: string | null;
  createdAt: string;
}

/** What a comment must additionally expose to be grouped under its post. */
export interface GroupableComment extends CommentLike {
  postId: string;
  status: string;
}

/** What the channel filter offers. Deliberately coarser than `channel_kind`:
 * an agent picks a platform, not a transport. */
export type InboxChannel =
  | 'whatsapp'
  | 'facebook_dm'
  | 'instagram_dm'
  | 'facebook_comment'
  | 'instagram_comment';

export interface InboxConversationItem<C extends ConversationLike = ConversationLike> {
  kind: 'conversation';
  id: string;
  /** Null for a channel with no filter of its own — email, Telegram, a
   * marketplace. Those are still real conversations and still appear under
   * "Semua"; they simply have no tab to sit behind. */
  channel: InboxChannel | null;
  /** The sort key. Null when nothing has happened in the thread yet. */
  at: string | null;
  conversation: C;
}

export interface InboxCommentItem<K extends CommentLike = CommentLike> {
  kind: 'comment';
  id: string;
  channel: 'facebook_comment' | 'instagram_comment';
  at: string | null;
  comment: K;
}

export type InboxItem<
  C extends ConversationLike = ConversationLike,
  K extends CommentLike = CommentLike,
> = InboxConversationItem<C> | InboxCommentItem<K>;

/**
 * Which filter a conversation belongs under, from its channel kind.
 *
 * Both transports for a platform land on the same filter: a customer on
 * Messenger does not care whether the CRM reached them through the Graph API
 * or through a browser, and an agent filtering "Facebook DM" means the
 * platform. Returning null rather than guessing keeps an unknown kind visible
 * under "Semua" instead of quietly filed under the nearest-looking tab.
 */
export function channelOfConversation(channelKind: string): InboxChannel | null {
  switch (channelKind) {
    case 'whatsapp':
    case 'whatsapp_web':
      return 'whatsapp';
    case 'messenger':
    case 'messenger_bridge':
      return 'facebook_dm';
    case 'instagram':
    case 'instagram_bridge':
      return 'instagram_dm';
    default:
      return null;
  }
}

/**
 * Instagram comments.
 *
 * INTEGRATION NOT READY ON THIS BRANCH, and this function is the whole
 * boundary for it. The storage a teammate is building lives on another branch;
 * there is no table here to read. An empty list is the honest answer — the
 * filter exists, it holds nothing, and no teammate-owned Instagram code is
 * touched to achieve that.
 *
 * When that work merges, this is the only thing that changes: hand it the rows
 * and everything downstream — merging, sorting, filtering, the detail pane —
 * already handles them.
 */
export function instagramCommentItems<K extends CommentLike>(): InboxCommentItem<K>[] {
  return [];
}

/**
 * Everything the inbox shows, newest first.
 *
 * Sorted on one timestamp across kinds, so a comment left two minutes ago sits
 * above a DM from yesterday — which is the entire reason for merging them into
 * one list rather than giving comments a page of their own.
 *
 * Items with no timestamp sink to the bottom rather than floating to the top.
 * A conversation with no `last_message_at` has had nothing happen in it, and a
 * missing date is not a recent one.
 */
export function toInboxItems<C extends ConversationLike, K extends CommentLike>(
  conversations: C[], facebookComments: K[],
): InboxItem<C, K>[] {
  const items: InboxItem<C, K>[] = [
    ...conversations.map((conversation): InboxConversationItem<C> => ({
      kind: 'conversation',
      id: conversation.id,
      channel: channelOfConversation(conversation.channel_kind),
      at: conversation.last_message_at,
      conversation,
    })),
    ...facebookComments.map((comment): InboxCommentItem<K> => ({
      kind: 'comment',
      id: comment.id,
      channel: 'facebook_comment',
      at: comment.commentedAt ?? comment.createdAt,
      comment,
    })),
    ...instagramCommentItems<K>(),
  ];

  return items.sort((a, b) => {
    if (!a.at && !b.at) return 0;
    if (!a.at) return 1;
    if (!b.at) return -1;
    return b.at.localeCompare(a.at);
  });
}

/**
 * Whether to tell the agent that Facebook comments could not be loaded.
 *
 * Two things this deliberately separates, because conflating them is what the
 * runtime review caught: a request that SUCCEEDED and returned nothing is an
 * empty inbox and says so by being empty; a request that FAILED is a gap, and
 * an empty list is then a lie the agent has no way to see through.
 *
 * Narrowed to the views the missing data would actually have appeared in. On a
 * WhatsApp-only view no comment was ever going to be listed, so saying they
 * are unavailable there is noise that trains people to ignore the notice.
 *
 * A pure predicate rather than a condition inside the component, so the rule
 * can be tested without rendering anything.
 */
export function shouldShowCommentsUnavailable(
  args: { unavailable: boolean; channel: string },
): boolean {
  if (!args.unavailable) return false;
  return args.channel === 'semua' || args.channel === 'facebook_comment';
}

/**
 * Whether to say that Instagram comments are not wired up on this build.
 *
 * Only on the filter that promises them. Under "Semua" the list is full of
 * real items and a standing notice about a platform nobody asked for would be
 * permanent furniture.
 */
export function shouldShowInstagramNotReady(channel: string): boolean {
  return channel === 'instagram_comment';
}

/** One Page post, with every comment on it — the grouping Meta Business
 * Suite's own "Facebook comments" tab shows: a post on the left, everyone who
 * commented on it together on the right. */
export interface CommentPostGroup<K extends GroupableComment = GroupableComment> {
  postId: string;
  /** Oldest first — a thread reads top to bottom like the conversation it is. */
  comments: K[];
  /** The most recent comment's own timestamp, for sorting posts newest-first. */
  latestAt: string | null;
  /** True when any comment on this post is waiting on a person. */
  needsReply: boolean;
}

const COMMENT_PENDING_STATUSES = new Set(['new', 'public_reply_pending', 'dm_pending']);

/**
 * Every comment, filed under the post it was left on.
 *
 * Left ungrouped, a busy post reads as N unrelated rows with nothing to say
 * they are the same conversation — exactly the shape Meta Business Suite
 * moved away from. Grouped, the left list names the thing a customer actually
 * commented ON, and the right panel shows everyone who did, together.
 */
export function groupCommentsByPost<K extends GroupableComment>(comments: K[]): CommentPostGroup<K>[] {
  const byPost = new Map<string, K[]>();
  for (const comment of comments) {
    const group = byPost.get(comment.postId);
    if (group) group.push(comment);
    else byPost.set(comment.postId, [comment]);
  }

  const at = (c: K) => c.commentedAt ?? c.createdAt;
  const groups: CommentPostGroup<K>[] = [...byPost.entries()].map(([postId, list]) => ({
    postId,
    comments: [...list].sort((a, b) => at(a).localeCompare(at(b))),
    latestAt: list.reduce<string | null>((max, c) => (!max || at(c) > max ? at(c) : max), null),
    needsReply: list.some((c) => COMMENT_PENDING_STATUSES.has(c.status)),
  }));

  return groups.sort((a, b) => {
    if (!a.latestAt && !b.latestAt) return 0;
    if (!a.latestAt) return 1;
    if (!b.latestAt) return -1;
    return b.latestAt.localeCompare(a.latestAt);
  });
}

/**
 * The link an item opens.
 *
 * Comments live in their own URL space so a comment id can never be read as a
 * conversation id. Both are UUIDs and the two routes load entirely different
 * things, so sharing a segment would turn one wrong id into either a confusing
 * 404 or, worse, somebody else's thread.
 *
 * A comment opens its POST, not itself: `/obrolan/komentar/<postId>` shows
 * every comment on that post together, the same page regardless of which of
 * them was clicked. Facebook's own id for a post is never a UUID, so this
 * cannot collide with either id space above it.
 */
export function inboxHref<C extends ConversationLike, K extends GroupableComment>(
  item: InboxItem<C, K>, basePath = '/obrolan',
): string {
  return item.kind === 'comment'
    ? `${basePath}/komentar/${item.comment.postId}`
    : `${basePath}/${item.id}`;
}

/**
 * Which comment actions an agent may START, from the row's status alone.
 *
 * These mirror the transitions in `packages/db/src/facebookBridge.ts`; they do
 * not replace them. The claim there is the real guard, and a page that went
 * stale after the button was enabled still gets a refusal from the API. What
 * the predicates buy is saying "not now" before the click, where a 409 after
 * it says the same thing too late — and keeping the rule out of the component
 * so it can be tested without rendering anything.
 *
 * Pending states offer nothing: the worker holds the comment, and a browser
 * mid-typing on a customer's post must not be raced. `failed` offers both, so
 * a person who has read the stored reason can decide to try again by hand.
 */
export function canReplyPublic(status: string): boolean {
  return status === 'new' || status === 'failed';
}

export function canSendDm(status: string): boolean {
  return status === 'public_replied' || status === 'failed';
}
