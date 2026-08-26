/**
 * Security events, and the clock UU PDP attaches to some of them.
 *
 * Article 46 gives 3×24 hours to notify after *becoming aware* of a personal
 * data breach. Everything here exists to make "becoming aware" a timestamp
 * rather than the moment somebody happens to read a log.
 */

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export type SecurityEventKind =
  | 'audit_chain_broken'      // history was altered out of band
  | 'cross_tenant_denied'     // a query tried to leave its tenant
  | 'refresh_token_reuse'     // a session token was used twice — copied
  | 'login_lockout'           // repeated wrong passwords for one account
  | 'mfa_lockout'             // repeated wrong second factors
  | 'webhook_signature_flood' // someone posting unsigned payloads at volume
  | 'bulk_contact_reveal'     // an unusual number of phone numbers unmasked
  | 'dsr_overdue';            // a data subject request past its statutory date

interface Profile {
  severity: SecuritySeverity;
  /**
   * Whether personal data is plausibly affected. This is the flag that starts
   * the statutory clock, and it is deliberately generous: over-notifying is
   * embarrassing, under-notifying is unlawful.
   */
  notifiable: boolean;
  summary: string;
}

export const SECURITY_EVENTS: Record<SecurityEventKind, Profile> = {
  audit_chain_broken: {
    severity: 'critical', notifiable: true,
    summary: 'The audit log no longer verifies — rows were changed or removed outside the application',
  },
  cross_tenant_denied: {
    severity: 'critical', notifiable: true,
    summary: 'A query attempted to read or write another tenant and was refused by the database',
  },
  refresh_token_reuse: {
    severity: 'warning', notifiable: true,
    summary: 'A refresh token was presented twice, which means a copy of it exists',
  },
  login_lockout: {
    severity: 'info', notifiable: false,
    summary: 'Repeated failed sign-ins for one account',
  },
  mfa_lockout: {
    severity: 'info', notifiable: false,
    summary: 'Repeated failed second-factor codes for one account',
  },
  webhook_signature_flood: {
    severity: 'warning', notifiable: false,
    summary: 'Unsigned or wrongly signed webhook payloads arriving at volume',
  },
  bulk_contact_reveal: {
    severity: 'warning', notifiable: true,
    summary: 'An unusual number of customer phone numbers were unmasked by one person',
  },
  dsr_overdue: {
    severity: 'warning', notifiable: false,
    summary: 'A data subject request has passed its statutory due date',
  },
};

/** UU PDP art. 46 — 3×24 hours from awareness. */
export const NOTIFY_WINDOW_MS = 72 * 60 * 60 * 1000;

export const isNotifiable = (kind: SecurityEventKind): boolean => SECURITY_EVENTS[kind].notifiable;
export const severityOf = (kind: SecurityEventKind): SecuritySeverity => SECURITY_EVENTS[kind].severity;

export function notificationDeadline(detectedAt: Date): Date {
  return new Date(detectedAt.getTime() + NOTIFY_WINDOW_MS);
}

export type ClockState = 'not_applicable' | 'running' | 'due_soon' | 'overdue' | 'notified';

/**
 * Where a given event stands against its deadline. `due_soon` fires with twelve
 * hours to go, which is enough time for a person to actually do something.
 */
export function clockState(
  event: { kind: SecurityEventKind; detectedAt: Date; notifiedAt: Date | null },
  now: Date,
): ClockState {
  if (!isNotifiable(event.kind)) return 'not_applicable';
  if (event.notifiedAt) return 'notified';

  const deadline = notificationDeadline(event.detectedAt);
  const remaining = deadline.getTime() - now.getTime();
  if (remaining <= 0) return 'overdue';
  if (remaining <= 12 * 60 * 60 * 1000) return 'due_soon';
  return 'running';
}

/* ----------------------------------------------------------------- sinks */

export interface SecurityAlert {
  kind: SecurityEventKind;
  severity: SecuritySeverity;
  tenantId: string;
  summary: string;
  detail: Record<string, unknown>;
  detectedAt: Date;
  notifiable: boolean;
}

export interface AlertSink {
  deliver(alert: SecurityAlert): Promise<void>;
}

/** Always on. Structured, so a log pipeline can alert on severity. */
export class LogAlertSink implements AlertSink {
  constructor(private write: (line: string) => void = console.error) {}

  async deliver(alert: SecurityAlert): Promise<void> {
    this.write(JSON.stringify({
      level: alert.severity === 'critical' ? 'fatal' : alert.severity,
      event: 'security_alert',
      kind: alert.kind,
      tenant: alert.tenantId,
      notifiable: alert.notifiable,
      summary: alert.summary,
      detail: alert.detail,
      at: alert.detectedAt.toISOString(),
    }));
  }
}

/**
 * `WebhookAlertSink` used to live here. It was moved to the worker
 * (`apps/worker/src/alerts/webhook.ts`) because it makes an HTTP request, and
 * this package is supposed to be rules with no I/O. It had no *import* to give
 * it away — it closed over the global `fetch` — which is exactly why the
 * architecture test in tests/architecture.test.ts now checks for the capability
 * rather than the import.
 */

/** Sends to several places, and one failure does not stop the others. */
export class FanOutSink implements AlertSink {
  constructor(private sinks: AlertSink[]) {}
  async deliver(alert: SecurityAlert): Promise<void> {
    await Promise.allSettled(this.sinks.map((sink) => sink.deliver(alert)));
  }
}
