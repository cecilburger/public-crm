'use client';

import Link from '@/components/FastLink';
import { useSearchParams } from 'next/navigation';
import { t } from '@/lib/copy';

const CHANNELS = [
  { key: 'semua', label: t.inbox.channelAll },
  { key: 'whatsapp', label: t.inbox.channelWhatsapp },
  { key: 'facebook_dm', label: t.inbox.channelFacebookDm },
  { key: 'instagram_dm', label: t.inbox.channelInstagramDm },
  { key: 'facebook_comment', label: t.inbox.channelFacebookComment },
  { key: 'instagram_comment', label: t.inbox.channelInstagramComment },
];

/**
 * The channel picker for `/obrolan`, full-width above the list/thread split
 * — same reasoning as `.topbar`: six options need the whole window, not just
 * the ~340px list column `ConversationList` renders in, or half of them sit
 * behind a scrollbar no one thinks to drag.
 *
 * Lives outside `ConversationList` so it can span past the list column, but
 * reads and writes the same `ch` query param, preserving `f` and `channelId`
 * exactly as `ConversationList`'s own filter row does — the two are visually
 * separate, not functionally.
 */
export function ChannelTabs({ basePath = '/obrolan' }: { basePath?: string }) {
  const params = useSearchParams();
  const channel = params.get('ch') ?? 'semua';

  // Built the same way `ConversationList`'s own `hrefWith` builds it, so
  // switching channel here preserves the status filter (`f`) and any
  // wa-bridge number filter (`channelId`) exactly as it would from there.
  const hrefFor = (ch: string) => {
    const qs = new URLSearchParams(params.toString());
    if (ch === 'semua') qs.delete('ch'); else qs.set('ch', ch);
    const query = qs.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  return (
    <div className="tabs" role="navigation" aria-label="Saring kanal" style={{ flexWrap: 'nowrap', overflowX: 'auto' }}>
      {CHANNELS.map((c) => (
        <Link key={c.key} href={hrefFor(c.key)} aria-current={channel === c.key ? 'page' : undefined}>
          {c.label}
        </Link>
      ))}
    </div>
  );
}
