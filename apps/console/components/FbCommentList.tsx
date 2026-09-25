'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ago } from '@/lib/format';
import { t } from '@/lib/copy';
import type { FacebookComment } from '@/lib/api';
import { groupCommentsByPost } from '@/lib/inbox';

/**
 * The `/komentar-fb` list, same shape as `IgCommentList`: one row per post
 * (not per comment), grouped with the shared `groupCommentsByPost` helper —
 * the same grouping the combined Obrolan inbox uses for Facebook comments,
 * so a post reads the same way in both places.
 */
export function FbCommentList({ comments }: { comments: FacebookComment[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const filter = params.get('f') ?? 'semua';

  const groups = groupCommentsByPost(comments);
  const groupDone = (g: (typeof groups)[number]) => !g.needsReply;

  const counts = {
    perlu: groups.filter((g) => g.needsReply).length,
    selesai: groups.filter(groupDone).length,
  };
  const shown = groups.filter((g) =>
    filter === 'perlu' ? g.needsReply : filter === 'selesai' ? groupDone(g) : true);

  const tabs = [
    { key: 'semua', label: t.chats.filterAll, n: groups.length },
    { key: 'perlu', label: t.chats.filterNeedsReply, n: counts.perlu },
    { key: 'selesai', label: t.chats.filterDone, n: counts.selesai },
  ];
  const tabHref = (key: string) => (key === 'semua' ? '/komentar-fb' : `/komentar-fb?f=${key}`);
  const groupHref = (postId: string) => {
    const href = `/komentar-fb/${encodeURIComponent(postId)}`;
    const query = params.toString();
    return query ? `${href}?${query}` : href;
  };

  return (
    <div className="list">
      <div className="filters" role="navigation" aria-label="Saring komentar">
        {tabs.map((tab) => (
          <Link key={tab.key} href={tabHref(tab.key)} aria-current={filter === tab.key ? 'page' : undefined}>
            {tab.label} {tab.n}
          </Link>
        ))}
      </div>

      <div className="scroll">
        {shown.length === 0 ? (
          <p className="empty" style={{ fontSize: 13 }}>{t.fbComments.empty}</p>
        ) : (
          shown.map((g) => {
            const href = `/komentar-fb/${encodeURIComponent(g.postId)}`;
            const active = pathname === href;
            const latest = g.comments[g.comments.length - 1]!;
            return (
              <Link
                key={g.postId}
                href={groupHref(g.postId)}
                className={`thread-item ${g.needsReply ? 'waiting' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="row1">
                  {g.needsReply ? <span className="dot warn" aria-label={t.chats.needsReply} /> : null}
                  <span className="who">{t.inbox.postLabel(g.postId)}</span>
                  <span className="when tnum" suppressHydrationWarning>{ago(g.latestAt)}</span>
                </span>
                <span className="row2">
                  <span className="dim" style={{
                    fontFamily: 'var(--f-mono)', fontSize: 10.5, letterSpacing: '.04em',
                    textTransform: 'uppercase', flex: 'none',
                  }}>
                    {t.inbox.commentCount(g.comments.length)}
                  </span>
                  <span className="preview">
                    {latest.authorName ?? '—'}: {latest.body}
                  </span>
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
