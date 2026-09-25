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
