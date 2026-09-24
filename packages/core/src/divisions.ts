/**
 * Marketing / AI: the two divisions every tenant has.
 *
 * A division is a boundary *inside* a tenant — not a second tenant. "Workspace"
 * already names the tenant in this codebase (the login slug), so the nested
 * concept is a division. The API resolves the active one from a request
 * header, the database enforces it with row-level security, and the two share
 * users, billing and configuration while keeping their contacts, chats,
 * comments, deals and provider accounts apart.
 */
export const DIVISION_KEYS = ['marketing', 'ai'] as const;
export type DivisionKey = (typeof DIVISION_KEYS)[number];

/** What a request, a cookie or a bridge event means when it names no division. */
export const DEFAULT_DIVISION: DivisionKey = 'marketing';

export const DIVISION_NAMES: Readonly<Record<DivisionKey, string>> = { marketing: 'Marketing', ai: 'AI' };

/** The request header the console sends; absent means `DEFAULT_DIVISION`. */
export const DIVISION_HEADER = 'x-division';

export function isDivisionKey(value: unknown): value is DivisionKey {
  return typeof value === 'string' && (DIVISION_KEYS as readonly string[]).includes(value);
}

/**
 * The identity a browser-session bridge (fb-bridge, ig-bridge) files a
 * division's Chromium profile under — the mirror of `app_bridge_session_key`
 * in migration 0059, and the reason nothing on a bridge's disk had to move:
 * Marketing's key is the bare tenant id every existing profile is already
 * named after.
 */
export function bridgeSessionKey(tenantId: string, key: DivisionKey): string {
  return key === DEFAULT_DIVISION ? tenantId : `${tenantId}-${key}`;
}

const SESSION_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(marketing|ai))?$/i;

/** The inverse: a bridge event's session key back into tenant and division. */
export function parseBridgeSessionKey(sessionKey: string): { tenantId: string; key: DivisionKey } | null {
  const match = SESSION_KEY.exec(sessionKey);
  if (!match) return null;
  return { tenantId: match[1]!.toLowerCase(), key: (match[2]?.toLowerCase() as DivisionKey | undefined) ?? DEFAULT_DIVISION };
}
