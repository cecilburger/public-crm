import { describe, it, expect } from 'vitest';
import { ipInCidr, ipAllowed, parseAllowList } from '@kirana/core';

describe('IP allow-listing', () => {
  it('matches inside an IPv4 range and refuses outside it', () => {
    expect(ipInCidr('203.0.113.7', '203.0.113.0/24')).toBe(true);
    expect(ipInCidr('203.0.113.255', '203.0.113.0/24')).toBe(true);
    expect(ipInCidr('203.0.114.1', '203.0.113.0/24')).toBe(false);
  });

  it('handles the wide and narrow ends without overflowing', () => {
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('203.0.113.7', '203.0.113.7/32')).toBe(true);
    expect(ipInCidr('203.0.113.8', '203.0.113.7/32')).toBe(false);
    // /1 crosses the sign bit — the classic place a shift goes wrong.
    expect(ipInCidr('200.0.0.1', '128.0.0.0/1')).toBe(true);
    expect(ipInCidr('100.0.0.1', '128.0.0.0/1')).toBe(false);
  });

  it('sees through the IPv4-mapped form Node reports behind a proxy', () => {
    expect(ipInCidr('::ffff:203.0.113.7', '203.0.113.0/24')).toBe(true);
  });

  it('takes a bare address as an exact match', () => {
    expect(ipInCidr('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipInCidr('203.0.113.8', '203.0.113.7')).toBe(false);
  });

  it('only claims an exact match for IPv6, never a guessed prefix', () => {
    expect(ipInCidr('2a03:2880::1', '2a03:2880::1')).toBe(true);
    expect(ipInCidr('2a03:2880::2', '2a03:2880::1')).toBe(false);
    // A prefix it cannot evaluate must refuse, not accept.
    expect(ipInCidr('2a03:2880::2', '2a03:2880::/32')).toBe(false);
  });

  it('refuses nonsense rather than accepting it', () => {
    expect(ipInCidr('203.0.113.7', '203.0.113.0/33')).toBe(false);
    expect(ipInCidr('203.0.113.7', 'not-a-network/24')).toBe(false);
    // An address that does not parse matches nothing at all — not even /0.
    // Refusing an input we cannot evaluate is the only safe reading of it.
    expect(ipInCidr('999.0.0.1', '0.0.0.0/0')).toBe(false);
    expect(ipInCidr('999.0.0.1', '203.0.113.0/24')).toBe(false);
  });

  it('treats an unset list as "not configured", not as "deny everything"', () => {
    expect(ipAllowed('203.0.113.7', [])).toBe(true);
    expect(ipAllowed('203.0.113.7', ['198.51.100.0/24'])).toBe(false);
    expect(ipAllowed('203.0.113.7', ['198.51.100.0/24', '203.0.113.0/24'])).toBe(true);
  });

  it('parses a configured list tolerantly', () => {
    expect(parseAllowList(' 203.0.113.0/24 , 198.51.100.5 ,, ')).toEqual(['203.0.113.0/24', '198.51.100.5']);
    expect(parseAllowList('')).toEqual([]);
  });
});
