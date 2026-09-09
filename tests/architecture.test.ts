import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

//const ROOT = new URL('..', import.meta.url).pathname;

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const read = async (file: string) => readFile(join(ROOT, file), 'utf8');

/**
 * Fitness functions.
 *
 * Every rule here is a claim `docs/ARCHITECTURE.md` already makes. They were all
 * true when written and two of them had quietly stopped being true — which is
 * the argument for testing an architecture rather than describing it.
 */
describe('packages/core is rules, with no I/O', () => {
  it('imports nothing but zod and node:crypto', async () => {
    const files = await sourceFiles('packages/core/src');
    const external = new Set<string>();

    for (const file of files) {
      const source = await read(file);
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) external.add(specifier);
      }
    }
    expect([...external].sort()).toEqual(['node:crypto', 'zod']);
  });

  it('cannot reach a database or the network, even without importing one', async () => {
    // WebhookAlertSink used to live in core. It had no revealing import — it
    // closed over the global `fetch` — so this checks the capability, not the
    // import, which is the only version of the rule that would have caught it.
    const banned = [
      { pattern: /\bfetch\s*\(/, why: 'makes an HTTP request' },
      { pattern: /\bnew\s+WebSocket\b/, why: 'opens a socket' },
      { pattern: /\bprocess\.env\b/, why: 'reads ambient configuration' },
    ];

    for (const file of await sourceFiles('packages/core/src')) {
      // env.ts is the one place configuration is read, deliberately and once.
      if (file.endsWith('env.ts')) continue;
      const source = await read(file);
      for (const { pattern, why } of banned) {
        expect(pattern.test(source), `${relative('', file)} ${why}`).toBe(false);
      }
    }
  });

  it('does not depend on the database package', async () => {
    for (const file of await sourceFiles('packages/core/src')) {
      expect(await read(file)).not.toContain('@kirana/db');
    }
  });
});

describe('packages/db does not depend on the applications', () => {
  it('never imports from apps/', async () => {
    for (const file of await sourceFiles('packages/db/src')) {
      const source = await read(file);
      expect(source).not.toMatch(/from '[^']*apps\//);
      expect(source).not.toContain('@kirana/api');
      expect(source).not.toContain('@kirana/worker');
    }
  });
});

describe('the cross-tenant escape hatch stays small', () => {
  /**
   * `withoutTenant` is a hole in the isolation model. It is allowed in exactly
   * these places, each of which runs before a tenant context can exist. Adding
   * a file here is a deliberate act that shows up in review — which is the
   * point, because the list silently grew from three to twenty-three once.
   */
  const ALLOWED = [
    'packages/db/src/platform.ts',      // the sanctioned cross-tenant primitives
    'packages/db/src/provision.ts',     // creating the tenant row itself
    'apps/api/src/routes/webhooks.ts',  // spooling before the tenant is known
    'apps/api/src/routes/checkout.ts',  // a public capability URL
    'apps/worker/src/processors/inboundNormalise.ts', // spool → channel → tenant
  ];

  it('is called only from the files that are allowed to', async () => {
    const files = [
      ...await sourceFiles('packages/db/src'),
      ...await sourceFiles('packages/core/src'),
      ...await sourceFiles('apps/api/src'),
      ...await sourceFiles('apps/worker/src'),
    ];

    // The file that declares it is excluded by path rather than by hoping the
    // regex misses `withoutTenant<T>(` — a rule that depends on a generic
    // parameter staying put is not a rule.
    const DEFINITION = 'packages/db/src/tenant.ts';

    const callers: string[] = [];
    for (const file of files) {
      if (file === DEFINITION) continue;
      const source = await read(file);
      if (/withoutTenant\s*[<(]/.test(source)) callers.push(file);
    }
    expect(callers.sort()).toEqual([...ALLOWED].sort());
  });

  it('always states a reason at the call site', async () => {
    for (const file of await sourceFiles('apps')) {
      const source = await read(file);
      for (const call of source.matchAll(/withoutTenant\(\s*[\w.]+\s*,\s*([^,]+),/g)) {
        // A literal, not a variable: the reason has to be readable in the diff.
        expect(call[1]!.trim()).toMatch(/^['"].{10,}['"]$/);
      }
    }
  });
});

describe('the console never reaches past the API', () => {
  it('does not import the database or the worker', async () => {
    for (const file of await sourceFiles('apps/console')) {
      if (file.includes('.next')) continue;
      const source = await read(file);
      expect(source).not.toContain('@kirana/db');
      expect(source).not.toMatch(/from '[^']*apps\/worker/);
    }
  });
});

describe('migrations are forward-only', () => {
  it('numbers them uniquely and in order', async () => {
    const files = (await readdir(join(ROOT, 'packages/db/migrations')))
      .filter((f) => f.endsWith('.sql')).sort();
    const numbers = files.map((f) => Number(f.slice(0, 4)));

    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    for (const file of files) expect(file).toMatch(/^\d{4}_[a-z_]+\.sql$/);
  });

  it('enables row-level security on every table it creates that has a tenant', async () => {
    const dir = join(ROOT, 'packages/db/migrations');
    const sql = (await Promise.all(
      (await readdir(dir)).filter((f) => f.endsWith('.sql'))
        .map((f) => readFile(join(dir, f), 'utf8')),
    )).join('\n');

    // Every table with a tenant_id column must appear in an RLS enable statement
    // somewhere. The database is the isolation boundary; a table outside it is a
    // leak waiting for a query.
    const tenantTables = new Set<string>();
    for (const match of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
      if (/\btenant_id\s+uuid/.test(match[2]!)) tenantTables.add(match[1]!);
    }
    expect(tenantTables.size).toBeGreaterThan(15);

    for (const table of tenantTables) {
      const enabled = sql.includes(`alter table ${table} enable row level security`)
        || new RegExp(`'${table}'`).test(sql); // named in a DO block's table list
      expect(enabled, `${table} has tenant_id but no row-level security`).toBe(true);
    }
  });
});
