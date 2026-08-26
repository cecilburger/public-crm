import { describe, it, expect } from 'vitest';
import {
  serviceWindowOpen, requiresTemplate, guardOutbound, sendRatePerSecond,
  normalisePhone, formatPhoneId, maskPhone, periodFor, windowExpiry, shouldOpenWindow,
} from '@kirana/core';

const HOUR = 3600_000;
const now = new Date('2026-03-01T12:00:00Z');

describe('the 24-hour service window', () => {
  it('is open just inside 24 hours and shut just outside', () => {
    expect(serviceWindowOpen(new Date(now.getTime() - 23.9 * HOUR), now)).toBe(true);
    expect(serviceWindowOpen(new Date(now.getTime() - 24.1 * HOUR), now)).toBe(false);
  });

  it('is shut for a customer who has never written', () => {
    expect(serviceWindowOpen(null, now)).toBe(false);
    expect(requiresTemplate(null, now)).toBe(true);
  });
});

describe('the outbound gate', () => {
  const base = {
    now, channelQuality: 'green' as const, contactOptedOut: false,
    hasApprovedTemplate: true, isTemplateSend: false,
    lastInboundAt: new Date(now.getTime() - HOUR),
  };

  it('allows a free-form reply inside the window', () => {
    expect(guardOutbound(base).ok).toBe(true);
  });

  it('demands a template once the window has closed', () => {
    const late = { ...base, lastInboundAt: new Date(now.getTime() - 30 * HOUR) };
    expect(guardOutbound(late)).toEqual({ ok: false, reason: 'template_required' });
    expect(guardOutbound({ ...late, isTemplateSend: true }).ok).toBe(true);
  });

  it('refuses a template Meta has not approved', () => {
    const late = { ...base, lastInboundAt: null, isTemplateSend: true, hasApprovedTemplate: false };
    expect(guardOutbound(late)).toEqual({ ok: false, reason: 'template_not_approved' });
  });

  it('stops everything on a flagged number rather than losing the WABA', () => {
    expect(guardOutbound({ ...base, channelQuality: 'flagged' })).toEqual({ ok: false, reason: 'quality_paused' });
    expect(sendRatePerSecond('flagged')).toBe(0);
  });

  it('honours an opt-out for marketing but not for a live conversation', () => {
    expect(guardOutbound({ ...base, contactOptedOut: true, isTemplateSend: true }))
      .toEqual({ ok: false, reason: 'opted_out' });
    expect(guardOutbound({ ...base, contactOptedOut: true }).ok).toBe(true);
  });

  it('slows down as the quality rating drops', () => {
    expect(sendRatePerSecond('green')).toBeGreaterThan(sendRatePerSecond('yellow'));
    expect(sendRatePerSecond('yellow')).toBeGreaterThan(sendRatePerSecond('red'));
  });
});

describe('Indonesian phone numbers', () => {
  it('normalises every form the same customer arrives in', () => {
    for (const input of ['08123456789', '+628123456789', '628123456789', '0812-3456-789', ' 0812 3456 789 ']) {
      expect(normalisePhone(input)).toBe('+628123456789');
    }
  });

  it('rejects what is not a phone number', () => {
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('halo')).toBeNull();
    expect(normalisePhone('0812')).toBeNull();
  });

  it('formats and masks for display', () => {
    expect(formatPhoneId('+628123456789')).toBe('+62 812-3456-789');
    expect(maskPhone('+628123456789')).toBe('+62•••••••789');
  });
});

describe('billing periods and windows', () => {
  it('anchors the period to the signup day, not the 1st of the month', () => {
    const anchor = new Date('2026-01-20T00:00:00Z');
    const p = periodFor(anchor, new Date('2026-03-05T00:00:00Z'));
    expect(p.startsAt.toISOString()).toBe('2026-02-20T00:00:00.000Z');
    expect(p.endsAt.toISOString()).toBe('2026-03-20T00:00:00.000Z');
  });

  it('clamps a 31st anchor into shorter months instead of skipping them', () => {
    const anchor = new Date('2026-01-31T00:00:00Z');
    const p = periodFor(anchor, new Date('2026-02-15T00:00:00Z'));
    expect(p.startsAt.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(p.endsAt.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('opens a billing window only when none is live', () => {
    const open = { id: 'w1', expiresAt: new Date(now.getTime() + HOUR) };
    const stale = { id: 'w1', expiresAt: new Date(now.getTime() - 1) };
    expect(shouldOpenWindow(null, now)).toBe(true);
    expect(shouldOpenWindow(open, now)).toBe(false);
    expect(shouldOpenWindow(stale, now)).toBe(true);
    expect(windowExpiry(now).getTime() - now.getTime()).toBe(24 * HOUR);
  });
});
