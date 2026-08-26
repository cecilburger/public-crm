import { describe, it, expect, vi, afterEach } from 'vitest';
import { rp, num, ago, clock, initials, awaitingReply } from '../apps/console/lib/format.ts';
import { expiresAt } from '../apps/console/lib/session.ts';

describe('console formatting', () => {
  afterEach(() => vi.useRealTimers());

  it('writes rupiah the Indonesian way', () => {
    expect(rp(1_500_000)).toBe('Rp 1.500.000');
    expect(rp('3900000')).toBe('Rp 3.900.000');
    expect(num(24_900_000)).toBe('24.900.000');
  });

  it('shows inbox ages at the resolution that matters', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-03-01T12:00:00Z'));
    expect(ago(new Date('2026-03-01T11:59:30Z').toISOString())).toBe('now');
    expect(ago(new Date('2026-03-01T11:40:00Z').toISOString())).toBe('20m');
    expect(ago(new Date('2026-03-01T06:00:00Z').toISOString())).toBe('6h');
    expect(ago(new Date('2026-02-27T12:00:00Z').toISOString())).toBe('2d');
    expect(ago(null)).toBe('—');
  });

  it('dates a message once it is no longer today', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-03-01T12:00:00Z'));
    const today = clock(new Date('2026-03-01T09:30:00Z').toISOString());
    const older = clock(new Date('2026-02-27T09:30:00Z').toISOString());
    expect(today).not.toMatch(/[A-Za-z]/);        // time only
    expect(older).toMatch(/\d+ \w+/);             // carries a date
  });

  it('builds avatar initials without falling over on missing names', () => {
    expect(initials('Rani Putri')).toBe('RP');
    expect(initials('Sinta')).toBe('S');
    expect(initials(null)).toBe('?');
  });
});

describe('the inbox queue rule', () => {
  const base = { status: 'open', last_inbound_at: '2026-03-01T09:00:00Z', last_message_at: '2026-03-01T09:00:00Z' };

  it('flags a thread where the customer spoke last', () => {
    expect(awaitingReply(base)).toBe(true);
  });

  it('does not flag a thread we have already answered', () => {
    expect(awaitingReply({ ...base, last_message_at: '2026-03-01T09:05:00Z' })).toBe(false);
  });

  it('never flags a resolved thread', () => {
    expect(awaitingReply({ ...base, status: 'resolved' })).toBe(false);
  });

  it('never flags a thread the customer has not written in', () => {
    expect(awaitingReply({ ...base, last_inbound_at: null })).toBe(false);
  });
});

describe('session token inspection', () => {
  const jwt = (exp: number) =>
    `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

  it('reads the expiry a refresh decision depends on', () => {
    expect(expiresAt(jwt(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it('treats anything unparseable as already expired, so the session refreshes', () => {
    expect(expiresAt(null)).toBe(0);
    expect(expiresAt('not-a-jwt')).toBe(0);
    expect(expiresAt('a.!!!!.c')).toBe(0);
    expect(expiresAt('a.eyJubyI6ImV4cCJ9.c')).toBe(0);
  });
});
