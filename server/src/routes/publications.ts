import type { FastifyInstance } from 'fastify';
import {
  publicationInput,
  publicationPatch,
  suggestionDismissInput,
  suggestionLinkInput,
  suggestionPromoteInput,
  type PublicationListItem,
  type Suggestion,
} from '@crm/shared';
import { db, withTransaction, touchPublication } from '../db.js';
import { NotFoundError } from '../errors.js';
import { getPersonRow, idParam, placeholders } from '../helpers.js';
import { insertPerson } from './people.js';

const PUBLICATION_FIELDS = [
  'title',
  'year',
  'venue',
  'type',
  'doi',
  'url',
  'abstract',
  'language',
  'note',
] as const;

interface PublicationRow {
  id: number;
  title: string;
  year: number | null;
  venue: string | null;
  type: string;
  doi: string | null;
  url: string | null;
  abstract: string | null;
  language: string | null;
  note: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

function getPublicationRow(id: number): PublicationRow {
  const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(id) as unknown as
    | PublicationRow
    | undefined;
  if (!row) throw new NotFoundError(`Publication ${id} not found`);
  return row;
}

function authorsFor(publicationIds: number[]): Map<number, PublicationListItem['authors']> {
  const map = new Map<number, PublicationListItem['authors']>();
  if (publicationIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT publication_id, position, author_name, person_id
       FROM publication_authors
       WHERE publication_id IN (${placeholders(publicationIds.length)})
       ORDER BY publication_id, position`,
    )
    .all(...publicationIds) as unknown as {
    publication_id: number;
    position: number;
    author_name: string;
    person_id: number | null;
  }[];
  for (const row of rows) {
    const list = map.get(row.publication_id) ?? [];
    list.push({ position: row.position, name: row.author_name, person_id: row.person_id });
    map.set(row.publication_id, list);
  }
  return map;
}

function publicationDetail(id: number): PublicationRow & { authors: PublicationListItem['authors'] } {
  const row = getPublicationRow(id);
  return { ...row, authors: authorsFor([id]).get(id) ?? [] };
}

function replaceAuthors(
  publicationId: number,
  authors: { name: string; person_id?: number | null }[],
): void {
  db.prepare('DELETE FROM publication_authors WHERE publication_id = ?').run(publicationId);
  authors.forEach((author, index) => {
    db.prepare(
      `INSERT INTO publication_authors (publication_id, position, author_name, person_id)
       VALUES (?,?,?,?)`,
    ).run(publicationId, index + 1, author.name, author.person_id ?? null);
  });
}

export default function publicationRoutes(app: FastifyInstance): void {
  app.get('/api/publications', async (req) => {
    const { search = '', person_id = '' } = req.query as { search?: string; person_id?: string };
    const params: (string | number | null)[] = [];
    let where = '1=1';
    if (search.trim()) {
      where += ` AND (p.title LIKE '%' || ? || '%' COLLATE NOCASE OR p.venue LIKE '%' || ? || '%' COLLATE NOCASE)`;
      params.push(search.trim(), search.trim());
    }
    if (person_id.trim()) {
      where += ` AND EXISTS (SELECT 1 FROM publication_authors pa WHERE pa.publication_id = p.id AND pa.person_id = ?)`;
      params.push(Number(person_id));
    }
    const pubs = db
      .prepare(
        `SELECT p.id, p.title, p.year, p.venue, p.type, p.doi, p.url
         FROM publications p WHERE ${where}
         ORDER BY p.year IS NULL, p.year DESC, p.title COLLATE NOCASE`,
      )
      .all(...params) as unknown as Omit<PublicationListItem, 'authors'>[];
    const authors = authorsFor(pubs.map((p) => p.id));
    return pubs.map((p) => ({ ...p, authors: authors.get(p.id) ?? [] }));
  });

  app.post('/api/publications', async (req) => {
    const body = publicationInput.parse(req.body);
    const id = withTransaction(() => {
      const info = db
        .prepare(
          `INSERT INTO publications (title, year, venue, type, doi, url, abstract, language, note)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          body.title,
          body.year ?? null,
          body.venue ?? null,
          body.type ?? 'article',
          body.doi ?? null,
          body.url ?? null,
          body.abstract ?? null,
          body.language ?? null,
          body.note ?? null,
        );
      const publicationId = Number(info.lastInsertRowid);
      replaceAuthors(publicationId, body.authors);
      return publicationId;
    });
    return publicationDetail(id);
  });

  app.get('/api/publications/:id', async (req) => {
    return publicationDetail(idParam(req.params));
  });

  app.patch('/api/publications/:id', async (req) => {
    const id = idParam(req.params);
    getPublicationRow(id);
    const body = publicationPatch.parse(req.body);
    withTransaction(() => {
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      for (const field of PUBLICATION_FIELDS) {
        if (body[field] === undefined) continue;
        sets.push(`${field} = ?`);
        values.push(body[field] ?? null);
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE publications SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      }
      if (body.authors !== undefined) {
        replaceAuthors(id, body.authors);
      }
      touchPublication(id);
    });
    return publicationDetail(id);
  });

  app.delete('/api/publications/:id', async (req, reply) => {
    const id = idParam(req.params);
    const info = db.prepare('DELETE FROM publications WHERE id = ?').run(id);
    if (info.changes === 0) throw new NotFoundError(`Publication ${id} not found`);
    return reply.code(204).send();
  });

  // --- Suggestions: derived from unlinked authorship rows ---------------------

  app.get('/api/suggestions', async () => {
    const rows = db
      .prepare(
        `SELECT pa.author_name, pub.id AS publication_id, pub.title
         FROM publication_authors pa JOIN publications pub ON pub.id = pa.publication_id
         WHERE pa.person_id IS NULL
         ORDER BY pub.year IS NULL, pub.year DESC`,
      )
      .all() as unknown as { author_name: string; publication_id: number; title: string }[];
    const dismissed = new Set(
      (
        db.prepare('SELECT author_name FROM dismissed_suggestions').all() as unknown as {
          author_name: string;
        }[]
      ).map((r) => r.author_name.toLowerCase()),
    );
    const grouped = new Map<string, Suggestion>();
    for (const row of rows) {
      const key = row.author_name.toLowerCase();
      if (dismissed.has(key)) continue;
      const entry = grouped.get(key) ?? { name: row.author_name, count: 0, publications: [] };
      entry.count += 1;
      if (!entry.publications.some((p) => p.id === row.publication_id)) {
        entry.publications.push({ id: row.publication_id, title: row.title });
      }
      grouped.set(key, entry);
    }
    return [...grouped.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
  });

  app.post('/api/suggestions/promote', async (req) => {
    const body = suggestionPromoteInput.parse(req.body);
    return withTransaction(() => {
      const person = insertPerson({ ...body.person, name: body.person?.name ?? body.name });
      const info = db
        .prepare(
          `UPDATE publication_authors SET person_id = ?
           WHERE person_id IS NULL AND author_name = ? COLLATE NOCASE`,
        )
        .run(person.id, body.name);
      db.prepare('DELETE FROM dismissed_suggestions WHERE author_name = ? COLLATE NOCASE').run(
        body.name,
      );
      return { person, linked: Number(info.changes) };
    });
  });

  app.post('/api/suggestions/link', async (req) => {
    const body = suggestionLinkInput.parse(req.body);
    getPersonRow(body.person_id);
    const info = db
      .prepare(
        `UPDATE publication_authors SET person_id = ?
         WHERE person_id IS NULL AND author_name = ? COLLATE NOCASE`,
      )
      .run(body.person_id, body.name);
    return { linked: Number(info.changes) };
  });

  app.post('/api/suggestions/dismiss', async (req, reply) => {
    const body = suggestionDismissInput.parse(req.body);
    db.prepare(
      'INSERT OR REPLACE INTO dismissed_suggestions (author_name) VALUES (?)',
    ).run(body.name);
    return reply.code(204).send();
  });
}
