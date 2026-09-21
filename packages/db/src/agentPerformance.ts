import type { Ctx } from './repo.ts';

export interface AgentPerformanceRow {
  userId: string;
  name: string;
  handled: number;
  waiting: number;
  avgReplySeconds: number | null;
  resolved: number;
}

export interface AgentPerformanceSummary {
  activeAgents: number;
  handledToday: number;
  avgReplySeconds: number | null;
  resolutionPct: number | null;
  agents: AgentPerformanceRow[];
}

/**
 * Performa Agen's one read. Three numbers per agent — handled, waiting,
 * resolved — all counted off `conversations.assignee_id`, which is the same
 * column the inbox already uses to decide whose queue a chat sits in. No
 * separate CSAT/rating table exists in this schema, so there is no "Rating"
 * here — see the resolution rate instead, which is real.
 */
export async function getAgentPerformance(ctx: Ctx): Promise<AgentPerformanceSummary> {
  const { tx, tenantId } = ctx;

  const [agents, team, today] = await Promise.all([
    tx.query<{
      id: string; name: string; handled: number; waiting: number;
      avg_reply_seconds: number | null; resolved: number;
    }>(
      `select u.id, u.name,
              count(c.id)::int as handled,
              count(c.id) filter (
                where c.status <> 'resolved' and c.last_inbound_at is not null
                  and c.last_message_at = c.last_inbound_at)::int as waiting,
              extract(epoch from avg(c.first_response_at - c.created_at)
                       filter (where c.first_response_at is not null))::float as avg_reply_seconds,
              count(c.id) filter (where c.status = 'resolved')::int as resolved
         from users u
         left join conversations c on c.tenant_id = u.tenant_id and c.assignee_id = u.id
        where u.tenant_id = $1 and u.status = 'active' and u.role in ('owner','admin','supervisor','agent')
        group by u.id, u.name
        order by handled desc, u.name asc`,
      [tenantId],
    ),
    tx.query<{ avg_reply_seconds: number | null; resolved: number; total: number }>(
      `select
         extract(epoch from avg(first_response_at - created_at)
                  filter (where first_response_at is not null))::float as avg_reply_seconds,
         count(*) filter (where status = 'resolved')::int as resolved,
         count(*)::int as total
       from conversations where tenant_id = $1`,
      [tenantId],
    ),
    tx.query<{ n: number }>(
      `select count(distinct m.conversation_id)::int as n
         from messages m
        where m.tenant_id = $1 and m.sender_type = 'agent' and m.direction = 'outbound'
          and m.created_at >= current_date`,
      [tenantId],
    ),
  ]);

  const t = team[0];
  return {
    activeAgents: agents.length,
    handledToday: today[0]?.n ?? 0,
    avgReplySeconds: t?.avg_reply_seconds ?? null,
    resolutionPct: t && t.total > 0 ? Math.round((t.resolved / t.total) * 100) : null,
    agents: agents.map((a) => ({
      userId: a.id, name: a.name, handled: a.handled, waiting: a.waiting,
      avgReplySeconds: a.avg_reply_seconds, resolved: a.resolved,
    })),
  };
}
