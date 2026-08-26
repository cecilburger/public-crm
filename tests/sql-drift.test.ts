import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { analyseSource, projectionOf, columnName } from './helpers/sql-drift.ts';

const ROOT = new URL('..', import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the checker itself', () => {
  it('would have caught the bug that got through three times', () => {
    // The real shape: a column added to the row type and to the schema, but not
    // to the SELECT. At runtime the field is undefined and the feature it
    // controls is silently off — no error, no test failure, until someone looks.
    const regression = `
      const rows = await tx.query<{ mode: string; max_replies_per_hour: number }>(
        \`select mode, min_confidence from autopilot_settings where tenant_id = $1\`,
        [tenantId],
      );`;
    const result = analyseSource(regression, 'autopilotDraft.ts');
    expect(result.findings.map((f) => f.field)).toEqual(['max_replies_per_hour']);
  });

  it('is not fooled by a FROM that belongs to a function', () => {
    const sql = `select extract(epoch from (now() - min(received_at)))::int as oldest
                   from webhook_events where status = 'received'`;
    expect(projectionOf(sql)).toContain('as oldest');
    expect(analyseSource(`tx.query<{ oldest: number }>(\`${sql}\`)`).findings).toEqual([]);
  });

  it('is not fooled by the inner SELECT of a subquery in an UPDATE', () => {
    const sql = `update messages set body_enc = null
                   where conversation_id in (select id from conversations where tenant_id = $1)
                 returning 1 as n`;
    expect(projectionOf(sql)).toBe('1 as n');
    expect(analyseSource(`tx.query<{ n: number }>(\`${sql}\`)`).findings).toEqual([]);
  });

  it('reads aliases, casts and qualified names the way Postgres does', () => {
    expect(columnName('ct.display_name as contact_name')).toBe('contact_name');
    expect(columnName('count(*)::int as n')).toBe('n');
    expect(columnName('d.amount_micros / 1000000 as amount_idr')).toBe('amount_idr');
    expect(columnName('c.assignee_id')).toBe('assignee_id');
    expect(columnName('coalesce(provider_ts, created_at) as at')).toBe('at');
  });

  it('skips a select * rather than guessing at it', () => {
    const result = analyseSource("tx.query<{ anything: string }>('select * from contacts')");
    expect(result.findings).toEqual([]);
    expect(result.skipped).toBe(1);
  });
});

describe('the codebase', () => {
  it('has no row type declaring a column its query does not return', async () => {
    const files = [
      ...await sourceFiles('packages/db/src'),
      ...await sourceFiles('apps/api/src'),
      ...await sourceFiles('apps/worker/src'),
    ];

    const findings = [];
    let checked = 0;
    let skipped = 0;

    for (const file of files) {
      const result = analyseSource(await readFile(join(ROOT, file), 'utf8'), file);
      findings.push(...result.findings);
      checked += result.checked;
      skipped += result.skipped;
    }

    expect(findings.map((f) => `${f.file}: declares "${f.field}" but the query does not return it`))
      .toEqual([]);

    // A floor, so the check cannot quietly stop checking anything. If a refactor
    // drops coverage below this, that is a finding in itself.
    expect(checked).toBeGreaterThanOrEqual(100);
    expect(skipped / (checked + skipped)).toBeLessThan(0.2);
  });
});
