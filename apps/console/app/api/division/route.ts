import { NextResponse, type NextRequest } from 'next/server';
import { DIV, cookieOptions } from '@/lib/session';
import { CSRF } from '@/lib/csrf';

const DIVISIONS = new Set(['marketing', 'ai']);

/**
 * Switches the division the console shows.
 *
 * A plain form post answered with a 303, on purpose: that is a full navigation,
 * so the client router cache (`staleTimes.dynamic`) cannot hand back a page
 * rendered for the other division, and no JavaScript is needed for the switch
 * to work. The cookie is only a hint — the API re-resolves the key under the
 * signed-in tenant on every request — but the form is still CSRF-checked, the
 * same double-submit the sign-in exchange uses, so another site cannot flip
 * what an agent is looking at.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();

  const expected = req.cookies.get(CSRF)?.value;
  const submitted = String(form.get('csrf') ?? '');
  if (!expected || submitted !== expected) {
    return new NextResponse('Permintaan tidak sah. Muat ulang halaman lalu coba lagi.', { status: 403 });
  }

  const division = String(form.get('division') ?? '');
  if (!DIVISIONS.has(division)) return new NextResponse('Divisi tidak dikenal.', { status: 400 });

  // Only same-origin paths, so a crafted returnTo cannot bounce the user
  // elsewhere on the back of a legitimate switch.
  const returnTo = String(form.get('returnTo') ?? '/obrolan');
  const target = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/obrolan';

  const res = NextResponse.redirect(new URL(target, req.url), { status: 303 });
  res.cookies.set(DIV, division, { ...cookieOptions, maxAge: 60 * 60 * 24 * 365 });
  return res;
}
