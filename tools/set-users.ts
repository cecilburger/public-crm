/**
 * Creates or updates sign-in accounts on the dev stack's database, and can
 * lock everyone else out — for a test deployment whose demo password is
 * printed on the demo sign-in page.
 *
 *   CRM_WORKSPACE=toko-demo \
 *   CRM_LOGIN_DOMAIN=mcnasia.biz \
 *   CRM_USERS="cecil:owner:Cecil,fattah:admin:Fattah" \
 *   CRM_PASSWORD='…' \
 *   CRM_DISABLE_OTHERS=1 \
 *   npx tsx --env-file=.env tools/set-users.ts
 *
 * Usernames become `<name>@CRM_LOGIN_DOMAIN` — the console, given the same
 * domain as CONSOLE_LOGIN_DOMAIN, signs a bare `cecil` in as that address.
 * The password comes from the environment only, so it never lands in the
 * repo or the shell's argument list. Re-running is safe: existing accounts
 * get the new password and role, and are re-enabled.
 */
import path from 'node:path';
import { connectPostgres, withTenant, withoutTenant, addUser } from '@kirana/db';
import { hashPassword } from '@kirana/core';
import { startLocalPostgres } from './local-postgres.ts';

const ROLES = ['owner', 'admin', 'supervisor', 'agent', 'viewer'] as const;
type Role = (typeof ROLES)[number];

const need = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) { console.error(`Set ${name}.`); process.exit(1); }
  return value;
};
const workspace = need('CRM_WORKSPACE');
const domain = need('CRM_LOGIN_DOMAIN');
const password = need('CRM_PASSWORD');
if (password.length < 8) { console.error('CRM_PASSWORD must be at least 8 characters.'); process.exit(1); }

const users = need('CRM_USERS').split(',').map((spec) => {
  const [username, role, ...name] = spec.trim().split(':');
  if (!username || !ROLES.includes(role as Role)) {
    console.error(`Bad entry "${spec}" — expected username:role:Name, role one of ${ROLES.join('/')}.`);
    process.exit(1);
  }
  return { email: `${username}@${domain}`.toLowerCase(), role: role as Role, name: name.join(':') || username };
});

const pg = await startLocalPostgres(path.join(import.meta.dirname, '..'));
const db = await connectPostgres(pg.url, { max: 2, assumeRole: true });
try {
  const [tenant] = await withoutTenant(db, 'set-users: resolving the workspace', (tx) =>
    tx.query<{ id: string }>('select id from tenants where slug = $1', [workspace]));
  if (!tenant) throw new Error(`No workspace "${workspace}"`);

  for (const u of users) {
    const updated = await withTenant(db, tenant.id, (tx) => tx.query<{ id: string }>(
      `update users set password_hash = $3, role = $4, name = $5, status = 'active'
        where tenant_id = $1 and lower(email) = $2 returning id`,
      [tenant.id, u.email, hashPassword(password), u.role, u.name]));
    if (!updated[0]) await addUser(db, tenant.id, { email: u.email, name: u.name, password, role: u.role });
    console.log(`${updated[0] ? 'updated' : 'created'}  ${u.email}  (${u.role})`);
  }

  if (process.env.CRM_DISABLE_OTHERS === '1') {
    const disabled = await withTenant(db, tenant.id, (tx) => tx.query<{ email: string }>(
      `update users set status = 'disabled'
        where tenant_id = $1 and status <> 'disabled' and not (lower(email) = any($2::text[]))
        returning email`,
      [tenant.id, users.map((u) => u.email)]));
    for (const d of disabled) console.log(`disabled ${d.email}`);
  }
} finally {
  await db.close();
  await pg.stop();
}
