import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

/**
 * Prometheus metrics.
 *
 * One rule shapes every label here: **no tenant identifiers**. A label per
 * workspace is an unbounded cardinality explosion that will eventually take the
 * monitoring system down, and it turns a metrics scrape into a customer list.
 * Per-tenant numbers belong in the usage endpoint, which is authenticated.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'kirana_' });

export const httpRequests = new Counter({
  name: 'kirana_http_requests_total',
  help: 'HTTP requests by method, route pattern and status class',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'kirana_http_request_duration_seconds',
  help: 'Request duration by route pattern',
  labelNames: ['method', 'route'] as const,
  // Tuned for an API whose slow path is a database round trip, not a model call.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const webhookEvents = new Counter({
  name: 'kirana_webhook_events_total',
  help: 'Provider webhooks by outcome',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

export const conversationsBilled = new Counter({
  name: 'kirana_billable_conversations_total',
  help: '24-hour conversation windows opened, which is what customers pay for',
  registers: [registry],
});

export const autopilotOutcomes = new Counter({
  name: 'kirana_autopilot_outcomes_total',
  help: 'Autopilot drafts by what happened to them',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * The route *pattern*, never the URL.
 *
 * `/v1/conversations/:id` is one time series; `/v1/conversations/<uuid>` is one
 * per conversation, which is how a metrics backend dies.
 */
export function routeLabel(routePattern: string | undefined, url: string): string {
  if (routePattern) return routePattern;
  const path = url.split('?')[0] ?? '';
  return path.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id');
}
