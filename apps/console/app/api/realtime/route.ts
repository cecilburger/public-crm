import { getSession } from '@/lib/session';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Relays the API's `/v1/realtime` stream to the browser's EventSource.
 *
 * The browser never holds the access token — same reasoning as every other
 * page here — so it cannot open that connection itself. This route reads the
 * httpOnly cookie server-side, the same way every other call in `lib/api.ts`
 * does, and pipes the bytes straight through.
 */
export async function GET(req: Request) {
  const { accessToken } = await getSession();
  if (!accessToken) return new Response('unauthorized', { status: 401 });

  const upstream = await fetch(`${API_URL}/v1/realtime`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: req.signal,
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream?.ok || !upstream.body) return new Response('unavailable', { status: 502 });

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
