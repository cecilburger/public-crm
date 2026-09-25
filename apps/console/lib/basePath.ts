/**
 * Where the console is mounted. Empty when it owns the whole domain; `/crm`
 * when it shares one (dashboardmcn.my.id/crm). Set CONSOLE_BASE_PATH at build
 * time — next.config turns it into Next's `basePath` and this constant.
 *
 * Next adds the prefix itself to <Link>, router pushes and `redirect()`.
 * Everything else that names one of our own URLs as a bare string — fetch,
 * EventSource, a plain <a> or <img>, a form action, `new URL()` in a route
 * handler or middleware — goes through `withBase`, or it escapes the mount.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const withBase = (path: string) => `${BASE_PATH}${path}`;

/**
 * An absolute URL for one of our pages, as the browser must see it.
 *
 * Behind a proxy `req.url` carries the console's own listening address
 * (https://localhost:13000/…) — a redirect built from it sends the browser
 * somewhere it cannot reach. The proxy's X-Forwarded-Host/-Proto say where
 * the request really arrived. Trusting them is safe only because the console
 * listens on 127.0.0.1: nothing but the proxy can reach it to set them.
 */
export function appUrl(req: Request, path: string): URL {
  const own = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? own.host;
  const proto = req.headers.get('x-forwarded-proto') ?? own.protocol.replace(':', '');
  return new URL(withBase(path), `${proto}://${host}`);
}
