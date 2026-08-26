/**
 * IP allow-listing for the provider webhook.
 *
 * Deliberately small: IPv4 CIDR, plus exact matches for IPv6 and single
 * addresses. Meta publishes IPv4 ranges, and a half-correct IPv6 prefix matcher
 * that silently accepts the wrong network is worse than one that only accepts
 * what it is certain about.
 */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const clean = ip.replace(/^::ffff:/i, ''); // IPv4-mapped IPv6, as Node reports it
  const [network, bitsRaw] = cidr.split('/');
  if (!network) return false;

  if (bitsRaw === undefined) return clean === network.replace(/^::ffff:/i, '');

  const bits = Number(bitsRaw);
  const target = ipv4ToInt(clean);
  const base = ipv4ToInt(network);

  if (target === null || base === null) {
    // Not IPv4 on one side or the other: only an exact match is safe to claim.
    return clean === network;
  }
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;

  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (target & mask) === (base & mask);
}

/** An empty list means "not configured", which allows everything. */
export function ipAllowed(ip: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  return allowList.some((entry) => ipInCidr(ip, entry.trim()));
}

export function parseAllowList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
