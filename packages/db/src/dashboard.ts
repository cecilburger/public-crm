import type { Ctx } from './repo.ts';

export interface DashboardSummary {
  totalClients: number;
  newClientsThisWeek: number;
  unansweredCount: number;
  salesThisMonthMicros: string;
  salesLastMonthMicros: string;
  avgReplySeconds: number | null;
  daily: { date: string; count: number }[];
  channels: { kind: string; count: number }[];
  pipeline: { stageName: string; isWon: boolean; amountMicros: string }[];
  recentContacts: {
    id: string; displayName: string | null; phoneEnc: string | null;
    tags: string[]; lastSeenAt: Date;
  }[];
}

/**
 * Everything the Dashboard page shows, in one round trip. Each number is a
 * plain aggregate over data other pages already write — no new tables, no
 * second copy of anything.
 */
export async function getDashboardSummary(ctx: Ctx): Promise<DashboardSummary> {
  const { tx, tenantId } = ctx;

  const [clients, unanswered, sales, reply, daily, channels, pipeline, recent] = await Promise.all([
    tx.query<{ total: number; new_this_week: number }>(
      `select count(*)::int as total,
              count(*) filter (where first_seen_at >= now() - interval '7 days')::int as new_this_week
         from contacts where tenant_id = $1 and deleted_at is null`,
      [tenantId],
    ),
    tx.query<{ n: number }>(
      `select count(*)::int as n from conversations
        where tenant_id = $1 and status <> 'resolved'
          and last_inbound_at is not null and last_message_at = last_inbound_at`,
      [tenantId],
    ),
    tx.query<{ this_month: string; last_month: string }>(
      `select
         coalesce(sum(total_micros) filter (
           where status in ('paid','fulfilled') and paid_at >= date_trunc('month', now())), 0) as this_month,
         coalesce(sum(total_micros) filter (
           where status in ('paid','fulfilled')
             and paid_at >= date_trunc('month', now()) - interval '1 month'
             and paid_at < date_trunc('month', now())), 0) as last_month
       from orders where tenant_id = $1`,
      [tenantId],
    ),
    tx.query<{ avg_seconds: number | null }>(
      `select extract(epoch from avg(first_response_at - created_at))::float as avg_seconds
         from conversations
        where tenant_id = $1 and first_response_at is not null and created_at >= now() - interval '7 days'`,
      [tenantId],
    ),
    tx.query<{ day: string; n: number }>(
      `select to_char(d.day, 'YYYY-MM-DD') as day, count(m.id)::int as n
         from generate_series(current_date - interval '6 days', current_date, interval '1 day') as d(day)
         left join messages m on m.tenant_id = $1 and m.direction = 'inbound'
           and m.created_at >= d.day and m.created_at < d.day + interval '1 day'
        group by d.day order by d.day`,
      [tenantId],
    ),
    tx.query<{ kind: string; n: number }>(
      `select ch.kind, count(m.id)::int as n
         from messages m join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
        where m.tenant_id = $1 and m.created_at >= now() - interval '30 days'
        group by ch.kind order by n desc`,
      [tenantId],
    ),
    tx.query<{ stage_name: string; is_won: boolean; amount: string }>(
      `select s.name as stage_name, s.is_won, coalesce(sum(d.amount_micros), 0) as amount
         from pipeline_stages s
         join pipelines p on p.id = s.pipeline_id and p.tenant_id = s.tenant_id
         left join deals d on d.stage_id = s.id and d.tenant_id = s.tenant_id and d.status <> 'lost'
        where s.tenant_id = $1 and p.is_default
        group by s.id, s.name, s.position, s.is_won
        order by s.position`,
      [tenantId],
    ),
    tx.query<{
      id: string; display_name: string | null; phone_enc: string | null; tags: string[]; last_seen_at: Date;
    }>(
      `select id, display_name, phone_enc, tags, last_seen_at
         from contacts where tenant_id = $1 and deleted_at is null
        order by last_seen_at desc limit 5`,
      [tenantId],
    ),
  ]);

  return {
    totalClients: clients[0]?.total ?? 0,
    newClientsThisWeek: clients[0]?.new_this_week ?? 0,
    unansweredCount: unanswered[0]?.n ?? 0,
    salesThisMonthMicros: sales[0]?.this_month ?? '0',
    salesLastMonthMicros: sales[0]?.last_month ?? '0',
    avgReplySeconds: reply[0]?.avg_seconds ?? null,
    daily: daily.map((r) => ({ date: r.day, count: r.n })),
    channels: channels.map((r) => ({ kind: r.kind, count: r.n })),
    pipeline: pipeline.map((r) => ({ stageName: r.stage_name, isWon: r.is_won, amountMicros: r.amount })),
    recentContacts: recent.map((r) => ({
      id: r.id, displayName: r.display_name, phoneEnc: r.phone_enc, tags: r.tags, lastSeenAt: r.last_seen_at,
    })),
  };
}
