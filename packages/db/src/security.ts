import {
  SECURITY_EVENTS, isNotifiable, severityOf, clockState, notificationDeadline,
  type SecurityAlert, type SecurityEventKind, type ClockState,
} from '@kirana/core';
import type { Sql } from './sql.ts';

export interface RecordedEvent {
  id: string;
  alert: SecurityAlert;
}

/**
 * Write down that we became aware, and when.
 *
 * Delivery to a human happens after the transaction commits — an alert that
 * cannot be posted must never roll back the record of the thing it was alerting
 * about.
 */
export async function recordSecurityEvent(
  tx: Sql,
  tenantId: string,
  kind: SecurityEventKind,
  detail: Record<string, unknown> = {},
  at: Date = new Date(),
): Promise<RecordedEvent> {
  const profile = SECURITY_EVENTS[kind];
  const rows = await tx.query<{ id: string }>(
    `insert into security_events (tenant_id, kind, severity, notifiable, summary, detail, detected_at)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [tenantId, kind, profile.severity, profile.notifiable, profile.summary, JSON.stringify(detail), at],
  );

  return {
    id: rows[0]!.id,
    alert: {
      kind,
      severity: severityOf(kind),
      tenantId,
      summary: profile.summary,
      detail,
      detectedAt: at,
      notifiable: isNotifiable(kind),
    },
  };
}

export interface SecurityEventRow {
  id: string;
  kind: SecurityEventKind;
  severity: string;
  notifiable: boolean;
  summary: string;
  detail: Record<string, unknown>;
  detectedAt: Date;
  notifiedAt: Date | null;
  acknowledgedAt: Date | null;
  clock: ClockState;
  deadline: Date | null;
}

export async function listSecurityEvents(
  tx: Sql, tenantId: string, opts: { limit?: number; openOnly?: boolean } = {},
): Promise<SecurityEventRow[]> {
  const rows = await tx.query<{
    id: string; kind: string; severity: string; notifiable: boolean; summary: string;
    detail: unknown; detected_at: Date; notified_at: Date | null; acknowledged_at: Date | null;
  }>(
    `select id, kind, severity, notifiable, summary, detail, detected_at, notified_at, acknowledged_at
       from security_events
      where tenant_id = $1 and ($2::boolean is not true or acknowledged_at is null)
      order by detected_at desc limit $3`,
    [tenantId, opts.openOnly ?? false, Math.min(opts.limit ?? 100, 500)],
  );

  const now = new Date();
  return rows.map((r) => {
    const kind = r.kind as SecurityEventKind;
    const detectedAt = new Date(r.detected_at);
    const notifiedAt = r.notified_at ? new Date(r.notified_at) : null;
    return {
      id: r.id, kind, severity: r.severity, notifiable: r.notifiable, summary: r.summary,
      detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
      detectedAt, notifiedAt,
      acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at) : null,
      clock: clockState({ kind, detectedAt, notifiedAt }, now),
      deadline: isNotifiable(kind) ? notificationDeadline(detectedAt) : null,
    };
  });
}

export async function acknowledgeSecurityEvent(
  tx: Sql, tenantId: string, id: string, userId: string, notes?: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `update security_events
        set acknowledged_at = now(), acknowledged_by = $3, notes = coalesce($4, notes)
      where tenant_id = $1 and id = $2 and acknowledged_at is null
      returning id`,
    [tenantId, id, userId, notes ?? null],
  );
  return rows.length > 0;
}

/** Records that the regulator and the affected people were told — stops the clock. */
export async function markNotified(
  tx: Sql, tenantId: string, id: string, userId: string, notes?: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    `update security_events
        set notified_at = now(), notified_by = $3, notes = coalesce($4, notes)
      where tenant_id = $1 and id = $2 and notified_at is null
      returning id`,
    [tenantId, id, userId, notes ?? null],
  );
  return rows.length > 0;
}
