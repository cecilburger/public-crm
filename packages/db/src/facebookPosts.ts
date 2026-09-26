import type { Ctx } from './repo.ts';

/**
 * A Facebook post's caption and age — what the inbox names a comment group
 * after, instead of the `pfbid…` slug no agent can read. See
 * `0063_facebook_posts.sql` for why it is its own table and what it holds.
 *
 * Descriptive only. Comments are filed, grouped, deduplicated and re-filed by
 * `post_id` exactly as before; nothing here decides which post a comment is on.
 */

export interface PostDetailsInput {
  postId: string;
  /** The caption as read, or null when this reading had none — a photo-only post, or one not rendered yet. */
  text: string | null;
  /** When the post went up, derived from Facebook's relative age; null when that could not be read. */
  createdAt: Date | null;
}

/**
 * Records what one reading of the Page said about each post.
 *
 * Every reading is merged rather than trusted outright, because readings
 * differ in how much they show:
 *
 * - A reading with no caption leaves the stored caption alone.
 * - A caption that is only the START of the stored one leaves the stored one:
 *   the timeline cuts a long caption behind "See more", while the post's own
 *   permalink shows it whole, and the sweep reads both.
 * - Any other caption is the Page's own edit, and replaces it.
 * - The age keeps the earliest reading. Facebook states it relatively ("5m",
 *   later "2 days ago"), a reading can only get coarser as the post ages, and
 *   a coarser one always lands at or after the true time — so the earliest is
 *   the most precise one there will ever be.
 *
 * Runs in the bridge session's division, which is where the row lands.
 * Returns how many posts were written.
 */
export async function recordFacebookPostDetails(
  ctx: Ctx, args: { pageId: string; posts: PostDetailsInput[] },
): Promise<number> {
  let stored = 0;
  for (const post of args.posts) {
    const rows = await ctx.tx.query<{ post_id: string }>(
      `insert into facebook_posts (tenant_id, page_id, post_id, post_text, post_created_at)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, division_id, post_id) do update set
         page_id = excluded.page_id,
         post_text = case
           when excluded.post_text is null then facebook_posts.post_text
           when facebook_posts.post_text is not null
            and length(facebook_posts.post_text) > length(excluded.post_text)
            and left(facebook_posts.post_text, length(excluded.post_text)) = excluded.post_text
             then facebook_posts.post_text
           else excluded.post_text
         end,
         post_created_at = least(facebook_posts.post_created_at, excluded.post_created_at)
       returning post_id`,
      [ctx.tenantId, args.pageId, post.postId, post.text?.trim() || null, post.createdAt],
    );
    stored += rows.length;
  }
  return stored;
}

/**
 * Carries a post's details to the slug Facebook now serves it under.
 *
 * Called where `recordFacebookComment` moves a post's comments onto a
 * re-issued `pfbid…`: the post is the same one, so its details follow. The
 * new slug may already have a row of its own, written from a later — so
 * coarser — reading of the timeline; the earlier age wins, and its caption
 * (the more recent reading) is kept when it has one.
 */
export async function carryFacebookPostDetails(
  ctx: Ctx, args: { fromPostId: string; toPostId: string },
): Promise<void> {
  await ctx.tx.query(
    `insert into facebook_posts (tenant_id, division_id, page_id, post_id, post_text, post_created_at)
     select tenant_id, division_id, page_id, $3, post_text, post_created_at
       from facebook_posts
      where tenant_id = $1 and post_id = $2
     on conflict (tenant_id, division_id, post_id) do update set
       post_text = coalesce(facebook_posts.post_text, excluded.post_text),
       post_created_at = least(facebook_posts.post_created_at, excluded.post_created_at)`,
    [ctx.tenantId, args.fromPostId, args.toPostId],
  );
}
