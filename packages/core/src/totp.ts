import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), implemented directly.
 *
 * No dependency, because the algorithm is forty lines and a supply-chain risk
 * sitting in the authentication path is a poor trade for forty lines. It is
 * pinned to the RFC's own test vectors in tests/totp.test.ts, which is a
 * stronger guarantee than a package's download count.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side, so a slightly wrong phone clock still works. */
const DEFAULT_DRIFT_STEPS = 1;

/* ------------------------------------------------------------- base32 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* --------------------------------------------------------------- totp */

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buf).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: Buffer, atSeconds: number, digits = DIGITS): string {
  return hotp(secret, Math.floor(atSeconds / STEP_SECONDS), digits);
}

/**
 * Verify a code, allowing one step of clock drift either way.
 *
 * Returns the counter it matched so the caller can reject a replay: the same
 * code inside its own 30-second window is valid arithmetic and a stolen code the
 * second time it is used.
 */
export function verifyTotp(
  secret: Buffer, code: string, atSeconds: number,
  opts: { driftSteps?: number; digits?: number } = {},
): { ok: boolean; counter?: number } {
  const digits = opts.digits ?? DIGITS;
  const drift = opts.driftSteps ?? DEFAULT_DRIFT_STEPS;
  const candidate = (code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return { ok: false };

  const current = Math.floor(atSeconds / STEP_SECONDS);
  for (let offset = -drift; offset <= drift; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = hotp(secret, counter, digits);
    // Constant time: a timing oracle on a six-digit code is a real attack.
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, counter };
  }
  return { ok: false };
}

export function newTotpSecret(bytes = 20): Buffer {
  return randomBytes(bytes);
}

/** The string an authenticator app scans. Label and issuer must be encoded. */
export function otpauthUri(args: { secret: Buffer; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${args.issuer}:${args.account}`);
  const params = new URLSearchParams({
    secret: base32Encode(args.secret),
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------- backup codes */

/**
 * Ten single-use codes, shown once. A phone gets lost, and an MFA rollout with
 * no recovery path becomes a support queue full of locked-out shop owners.
 */
export function newBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const normaliseBackupCode = (code: string): string =>
  (code ?? '').toUpperCase().replace(/[^A-F0-9]/g, '');
