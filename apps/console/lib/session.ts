import { cookies } from 'next/headers';

/**
 * Tokens live in httpOnly cookies, never in localStorage.
 *
 * The console is a server-rendered client of the API: the browser holds a
 * cookie it cannot read, and every call to the API is made from the server with
 * the access token attached. An XSS in the console therefore cannot exfiltrate a
 * session — it would have to ride along on requests instead, which is a much
 * smaller blast radius.
 */
export const AT = 'kirana_at';
export const RT = 'kirana_rt';
export const WS = 'kirana_ws';
/** The receipt held between password and second factor. Short-lived. */
export const MFA = 'kirana_mfa';

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

export async function getSession() {
  const jar = await cookies();
  return {
    accessToken: jar.get(AT)?.value ?? null,
    refreshToken: jar.get(RT)?.value ?? null,
    workspace: jar.get(WS)?.value ?? null,
  };
}

/** Reads `exp` without verifying — the API is the only thing that trusts it. */
export function expiresAt(jwt: string | null): number {
  if (!jwt) return 0;
  const part = jwt.split('.')[1];
  if (!part) return 0;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString()) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}
