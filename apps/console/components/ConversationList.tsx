'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ago, awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import type { ConversationSummary, FacebookComment, WaBridgeChannel } from '@/lib/api';
import {
  inboxHref, shouldShowCommentsUnavailable, shouldShowInstagramNotReady, toInboxItems,
  type InboxItem,
} from '@/lib/inbox';

/**
 * Three filters, and the useful one is first.
 *
 * The API has four statuses; an agent has one question — who is waiting for me?
 * "Perlu dibalas" answers it, and the other two are there so nothing is hidden.
 *
 * A fourth filter, `channelId`, is separate from those three and client-only —
 * it narrows the list to one wa-bridge number (the message icon on Channel
 * WhatsApp monitoring links in with it set) rather than adding a fourth tab,
 * since it only ever applies to `/chat-wa`, never `/obrolan`.
 */
/**
 * Whether this item is waiting on a person.
 *
 * A comment nobody has answered is waiting just as a DM is; the only
 * difference is that answering it is currently a manual job on Facebook rather
 * than something this CRM can do. Leaving comments out of "Perlu dibalas"
 * would hide precisely the ones somebody has to act on.
 */
const itemNeedsReply = (item: InboxItem) =>
  item.kind === 'conversation'
    ? awaitingReply(item.conversation)
    : ['new', 'public_reply_pending', 'dm_pending'].includes(item.comment.status);

/** Finished. For a comment that means the sequence ran out: either the private
 * message went, or a public reply landed and no private message was due. */
const itemIsDone = (item: InboxItem) =>
  item.kind === 'conversation'
    ? item.conversation.status === 'resolved'
    : ['dm_sent', 'public_replied'].includes(item.comment.status);

