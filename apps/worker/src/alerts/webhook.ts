import { notificationDeadline, type AlertSink, type SecurityAlert } from '@kirana/core';

/**
 * Posts to an operations webhook — Slack, PagerDuty, whatever is on call.
 * Failing to deliver an alert must never fail the operation that raised it, so
 * errors are swallowed after being logged: a security event that is recorded but
 * not delivered is far better than a request that dies trying to tell someone.
 */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private url: string,
    private fetchImpl: typeof fetch = fetch,
    private onError: (err: Error) => void = () => {},
  ) {}

  async deliver(alert: SecurityAlert): Promise<void> {
    try {
      await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `[${alert.severity.toUpperCase()}] ${alert.summary}`,
          kind: alert.kind,
          tenant: alert.tenantId,
          notifiable: alert.notifiable,
          deadline: alert.notifiable ? notificationDeadline(alert.detectedAt).toISOString() : null,
          detail: alert.detail,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      this.onError(err as Error);
    }
  }
}
