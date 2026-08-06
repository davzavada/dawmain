import type { FastifyInstance } from 'fastify';
import {
  personInput,
  personPatch,
  tagsInput,
  affiliationInput,
  affiliationPatch,
  normalizeOrcid,
  type AffiliationWithInstitution,
  type Person,
  type PersonCoauthor,
  type PersonDetail,
  type PersonListItem,
  type PersonPatch,
  type PersonPublication,
  type PersonRelation,
} from '@crm/shared';
import { db, withTransaction } from '../db.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { getPersonRow, idParam, placeholders } from '../helpers.js';

const PERSON_FIELDS = [
  'name',
  'titles',
  'email',
  'website',
  'country',
  'note',
  'orcid',
  'openalex_id',
  'semantic_scholar_id',
] as const;

function cleanOrcid(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  const normalized = normalizeOrcid(value);
  if (!normalized) throw new BadRequestError(`Invalid ORCID iD: ${value}`);
  return normalized;
}

export function insertPerson(input: PersonPatch & { name: string }, source = 'manual'): Person {
  const info = db
    .prepare(
      `INSERT INTO people (name, titles, email, website, country, note, orcid, openalex_id, semantic_scholar_id, source)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.name,
      input.titles ?? null,
      input.email ?? null,
      input.website ?? null,
      input.country ?? null,
      input.note ?? null,
      cleanOrcid(input.orcid) ?? null,
      input.openalex_id ?? null,
      input.semantic_scholar_id ?? null,
      source,
    );
  return getPersonRow(Number(info.lastInsertRowid));
}

function tagsForPerson(personId: number): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM person_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.person_id = ? ORDER BY t.name COLLATE NOCASE`,
    )
    .all(personId) as unknown as { name: string }[];
  return rows.map((r) => r.name);
}

function affiliationsForPerson(personId: number): AffiliationWithInstitution[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.role, a.start_date, a.end_date, a.note,
              i.id AS institution_id, i.name AS institution_name, i.short_name AS institution_short_name
       FROM affiliations a JOIN institutions i ON i.id = a.institution_id
       WHERE a.person_id = ?
       ORDER BY (a.end_date IS NOT NULL), COALESCE(a.start_date, '') DESC, a.id`,
    )
    .all(personId) as unknown as {
    id: number;
    role: string | null;
    start_date: string | null;
    end_date: string | null;
    note: string | null;
    institution_id: number;
    institution_name: string;
    institution_short_name: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    start_date: r.start_date,
    end_date: r.end_date,
    note: r.note,
    institution: { id: r.institution_id, name: r.institution_name, short_name: r.institution_short_name },
  }));
}

function publicationsForPerson(personId: number): PersonPublication[] {
  const pubs = db
    .prepare(
      `SELECT pub.id, pub.title, pub.year, pub.venue, pub.type, pub.doi, pub.url, pa.position
       FROM publication_authors pa JOIN publications pub ON pub.id = pa.publication_id
       WHERE pa.person_id = ?
       ORDER BY pub.year IS NULL, pub.year DESC, pub.title COLLATE NOCASE`,
    )
    .all(personId) as unknown as (Omit<PersonPublication, 'coauthors'> & { position: number })[];
  if (pubs.length === 0) return [];
  const ids = pubs.map((p) => p.id);
  const coauthorRows = db
    .prepare(
      `SELECT publication_id, author_name, person_id FROM publication_authors
       WHERE publication_id IN (${placeholders(ids.length)})
         AND (person_id IS NULL OR person_id <> ?)
       ORDER BY position`,
    )
    .all(...ids, personId) as unknown as {
    publication_id: number;
    author_name: string;
    person_id: number | null;
  }[];
  const byPub = new Map<number, { name: string; person_id: number | null }[]>();
  for (const row of coauthorRows) {
    const list = byPub.get(row.publication_id) ?? [];
    list.push({ name: row.author_name, person_id: row.person_id });
    byPub.set(row.publication_id, list);
  }
  return pubs.map((p) => ({ ...p, coauthors: byPub.get(p.id) ?? [] }));
}

function relationsForPerson(personId: number): PersonRelation[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.type, r.date, r.note, 'out' AS direction, p.id AS other_id, p.name AS other_name
       FROM relations r JOIN people p ON p.id = r.to_person_id
       WHERE r.from_person_id = ?
       UNION ALL
       SELECT r.id, r.type, r.date, r.note, 'in' AS direction, p.id AS other_id, p.name AS other_name
       FROM relations r JOIN people p ON p.id = r.from_person_id
       WHERE r.to_person_id = ?
       ORDER BY other_name COLLATE NOCASE, type`,
    )
    .all(personId, personId) as unknown as {
    id: number;
    type: string;
    date: string | null;
    note: string | null;
    direction: 'out' | 'in';
    other_id: number;
    other_name: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    direction: r.direction,
    other: { id: r.other_id, name: r.other_name },
    date: r.date,
    note: r.note,
  }));
}

