/**
 * WhatsApp Business Platform rules we have to enforce ourselves, because Meta
 * enforces them by rejecting the send — and a rejected send is a customer who
 * never got an answer.
 */
export type MetaCategory = 'service' | 'utility' | 'marketing' | 'authentication';

/** Meta's free-form reply window: 24h from the customer's last inbound message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function serviceWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

/** Outside the window only a pre-approved template may be sent. */
export function requiresTemplate(lastInboundAt: Date | null, now: Date): boolean {
  return !serviceWindowOpen(lastInboundAt, now);
}

/**
 * Meta's per-conversation rate card, in IDR. These are configuration, not
 * constants of the universe — they change and they differ by country, so the
 * worker reads the live table and falls back to this only in development.
 */
export const META_RATE_IDR: Record<MetaCategory, number> = {
  service: 0,          // service conversations are free since Nov 2024
  utility: 350,
  marketing: 900,
  authentication: 500,
};

export interface SendGuard {
  ok: boolean;
  reason?: 'template_required' | 'template_not_approved' | 'quality_paused' | 'rate_limited' | 'opted_out';
}

export interface SendContext {
  lastInboundAt: Date | null;
  now: Date;
  hasApprovedTemplate: boolean;
  channelQuality: 'green' | 'yellow' | 'red' | 'flagged';
  contactOptedOut: boolean;
  isTemplateSend: boolean;
}

/**
 * One gate every outbound message passes through, in the worker — never in the
 * API handler, so a retry or an automation cannot route around it.
 */
export function guardOutbound(ctx: SendContext): SendGuard {
  if (ctx.contactOptedOut && ctx.isTemplateSend) return { ok: false, reason: 'opted_out' };
  if (ctx.channelQuality === 'flagged') return { ok: false, reason: 'quality_paused' };
  if (requiresTemplate(ctx.lastInboundAt, ctx.now)) {
    if (!ctx.isTemplateSend) return { ok: false, reason: 'template_required' };
    if (!ctx.hasApprovedTemplate) return { ok: false, reason: 'template_not_approved' };
  }
  return { ok: true };
}

/**
 * Meta throttles by quality rating. Sending at full tilt into a yellow number is
 * how a WABA gets flagged, so we pace ourselves before they do it for us.
 */
export function sendRatePerSecond(quality: SendContext['channelQuality']): number {
  return { green: 80, yellow: 20, red: 5, flagged: 0 }[quality];
}