export function ConversationList(
  {
    conversations, basePath = '/obrolan', channels, comments,
    commentsUnavailable = false, showChannelFilter = false,
  }:
  {
    conversations: ConversationSummary[];
    basePath?: string;
    channels?: WaBridgeChannel[];
    /**
     * Public comments to show beside the DMs. Left out by `/chat-wa` and
     * `/chat-ig`, which are single-platform inboxes and behave exactly as they
     * did before this prop existed.
     */
    comments?: FacebookComment[];
    /**
     * True when the comment request failed, as distinct from succeeding with
     * nothing to show. The inbox still renders either way — a broken comment
     * endpoint must never cost an agent their WhatsApp conversations — but
     * only one of the two is worth saying out loud.
     */
    commentsUnavailable?: boolean;
    showChannelFilter?: boolean;
  },
) {
  const pathname = usePathname();
  const params = useSearchParams();
  const filter = params.get('f') ?? 'semua';
  const channel = params.get('ch') ?? 'semua';
  const channelId = params.get('channelId');
  const filteredChannel = channelId ? channels?.find((c) => c.id === channelId) ?? null : null;

  const all = toInboxItems(conversations, comments ?? []);

  // The wa-bridge number filter narrows to one WhatsApp channel row, so it
  // only ever applies to conversations; a public comment has no channel to
  // match against.
  const scoped = channelId
    ? all.filter((i) => i.kind === 'conversation' && i.conversation.channel_id === channelId)
    : all;

  const byChannel = channel === 'semua' ? scoped : scoped.filter((i) => i.channel === channel);

  const counts = {
    perlu: byChannel.filter(itemNeedsReply).length,
    selesai: byChannel.filter(itemIsDone).length,
  };

  const shown = byChannel.filter((i) =>
    filter === 'perlu' ? itemNeedsReply(i)
    : filter === 'selesai' ? itemIsDone(i)
    : true);

  const tabs = [
    { key: 'semua', label: t.chats.filterAll, n: byChannel.length },
    { key: 'perlu', label: t.chats.filterNeedsReply, n: counts.perlu },
    { key: 'selesai', label: t.chats.filterDone, n: counts.selesai },
  ];

  const channelTabs = [
    { key: 'semua', label: t.inbox.channelAll },
    { key: 'whatsapp', label: t.inbox.channelWhatsapp },
    { key: 'facebook_dm', label: t.inbox.channelFacebookDm },
    { key: 'instagram_dm', label: t.inbox.channelInstagramDm },
    { key: 'facebook_comment', label: t.inbox.channelFacebookComment },
    { key: 'instagram_comment', label: t.inbox.channelInstagramComment },
  ];

  // The two filter rows are independent and each survives the other changing:
  // narrowing to Facebook while reading "Perlu dibalas" stays on "Perlu
  // dibalas" rather than silently widening back to everything.
  const hrefWith = (over: { f?: string; ch?: string }) => {
    const qs = new URLSearchParams();
    const nextF = over.f ?? filter;
    const nextCh = over.ch ?? channel;
    if (nextF !== 'semua') qs.set('f', nextF);
    if (nextCh !== 'semua') qs.set('ch', nextCh);
    if (channelId) qs.set('channelId', channelId);
    const query = qs.toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  const tabHref = (key: string) => hrefWith({ f: key });
  // Opening an item keeps the same query string, so the list you land back on
  // (via the browser's back button, or the thread panel's own close) is still
  // scoped the way you left it, not silently reset to everything.
  const itemHref = (item: InboxItem) => {
    const query = params.toString();
    const href = inboxHref(item, basePath);
    return query ? `${href}?${query}` : href;
  };

  return (
    <div className="list">
      {filteredChannel ? (
        <div className="filters" style={{ padding: '8px 10px 0' }}>
          <span className="chip brand">{t.waBridge.filteringNumber(filteredChannel.displayName)}</span>
          <Link href={basePath} style={{ fontSize: 12, marginLeft: 8 }}>{t.waBridge.clearFilter}</Link>
        </div>
      ) : null}
      <div className="filters" role="navigation" aria-label="Saring obrolan">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tabHref(tab.key)}
            aria-current={filter === tab.key ? 'page' : undefined}
          >
            {tab.label} {tab.n}
          </Link>
        ))}
      </div>

      {showChannelFilter ? (
        /* Wraps, unlike the status row above it. `.filters` scrolls
           horizontally by default, which is right for three tabs and wrong for
           six: the row scrolled itself to the active tab and clipped the
           options at both ends, so an agent could not see what else was on
           offer without dragging a row nothing suggested was draggable. */
        <div
          className="filters"
          role="navigation"
          aria-label="Saring kanal"
          style={{ flexWrap: 'wrap', overflowX: 'visible' }}
        >
          {channelTabs.map((tab) => (
            <Link
              key={tab.key}
              href={hrefWith({ ch: tab.key })}
              aria-current={channel === tab.key ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </div>
      ) : null}

      {/* Both notices sit where the missing items would have been, because an
          empty list is indistinguishable from a broken one and the wrong
          reading is the dangerous one: an agent stops looking while real
          customers wait behind a gap. */}
      {showChannelFilter && shouldShowInstagramNotReady(channel) ? (
        <p className="empty" style={{ fontSize: 12, padding: '8px 10px 0' }}>
          {t.inbox.instagramCommentsNotReady}
        </p>
      ) : null}

      {shouldShowCommentsUnavailable({ unavailable: commentsUnavailable, channel }) ? (
        <p className="empty warn" style={{ fontSize: 12, padding: '8px 10px 0' }}>
          {t.inbox.commentsUnavailable}
        </p>
      ) : null}

      <div className="scroll">
        {shown.length === 0 ? (
          <p className="empty" style={{ fontSize: 13 }}>{t.chats.emptyList}</p>
        ) : (
          shown.map((item) => {
            const href = inboxHref(item, basePath);
            const active = pathname === href;
            const waiting = itemNeedsReply(item);

            if (item.kind === 'comment') {
              const c = item.comment;
              return (
                <Link
                  key={`comment:${item.id}`}
                  href={itemHref(item)}
                  className={`thread-item ${waiting ? 'waiting' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="row1">
                    {waiting ? <span className="dot warn" aria-label={t.chats.needsReply} /> : null}
                    <span className="who">{c.authorName || '—'}</span>
                    <span className="when tnum" suppressHydrationWarning>{ago(item.at)}</span>
                  </span>
                  <span className="row2">
                    <span className="chip">{t.inbox.channelFacebookComment}</span>
                    <span className="chip">{t.inbox.commentStatuses[c.status] ?? c.status}</span>
                  </span>
                </Link>
              );
            }

            const c = item.conversation;
            return (
              <Link
                key={c.id}
                href={itemHref(item)}
                className={`thread-item ${waiting ? 'waiting' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="row1">
                  {waiting ? <span className="dot warn" aria-label={t.chats.needsReply} /> : null}
                  <span className="who">
                    {c.display_name
                      ? <>{c.display_name}{c.phone ? <span className="dim" style={{ fontWeight: 400 }}> · {c.phone}</span> : null}</>
                      : (c.phone ?? '—')}
                  </span>
                  {/* This list is a Client Component hydrating over server-rendered
                      HTML — "ago" is relative to whenever each render actually runs,
                      so the server's text and the client's first paint can
                      legitimately differ by a rounding step (e.g. "51m" vs "52m").
                      That's expected drift, not a bug: let the client's clock win
                      instead of warning about it. */}
                  <span className="when tnum" suppressHydrationWarning>{ago(c.last_message_at)}</span>
                </span>
                <span className="row2">
                  <span className="chip">{t.channels[c.channel_kind] ?? c.channel_kind}</span>
                  {waiting ? <span className="chip warn">{t.chats.needsReply}</span> : null}
                  {c.status === 'resolved' ? <span className="chip good">{t.chats.done}</span> : null}
                  {c.assignee_id === null && c.status !== 'resolved'
                    ? <span className="chip">{t.chats.nobodyYet}</span> : null}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
