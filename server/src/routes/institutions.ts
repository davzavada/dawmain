import type { FastifyInstance } from 'fastify';
import {
  institutionInput,
  institutionPatch,
  type Institution,
  type InstitutionDetail,
  type InstitutionPerson,
} from '@crm/shared';
import { db } from '../db.js';
import { NotFoundError } from '../errors.js';
import { idParam, likeClause, queryText } from '../helpers.js';

const INSTITUTION_FIELDS = [
  'name',
  'short_name',
  'city',
  'country',
  'url',
  'ror_id',
  'openalex_id',
  'note',
] as const;

function getInstitutionRow(id: number): Institution {
  const row = db.prepare('SELECT * FROM institutions WHERE id = ?').get(id) as unknown as
    | Institution
    | undefined;
  if (!row) throw new NotFoundError(`Institution ${id} not found`);
  return row;
}

export default function institutionRoutes(app: FastifyInstance): void {
  app.get('/api/institutions', async (req) => {
    const search = queryText(req.query, 'search');
    const params: (string | number | null)[] = [];
    let where = '1=1';
    if (search) {
      const clause = likeClause(['i.name', 'i.short_name', 'i.city'], search);
      where += ` AND ${clause.sql}`;
      params.push(...clause.params);
    }
    return db
      .prepare(
        `SELECT i.*,
                (SELECT COUNT(DISTINCT a.person_id) FROM affiliations a WHERE a.institution_id = i.id) AS person_count
         FROM institutions i WHERE ${where}
         ORDER BY i.name COLLATE NOCASE`,
      )
      .all(...params);
  });

  app.get('/api/institutions/:id', async (req): Promise<InstitutionDetail> => {
    const id = idParam(req.params);
    const institution = getInstitutionRow(id);
    const people = (
      db
        .prepare(
          `SELECT p.id, p.name, p.titles, a.role, a.start_date, a.end_date,
                  (a.end_date IS NULL) AS current
           FROM affiliations a JOIN people p ON p.id = a.person_id
           WHERE a.institution_id = ?
           ORDER BY (a.end_date IS NOT NULL), p.name COLLATE NOCASE`,
        )
        .all(id) as unknown as (Omit<InstitutionPerson, 'current'> & { current: number })[]
    ).map((p) => ({ ...p, current: p.current !== 0 }));
    return { institution, people };
  });

  app.post('/api/institutions', async (req) => {
    const body = institutionInput.parse(req.body);
    const info = db
      .prepare(
        `INSERT INTO institutions (name, short_name, city, country, url, ror_id, openalex_id, note)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        body.name.trim(),
        body.short_name ?? null,
        body.city ?? null,
        body.country ?? null,
        body.url ?? null,
        body.ror_id ?? null,
        body.openalex_id ?? null,
        body.note ?? null,
      );
    return getInstitutionRow(Number(info.lastInsertRowid));
  });

  app.patch('/api/institutions/:id', async (req) => {
    const id = idParam(req.params);
    const body = institutionPatch.parse(req.body);
    getInstitutionRow(id);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const field of INSTITUTION_FIELDS) {
      if (body[field] === undefined) continue;
      const value = body[field] ?? null;
      sets.push(`${field} = ?`);
      values.push(field === 'name' && typeof value === 'string' ? value.trim() : value);
    }
    if (sets.length > 0) {
      db.prepare(
        `UPDATE institutions SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ).run(...values, id);
    }
    return getInstitutionRow(id);
  });

  app.delete('/api/institutions/:id', async (req, reply) => {
    const id = idParam(req.params);
    const info = db.prepare('DELETE FROM institutions WHERE id = ?').run(id);
    if (info.changes === 0) throw new NotFoundError(`Institution ${id} not found`);
    return reply.code(204).send();
  });
}
