/**
 * Temporary, step-level tracing for the browser flows.
 *
 * Off unless `FB_BRIDGE_DEBUG=true`, and deliberately so: every line here
 * describes a step inside somebody's Facebook inbox, which is not something to
 * write into a log by default. It exists because the failures in this service
 * are silent by nature — a selector that matches nothing returns null exactly
 * like a page that genuinely has nothing — and the only way to tell those
 * apart is to have the code say which step gave up.
 */
export const DEBUG = process.env.FB_BRIDGE_DEBUG === 'true';

export function trace(scope: string, message: string | (() => string)): void {
  // A thunk so a line that has to ask the browser something — a page's URL, a
  // count — costs nothing at all while tracing is off, which is almost always.
  if (DEBUG) console.log(`[fb-bridge] ${scope}: ${typeof message === 'function' ? message() : message}`);
}
