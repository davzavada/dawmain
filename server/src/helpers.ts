import type { Person } from '@crm/shared';
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

/** Normalizes a DOI for matching: lowercased, without a doi.org URL prefix. */
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}
