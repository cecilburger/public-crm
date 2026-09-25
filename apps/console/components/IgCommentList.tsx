'use client';

import Link from '@/components/FastLink';
import { usePathname, useSearchParams } from 'next/navigation';
import { ago } from '@/lib/format';
import { t } from '@/lib/copy';
import type { IgComment } from '@/lib/api';

const needsReply = (c: IgComment) => c.publicStatus === 'pending' || c.publicStatus === 'failed';
const isDone = (c: IgComment) => c.publicStatus === 'sent' || c.publicStatus === 'skipped';

interface PostGroup {
  postRef: string;
  comments: IgComment[];
  /** Newest comment in the group — what the row sorts and displays by. */
  latestAt: string;
  /** The newest comment itself, for the row's preview line. */
  latest: IgComment;
}

/** One row per postingan, not per comment — several comments on the same
 * post used to each get their own row in this list, which buried a post
 * with six replies under six separate, identical-looking entries instead of
 * one. Grouped here the same way a real Instagram post's comment section
 * reads: open the post, see everyone who wrote under it. */
function groupByPost(comments: IgComment[]): PostGroup[] {
  const byPost = new Map<string, IgComment[]>();
  for (const c of comments) {
    const list = byPost.get(c.postRef) ?? [];
    list.push(c);
    byPost.set(c.postRef, list);
  }
  return [...byPost.entries()]
    .map(([postRef, list]): PostGroup => {
      const latest = list.reduce((newest, c) =>
        (c.commentedAt ?? c.createdAt) > (newest.commentedAt ?? newest.createdAt) ? c : newest, list[0]!);
      return { postRef, comments: list, latestAt: latest.commentedAt ?? latest.createdAt, latest };
    })
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

/**
 * The `/komentar-ig` list, styled like `ConversationList` — same filter
 * row, same `.thread-item` rows, same "who's waiting" dot — grouped by
 * `postRef` so a post with several comments is one entry, not one per
 * comment. Opening it (`IgPostThread`) is where every comment on that post,
 * and the manual reply/DM controls for each, actually live.
 */
export function IgCommentList({ comments }: { comments: IgComment[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const filter = params.get('f') ?? 'semua';

  const groups = groupByPost(comments);
  const groupNeedsReply = (g: PostGroup) => g.comments.some(needsReply);
  const groupIsDone = (g: PostGroup) => g.comments.every(isDone);

  const counts = {
    perlu: groups.filter(groupNeedsReply).length,
    selesai: groups.filter(groupIsDone).length,
  };
  const shown = groups.filter((g) =>
    filter === 'perlu' ? groupNeedsReply(g) : filter === 'selesai' ? groupIsDone(g) : true);

  const tabs = [
    { key: 'semua', label: t.chats.filterAll, n: groups.length },
    { key: 'perlu', label: t.chats.filterNeedsReply, n: counts.perlu },
    { key: 'selesai', label: t.chats.filterDone, n: counts.selesai },
  ];
  const tabHref = (key: string) => (key === 'semua' ? '/komentar-ig' : `/komentar-ig?f=${key}`);
  const groupHref = (g: PostGroup) => {
    const href = `/komentar-ig/${encodeURIComponent(g.postRef)}`;
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
          <p className="empty" style={{ fontSize: 13 }}>{t.igComments.empty}</p>
        ) : (
          shown.map((g) => {
            const href = `/komentar-ig/${encodeURIComponent(g.postRef)}`;
            const active = pathname === href;
            const waiting = groupNeedsReply(g);
            return (
              <Link
                key={g.postRef}
                href={groupHref(g)}
                className={`thread-item ${waiting ? 'waiting' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="row1">
                  {waiting ? <span className="dot warn" aria-label={t.chats.needsReply} /> : null}
                  <span className="who">{t.inbox.postContext} {g.postRef}</span>
                  <span className="when tnum" suppressHydrationWarning>{ago(g.latestAt)}</span>
                </span>
                <span className="row2">
                  <span className="dim" style={{
                    fontFamily: 'var(--f-mono)', fontSize: 10.5, letterSpacing: '.04em',
                    textTransform: 'uppercase', flex: 'none',
                  }}>
                    {g.comments.length} {t.igComments.commentCount}
                  </span>
                  <span className="preview">
                    @{g.latest.commenter}: {g.latest.text}
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
