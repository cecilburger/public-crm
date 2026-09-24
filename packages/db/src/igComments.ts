import type { Ctx } from './repo.ts';
import { tenantKeys, sealField, openField } from './keys.ts';

export type CommentStepStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface IgCommentRow {
  id: string;
  /** The division whose account this was left on — which bridge session answers it. */
  divisionId: string;
  platform: 'instagram' | 'facebook';
  postRef: string;
  commentRef: string;
  /** Set when this comment is a reply inside another comment's thread. */
  parentRef: string | null;
  commenter: string;
  text: string;
  publicStatus: CommentStepStatus;
  dmStatus: CommentStepStatus;
  publicReply: string | null;
  lastError: string | null;
  conversationId: string | null;
  commentedAt: Date | null;
  createdAt: Date;
}

interface DbRow {
  id: string; division_id: string; platform: 'instagram' | 'facebook'; post_ref: string; comment_ref: string;
  parent_ref: string | null;
  commenter_enc: string; text_enc: string;
  public_status: CommentStepStatus; dm_status: CommentStepStatus;
  public_reply_enc: string | null; last_error: string | null;
  conversation_id: string | null; commented_at: Date | null; created_at: Date;
}

const COLUMNS = `id, division_id, platform, post_ref, comment_ref, parent_ref, commenter_enc, text_enc,
                 public_status, dm_status, public_reply_enc, last_error,
                 conversation_id, commented_at, created_at`;

function mapRow(r: DbRow, keys: Parameters<typeof openField>[0], tenantId: string): IgCommentRow {
  return {
    id: r.id, divisionId: r.division_id, platform: r.platform, postRef: r.post_ref, commentRef: r.comment_ref,
    parentRef: r.parent_ref,
    commenter: openField(keys, tenantId, r.commenter_enc),
    text: openField(keys, tenantId, r.text_enc),
    publicStatus: r.public_status, dmStatus: r.dm_status,
    publicReply: r.public_reply_enc ? openField(keys, tenantId, r.public_reply_enc) : null,
    lastError: r.last_error, conversationId: r.conversation_id,
    commentedAt: r.commented_at, createdAt: r.created_at,
  };
}

/**
 * One comment, from whichever source saw it.
 *
 * Idempotent on the comment's own id: the scraper re-reads a post on every
 * pass and Meta retries a webhook it thinks failed, so the same comment
 * arrives many times and must land on one row. A re-read only refreshes the
 * text — never the reply statuses, which belong to whoever acted on it.
 */
export async function recordIgComment(
  ctx: Ctx,
  args: {
    platform?: 'instagram' | 'facebook';
    postRef: string; commentRef: string; commenter: string; text: string;
    parentRef?: string | null;
    commentedAt?: Date | null;
  },
): Promise<{ id: string; created: boolean }> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{ id: string; created: boolean }>(
    `insert into ig_comments
       (tenant_id, platform, post_ref, comment_ref, parent_ref, commenter_enc, text_enc, commented_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (tenant_id, platform, comment_ref) do update
       set text_enc = excluded.text_enc, updated_at = now()
     returning id, (xmax = 0) as created`,
    [ctx.tenantId, args.platform ?? 'instagram', args.postRef, args.commentRef,
     args.parentRef ?? null,
     sealField(keys, ctx.tenantId, args.commenter),
     sealField(keys, ctx.tenantId, args.text),
     args.commentedAt ?? null],
  );
  return { id: rows[0]!.id, created: rows[0]!.created };
}

/**
 * The list page. `pendingOnly` is the tab an agent actually works from — so
 * it means "still needs a person", which includes the ones the bot tried and
 * failed at. Filtering on `pending` alone hid exactly those: a failed reply
 * left the work queue silently, and the only tab that showed it again was
 * the one nobody works from.
 */
export async function listIgComments(
  ctx: Ctx, args: { pendingOnly?: boolean; limit?: number } = {},
): Promise<IgCommentRow[]> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<DbRow>(
    `select ${COLUMNS} from ig_comments
      where tenant_id = $1 and ($3::bool is false or public_status in ('pending', 'failed'))
      order by coalesce(commented_at, created_at) desc
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 100, 500), args.pendingOnly ?? false],
  );
  return rows.map((r) => mapRow(r, keys, ctx.tenantId));
}

export async function getIgComment(ctx: Ctx, commentId: string): Promise<IgCommentRow | null> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<DbRow>(
    `select ${COLUMNS} from ig_comments where tenant_id = $1 and id = $2`,
    [ctx.tenantId, commentId],
  );
  return rows[0] ? mapRow(rows[0], keys, ctx.tenantId) : null;
}

/**
 * Records what happened to one of the two steps.
 *
 * Both are optional and set independently: the public line can go out while
 * the DM fails, which is the normal case for someone who has never messaged
 * the account, and the page has to be able to show exactly that.
 */
export async function setIgCommentOutcome(
  ctx: Ctx,
  args: {
    commentId: string;
    publicStatus?: CommentStepStatus;
    dmStatus?: CommentStepStatus;
    publicReply?: string | null;
    conversationId?: string | null;
    contactId?: string | null;
    lastError?: string | null;
  },
): Promise<boolean> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{ id: string }>(
    `update ig_comments set
        public_status    = coalesce($3, public_status),
        dm_status        = coalesce($4, dm_status),
        public_reply_enc = case when $5 then $6 else public_reply_enc end,
        conversation_id  = coalesce($7, conversation_id),
        contact_id       = coalesce($8, contact_id),
        last_error       = case when $9 then $10 else last_error end,
        updated_at       = now()
      where tenant_id = $1 and id = $2
      returning id`,
    [
      ctx.tenantId, args.commentId,
      args.publicStatus ?? null, args.dmStatus ?? null,
      args.publicReply !== undefined,
      args.publicReply ? sealField(keys, ctx.tenantId, args.publicReply) : null,
      args.conversationId ?? null, args.contactId ?? null,
      args.lastError !== undefined, args.lastError ?? null,
    ],
  );
  return !!rows[0];
}