function coauthorsForPerson(personId: number): PersonCoauthor[] {
  return db
    .prepare(
      `SELECT other.person_id AS person_id, p.name AS name, COUNT(DISTINCT me.publication_id) AS shared_count
       FROM publication_authors me
       JOIN publication_authors other
         ON other.publication_id = me.publication_id
        AND other.person_id IS NOT NULL
        AND other.person_id <> me.person_id
       JOIN people p ON p.id = other.person_id
       WHERE me.person_id = ?
       GROUP BY other.person_id, p.name
       ORDER BY shared_count DESC, name COLLATE NOCASE`,
    )
    .all(personId) as unknown as PersonCoauthor[];
}

export function personDetail(personId: number): PersonDetail {
  const person = getPersonRow(personId);
  return {
    person,
    tags: tagsForPerson(personId),
    affiliations: affiliationsForPerson(personId),
    publications: publicationsForPerson(personId),
    relations: relationsForPerson(personId),
    coauthors: coauthorsForPerson(personId),
  };
}

export function resolveInstitution(input: {
  institution_id?: number;
  institution_name?: string;
  ror_id?: string | null;
}): number {
  if (input.institution_id !== undefined) {
    const row = db.prepare('SELECT id FROM institutions WHERE id = ?').get(input.institution_id) as
      | { id: number }
      | undefined;
    if (!row) throw new NotFoundError(`Institution ${input.institution_id} not found`);
    return row.id;
  }
  const name = input.institution_name!;
  if (input.ror_id) {
    const byRor = db.prepare('SELECT id FROM institutions WHERE ror_id = ?').get(input.ror_id) as
      | { id: number }
      | undefined;
    if (byRor) return byRor.id;
  }
  const existing = db
    .prepare('SELECT id FROM institutions WHERE name = ? COLLATE NOCASE')
    .get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare('INSERT INTO institutions (name, ror_id) VALUES (?, ?)')
    .run(name, input.ror_id ?? null);
  return Number(info.lastInsertRowid);
}

export function setPersonTags(personId: number, tags: string[]): string[] {
  getPersonRow(personId);
  withTransaction(() => {
    db.prepare('DELETE FROM person_tags WHERE person_id = ?').run(personId);
    for (const raw of tags) {
      const name = raw.trim();
      if (!name) continue;
      db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
      const tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name) as {
        id: number;
      };
      db.prepare('INSERT OR IGNORE INTO person_tags (person_id, tag_id) VALUES (?, ?)').run(
        personId,
        tag.id,
      );
    }
  });
  return tagsForPerson(personId);
}

