import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound, forbidden, conflict, canTouchConversation, type Actor } from '@kirana/core';
import {
  getChatbotSettings, setChatbotEnabled, listChatbotChannels, setChannelChatbotEnabled, chatbotHandlingCounts,
  takeoverConversation, resumeBot, isChatbotChannelKind, divisionSql, type Sql,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

/** How far back a run skipped for want of a brain still raises the settings warning. */
const BRAIN_WARNING_WINDOW_HOURS = 24;

const idParams = z.object({ id: z.string().uuid() });
const enabledBody = z.object({ enabled: z.boolean() });

const scoped = (tx: Sql, actor: Actor) => ({ tx, tenantId: actor.tenantId, divisionId: actor.divisionId ?? null });

/** The same scope rule as replying: an agent acts only on threads that are theirs or nobody's. */
async function assertCanTouch(tx: Sql, actor: Actor, conversationId: string): Promise<void> {
  const rows = await tx.query<{ assignee_id: string | null }>(
    'select assignee_id from conversations where tenant_id = $1 and id = $2',
    [actor.tenantId, conversationId],
  );
  if (!rows[0]) throw notFound('Conversation');
  if (!canTouchConversation(actor, { assigneeId: rows[0].assignee_id })) {
    throw forbidden('This conversation is assigned to someone else');
  }
}

/**
 * The trained-cb DM chatbot: the division's switch, each DM account's opt-in,
 * and the hand-offs between the bot and a person on one conversation.
 */
export function registerChatbotRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.get('/v1/chatbot', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, async (tx, actor) => {
      const scope = scoped(tx, actor);
      const settings = await getChatbotSettings(scope);
      const channels = await listChatbotChannels(scope);
      const counts = await chatbotHandlingCounts(scope);
      const warning = await tx.query<{ found: boolean }>(
        `select exists (
           select 1 from chatbot_runs r
             join conversations c on c.id = r.conversation_id and c.tenant_id = r.tenant_id
            where r.tenant_id = $1 and c.division_id = ${divisionSql(2)}
              and r.skip_reason = 'brain_not_configured'
              and r.started_at > now() - ($3::int * interval '1 hour')
         ) as found`,
        [actor.tenantId, actor.divisionId ?? null, BRAIN_WARNING_WINDOW_HOURS],
      );
      return {
        enabled: settings.enabled,
        channels: channels.map((ch) => ({
          id: ch.id, kind: ch.kind, displayName: ch.display_name, status: ch.status, chatbotEnabled: ch.chatbot_enabled,
        })),
        counts,
        brainNotConfiguredRecently: warning[0]?.found ?? false,
      };
    });
  });

  app.put('/v1/chatbot', async (req) => {
    ctx.guard(req, 'autopilot:manage');
    const body = enabledBody.safeParse(req.body);
    if (!body.success) throw invalid('enabled must be true or false');

    return ctx.asTenant(req, async (tx, actor) => {
      const saved = await setChatbotEnabled(scoped(tx, actor), { enabled: body.data.enabled, actorId: actor.userId });
      return { enabled: saved.enabled };
    });
  });

  app.patch('/v1/channels/:id/chatbot', async (req) => {
    ctx.guard(req, 'channel:manage');
    const { id } = idParams.parse(req.params);
    const body = enabledBody.safeParse(req.body);
    if (!body.success) throw invalid('enabled must be true or false');

    return ctx.asTenant(req, async (tx, actor) => {
      const rows = await tx.query<{ kind: string }>(
        'select kind from channels where tenant_id = $1 and id = $2', [actor.tenantId, id]);
      if (!rows[0]) throw notFound('Channel');
      if (!isChatbotChannelKind(rows[0].kind)) {
        throw invalid('The chatbot answers WhatsApp Web, Instagram and Messenger direct messages only',
          { kind: rows[0].kind });
      }
      const saved = await setChannelChatbotEnabled(scoped(tx, actor), {
        channelId: id, enabled: body.data.enabled, actorId: actor.userId,
      });
      if (!saved) throw notFound('Channel');
      return { id: saved.id, chatbotEnabled: saved.chatbot_enabled };
    });
  });

  /**
   * An unassigned thread becomes the taker's. For an agent that is a
   * deliberate widening of `conversation:assign`, which agents lack: the
   * person who stops the bot is the one who has to answer next, and a thread
   * nobody owns after a takeover would go silent.
   */
  app.post('/v1/conversations/:id/takeover', async (req) => {
    ctx.guard(req, 'conversation:write');
    const { id } = idParams.parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      await assertCanTouch(tx, actor, id);
      const result = await takeoverConversation(scoped(tx, actor), { conversationId: id, actorId: actor.userId });
      if (!result) throw notFound('Conversation');
      return { handling: 'human' as const, cancelled: result.cancelledMessageIds.length };
    });
  });

  app.post('/v1/conversations/:id/bot/resume', async (req) => {
    ctx.guard(req, 'conversation:write');
    const { id } = idParams.parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      await assertCanTouch(tx, actor, id);
      const outcome = await resumeBot(scoped(tx, actor), { conversationId: id, actorId: actor.userId });
      if (outcome === 'not_found') throw notFound('Conversation');
      if (outcome === 'opt_out') throw conflict('This contact asked the bot to stop; a person has to keep handling it');
      return { handling: 'bot' as const };
    });
  });
}
