import { normalizeOrcid, type Person } from '@crm/shared';
import { db } from './db.js';
import { BadRequestError, NotFoundError } from './errors.js';

export function idParam(params: unknown, key = 'id'): number {
  const raw = (params as Record<string, string>)[key];
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError(`Invalid ${key}: ${raw}`);
  }
  return id;
}

/** First value of a query-string param (repeated params arrive as arrays), trimmed. */
export function queryText(query: unknown, key: string): string {
  const value = (query as Record<string, unknown>)[key];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

/** Positive-integer query param; absent/empty → undefined, garbage → 400. */
export function queryInt(query: unknown, key: string): number | undefined {
  const raw = queryText(query, key);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestError(`Invalid ${key}: ${raw}`);
  }
  return value;
}

/**
 * Substring-match clause over the given columns. The term is lowercased in JS
 * (Unicode-aware, so an uppercase diacritic query still matches) and LIKE
 * wildcards in user input are escaped.
 */
export function likeClause(columns: string[], term: string): { sql: string; params: string[] } {
  const escaped = term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  return {
    sql: `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    params: columns.map(() => pattern),
  };
}

export function getPersonRow(id: number): Person {
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id) as unknown as
    | Person
    | undefined;
  if (!row) throw new NotFoundError(`Person ${id} not found`);
  return row;
}

/** "?,?,?" for parameterized IN (...) clauses. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/** Normalizes a DOI for storage and matching: lowercased, no doi.org URL prefix. */
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

/** null/empty → null; anything else must be a valid ORCID iD (URL form accepted). */
export function cleanOrcid(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const normalized = normalizeOrcid(value);
  if (!normalized) throw new BadRequestError(`Invalid ORCID iD: ${value}`);
  return normalized;
}

export function touchPeople(ids: (number | undefined)[]): void {
  for (const id of ids) {
    if (id !== undefined) {
      db.prepare(`UPDATE people SET updated_at = datetime('now') WHERE id = ?`).run(id);
    }
  }
}
