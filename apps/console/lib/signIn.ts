/**
 * Sign-in for a single-workspace deployment (dashboardmcn.my.id/crm).
 *
 * CONSOLE_WORKSPACE fixes the workspace: the field and the demo box leave the
 * sign-in page, since there is only one shop to sign in to. With
 * CONSOLE_LOGIN_DOMAIN set, a bare username resolves to an address on it —
 * `cecil` signs in as `cecil@mcnasia.biz` — so staff type a name, not an
 * email, while the API keeps identifying users by email.
 *
 * Both unset (the default), sign-in is exactly the multi-shop form it was.
 * Read at request time, so one build serves either setup.
 */
export const fixedWorkspace = () => process.env.CONSOLE_WORKSPACE?.trim() || '';

export function loginEmail(input: string): string {
  const value = input.trim();
  const domain = process.env.CONSOLE_LOGIN_DOMAIN?.trim();
  return value.includes('@') || !domain ? value : `${value}@${domain}`;
}