export default function peopleRoutes(app: FastifyInstance): void {
  app.get('/api/people', async (req) => {
    const { search = '', tag = '' } = req.query as { search?: string; tag?: string };
    const params: (string | number | null)[] = [];
    let where = '1=1';
    if (search.trim()) {
      where += ` AND p.name LIKE '%' || ? || '%' COLLATE NOCASE`;
      params.push(search.trim());
    }
    if (tag.trim()) {
      where += ` AND p.id IN (SELECT pt.person_id FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ? COLLATE NOCASE)`;
      params.push(tag.trim());
    }
    const people = db
      .prepare(
        `SELECT p.id, p.name, p.titles, p.country, p.orcid,
                (SELECT COUNT(*) FROM publication_authors pa WHERE pa.person_id = p.id) AS publication_count,
                (SELECT COUNT(*) FROM relations r WHERE r.from_person_id = p.id OR r.to_person_id = p.id) AS relation_count
         FROM people p WHERE ${where}
         ORDER BY p.name COLLATE NOCASE`,
      )
      .all(...params) as unknown as (Omit<PersonListItem, 'tags' | 'affiliations'>)[];

    const tagRows = db
      .prepare(
        `SELECT pt.person_id, t.name FROM person_tags pt JOIN tags t ON t.id = pt.tag_id
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all() as unknown as { person_id: number; name: string }[];
    const tagsByPerson = new Map<number, string[]>();
    for (const row of tagRows) {
      const list = tagsByPerson.get(row.person_id) ?? [];
      list.push(row.name);
      tagsByPerson.set(row.person_id, list);
    }

    const affRows = db
      .prepare(
        `SELECT a.person_id, COALESCE(i.short_name, i.name) AS label
         FROM affiliations a JOIN institutions i ON i.id = a.institution_id
         WHERE a.end_date IS NULL
         ORDER BY a.id`,
      )
      .all() as unknown as { person_id: number; label: string }[];
    const affByPerson = new Map<number, string[]>();
    for (const row of affRows) {
      const list = affByPerson.get(row.person_id) ?? [];
      if (!list.includes(row.label)) list.push(row.label);
      affByPerson.set(row.person_id, list);
    }

    return people.map((p) => ({
      ...p,
      tags: tagsByPerson.get(p.id) ?? [],
      affiliations: (affByPerson.get(p.id) ?? []).join(', '),
    }));
  });

  app.post('/api/people', async (req) => {
    const body = personInput.parse(req.body);
    return insertPerson(body);
  });

  app.get('/api/people/:id', async (req) => {
    return personDetail(idParam(req.params));
  });

  app.patch('/api/people/:id', async (req) => {
    const id = idParam(req.params);
    getPersonRow(id);
    const body = personPatch.parse(req.body);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const field of PERSON_FIELDS) {
      const value = field === 'orcid' ? cleanOrcid(body.orcid) : body[field];
      if (value === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(value ?? null);
    }
    if (sets.length > 0) {
      db.prepare(
        `UPDATE people SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ).run(...values, id);
    }
    return getPersonRow(id);
  });

  app.delete('/api/people/:id', async (req, reply) => {
    const id = idParam(req.params);
    const info = db.prepare('DELETE FROM people WHERE id = ?').run(id);
    if (info.changes === 0) throw new NotFoundError(`Person ${id} not found`);
    return reply.code(204).send();
  });

  app.put('/api/people/:id/tags', async (req) => {
    const id = idParam(req.params);
    const body = tagsInput.parse(req.body);
    return setPersonTags(id, body.tags);
  });

  app.post('/api/people/:id/affiliations', async (req) => {
    const id = idParam(req.params);
    getPersonRow(id);
    const body = affiliationInput.parse(req.body);
    const institutionId = resolveInstitution(body);
    const info = db
      .prepare(
        `INSERT INTO affiliations (person_id, institution_id, role, start_date, end_date, note)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        id,
        institutionId,
        body.role ?? null,
        body.start_date ?? null,
        body.end_date ?? null,
        body.note ?? null,
      );
    const created = affiliationsForPerson(id).find(
      (a) => a.id === Number(info.lastInsertRowid),
    );
    return created;
  });

  app.patch('/api/affiliations/:id', async (req) => {
    const id = idParam(req.params);
    const existing = db.prepare('SELECT person_id FROM affiliations WHERE id = ?').get(id) as
      | { person_id: number }
      | undefined;
    if (!existing) throw new NotFoundError(`Affiliation ${id} not found`);
    const body = affiliationPatch.parse(req.body);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const field of ['role', 'start_date', 'end_date', 'note'] as const) {
      if (body[field] === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(body[field] ?? null);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE affiliations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return affiliationsForPerson(existing.person_id).find((a) => a.id === id);
  });

  app.delete('/api/affiliations/:id', async (req, reply) => {
    const id = idParam(req.params);
    const info = db.prepare('DELETE FROM affiliations WHERE id = ?').run(id);
    if (info.changes === 0) throw new NotFoundError(`Affiliation ${id} not found`);
    return reply.code(204).send();
  });

  app.get('/api/tags', async () => {
    return db.prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE').all();
  });
}
