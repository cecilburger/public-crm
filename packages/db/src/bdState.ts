import type { Ctx } from './repo.ts';

/**
 * The BD flow's per-conversation state (`bd_conversation_state`, migration
 * 0051), written from outside the flow.
 *
 * `bdDraft.ts` owns the ordinary write: the brain returns the whole state and
 * the processor upserts it. This file is for the one other writer — the
 * Instagram comment processor, which sends the bot's DM opener itself and has
 * to tell the flow that the opener went out. The opener asks the
 * qualification question, so the commenter's first DM reply must arrive at
 * `inbound_qualify`, where the flow reads it as the answer; left at `new`, the
 * reply was answered with the same questions a second time (24 Sep 2026,
 * inbound/README.md in the bot).
 */

/**
 * Seed a conversation's BD state, only if it has none.
 *
 * `on conflict do nothing`, and that is the whole point: a person who has
 * talked to us before keeps their place. A commenter who is already mid-way
 * through booking a meeting must not be rewound to the qualification form
 * because they also left a comment. Returns whether a row was written.
 */
export async function seedBdConversationState(
  ctx: Ctx,
  args: { conversationId: string; node: string; now?: Date },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into bd_conversation_state
       (tenant_id, conversation_id, node, outcome, last_outbound_at, updated_at)
     values ($1, $2, $3, 'followup', $4, now())
     on conflict (conversation_id) do nothing
     returning id`,
    [ctx.tenantId, args.conversationId, args.node, now],
  );
  return !!rows[0];
}

/** The node a conversation is at, or null when the flow has never seen it. */
export async function getBdConversationNode(ctx: Ctx, conversationId: string): Promise<string | null> {
  const rows = await ctx.tx.query<{ node: string }>(
    `select node from bd_conversation_state where tenant_id = $1 and conversation_id = $2`,
    [ctx.tenantId, conversationId],
  );
  return rows[0]?.node ?? null;
}
