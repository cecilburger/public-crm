/**
 * Static check for the one weakness ADR-0002 knowingly accepted.
 *
 * We write SQL by hand and declare each row type by hand. TypeScript cannot
 * compare them, so they drift — and they have, three times, each time silently
 * disabling whatever the new column controlled. This reads both sides and
 * compares them.
 *
 * It only catches the direction that actually hurts: a field declared on the row
 * type that the query never returns, which is `undefined` at runtime with no
 * error anywhere.
 */

export interface DriftFinding {
  file: string;
  field: string;
  projection: string;
}

/** Split a projection on top-level commas — `coalesce(a, b) as x` is one item. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function keywordAtTopLevel(sql: string, keyword: string): number {
  let depth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && new RegExp(`^${keyword}\\b`, 'i').test(sql.slice(i))) return i;
  }
  return -1;
}

function upToKeyword(body: string, stop: string): string | null {
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    // `extract(epoch from …)` has a FROM belonging to the function, not the query.
    else if (depth === 0 && /\s/.test(ch) && new RegExp(`^${stop}\\s`, 'i').test(body.slice(i + 1))) {
      return body.slice(0, i).trim();
    }
  }
  return null;
}

/**
 * What a statement actually returns: the SELECT list, or the RETURNING clause of
 * a write. Anything else — and a subquery's SELECT is "anything else" — is not
 * the projection.
 */
export function projectionOf(sql: string): string | null {
  const trimmed = sql.trim();
  if (/^select\b/i.test(trimmed)) return upToKeyword(trimmed.replace(/^select\b/i, ''), 'from');

  const returning = keywordAtTopLevel(trimmed, 'returning');
  if (returning === -1) return null;
  return trimmed.slice(returning + 'returning'.length).trim().replace(/;$/, '');
}

/** The name a projected item lands under: its alias, or its trailing identifier. */
export function columnName(item: string): string | null {
  const aliased = /\bas\s+"?([a-z_][a-z0-9_]*)"?\s*$/i.exec(item);
  if (aliased) return aliased[1]!.toLowerCase();
  const bare = /([a-z_][a-z0-9_]*)\s*$/i.exec(item.replace(/::[a-z_\[\]]+$/i, ''));
  return bare ? bare[1]!.toLowerCase() : null;
}

export interface AnalysisResult {
  findings: DriftFinding[];
  checked: number;
  skipped: number;
}

/** Find every `.query<{…}>(`…`)` in a file and compare the two halves. */
export function analyseSource(source: string, file = '<source>'): AnalysisResult {
  const findings: DriftFinding[] = [];
  let checked = 0;
  let skipped = 0;

  const calls = source.matchAll(/\.query<\{([^}]*)\}>\(\s*(`[\s\S]*?`|'[^']*')/g);
  for (const call of calls) {
    const fields = [...call[1]!.matchAll(/([a-z_][a-z0-9_]*)\s*:/gi)].map((f) => f[1]!.toLowerCase());
    const sql = call[2]!.slice(1, -1);
    const projection = projectionOf(sql);

    // `select *` returns whatever the table has; there is nothing to compare.
    if (!projection || fields.length === 0 || projection.includes('*')) { skipped += 1; continue; }

    const columns = new Set(splitTopLevel(projection).map(columnName).filter(Boolean));
    checked += 1;
    for (const field of fields) {
      if (!columns.has(field)) findings.push({ file, field, projection });
    }
  }
  return { findings, checked, skipped };
}
