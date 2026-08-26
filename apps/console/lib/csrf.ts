import { cookies } from 'next/headers';

export const CSRF = 'kirana_csrf';

/**
 * Double-submit, with the cookie kept httpOnly.
 *
 * The usual double-submit pattern needs a cookie JavaScript can read, which
 * weakens it. Here the page is server-rendered, so the server reads the cookie
 * and writes the token into the form itself — the browser never needs access.
 * An attacker on another origin can neither read the cookie nor guess the field.
 *
 * Next already compares Origin against Host for server actions; this is the belt
 * to those braces, and it is what a security reviewer will look for.
 */
export async function csrfToken(): Promise<string> {
  const jar = await cookies();
  return jar.get(CSRF)?.value ?? '';
}

export class CsrfError extends Error {
  constructor() { super('Permintaan tidak sah. Muat ulang halaman lalu coba lagi.'); }
}

/** Called first in every server action, before anything is read or written. */
export async function assertCsrf(form: FormData): Promise<void> {
  const submitted = String(form.get('csrf') ?? '');
  const expected = await csrfToken();
  if (!expected || !submitted || submitted !== expected) throw new CsrfError();
}
