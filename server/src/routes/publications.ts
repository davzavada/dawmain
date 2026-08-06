import type { FastifyInstance } from 'fastify';
import {
  publicationInput,
  publicationPatch,
  suggestionDismissInput,
  suggestionLinkInput,
  suggestionPromoteInput,
  READ_STATUSES,
  type DismissedSuggestion,
  type PublicationDetail,
  type PublicationListItem,
  type Suggestion,
} from '@crm/shared';
import { db, withTransaction, touchPublication } from '../db.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import {
  getPersonRow,
  idParam,
  likeClause,
  normalizeDoi,
  placeholders,
  queryInt,
  queryText,
  touchPeople,
} from '../helpers.js';
import { insertPerson } from './people.js';

const PUBLICATION_TEXT_FIELDS = [
  'title',
  'year',
  'venue',
  'type',
  'doi',
  'url',
  'abstract',
  'language',
  'note',
  'read_status',
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
  starred: number;
  read_status: PublicationDetail['read_status'];
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

function publicationDetail(id: number): PublicationDetail {
  const row = getPublicationRow(id);
  return { ...row, starred: row.starred !== 0, authors: authorsFor([id]).get(id) ?? [] };
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
    ).run(publicationId, index + 1, author.name.trim(), author.person_id ?? null);
  });
}

/** Unlinked authorship rowids whose name matches (Unicode case-insensitive, like the inbox). */
function unlinkedRowIds(name: string): number[] {
  const target = name.trim().toLowerCase();
  const rows = db
    .prepare('SELECT rowid AS rid, author_name FROM publication_authors WHERE person_id IS NULL')
    .all() as unknown as { rid: number; author_name: string }[];
  return rows.filter((r) => r.author_name.toLowerCase() === target).map((r) => r.rid);
}

function linkRows(rowIds: number[], personId: number): number {
  if (rowIds.length === 0) return 0;
  const info = db
    .prepare(
      `UPDATE publication_authors SET person_id = ? WHERE rowid IN (${placeholders(rowIds.length)})`,
    )
    .run(personId, ...rowIds);
  return Number(info.changes);
}

/** Removes a dismissal matching the name under the same case rule as the inbox. */
function clearDismissal(name: string): void {
  const target = name.trim().toLowerCase();
  const rows = db.prepare('SELECT author_name FROM dismissed_suggestions').all() as unknown as {
    author_name: string;
  }[];
  for (const row of rows) {
    if (row.author_name.toLowerCase() === target) {
      db.prepare('DELETE FROM dismissed_suggestions WHERE author_name = ?').run(row.author_name);
    }
  }
}

export default function publicationRoutes(app: FastifyInstance): void {
  app.get('/api/publications', async (req) => {
    const search = queryText(req.query, 'search');
    const personId = queryInt(req.query, 'person_id');
    const starred = queryText(req.query, 'starred');
    const readStatus = queryText(req.query, 'read_status');
    const type = queryText(req.query, 'type');
    const params: (string | number | null)[] = [];
    let where = '1=1';
    if (search) {
      const text = likeClause(['p.title', 'p.venue'], search);
      const author = likeClause(['pa2.author_name'], search);
      where += ` AND (${text.sql} OR EXISTS (
        SELECT 1 FROM publication_authors pa2 WHERE pa2.publication_id = p.id AND ${author.sql}))`;
      params.push(...text.params, ...author.params);
    }
    if (personId !== undefined) {
      where += ` AND EXISTS (SELECT 1 FROM publication_authors pa WHERE pa.publication_id = p.id AND pa.person_id = ?)`;
      params.push(personId);
    }
    if (starred === '1' || starred === 'true') {
      where += ' AND p.starred = 1';
    }
    if (readStatus) {
      if (!(READ_STATUSES as readonly string[]).includes(readStatus)) {
        throw new BadRequestError(`Invalid read_status: ${readStatus}`);
      }
      where += ' AND p.read_status = ?';
      params.push(readStatus);
    }
    if (type) {
      where += ' AND p.type = ?';
      params.push(type);
    }
    const pubs = db
      .prepare(
        `SELECT p.id, p.title, p.year, p.venue, p.type, p.doi, p.url, p.note, p.starred, p.read_status
         FROM publications p WHERE ${where}
         ORDER BY p.year IS NULL, p.year DESC, p.title COLLATE NOCASE`,
      )
      .all(...params) as unknown as (Omit<PublicationListItem, 'authors' | 'starred'> & {
      starred: number;
    })[];
    const authors = authorsFor(pubs.map((p) => p.id));
    return pubs.map((p) => ({
      ...p,
      starred: p.starred !== 0,
      authors: authors.get(p.id) ?? [],
    }));
  });

  app.post('/api/publications', async (req) => {
    const body = publicationInput.parse(req.body);
    const id = withTransaction(() => {
      const info = db
        .prepare(
          `INSERT INTO publications (title, year, venue, type, doi, url, abstract, language, note, starred, read_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          body.title.trim(),
          body.year ?? null,
          body.venue ?? null,
          body.type ?? 'article',
          body.doi ? normalizeDoi(body.doi) : null,
          body.url ?? null,
          body.abstract ?? null,
          body.language ?? null,
          body.note ?? null,
          body.starred ? 1 : 0,
          body.read_status ?? 'none',
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
    const body = publicationPatch.parse(req.body);
    getPublicationRow(id);
    withTransaction(() => {
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      for (const field of PUBLICATION_TEXT_FIELDS) {
        if (body[field] === undefined) continue;
        sets.push(`${field} = ?`);
        const value = body[field] ?? null;
        values.push(field === 'doi' && typeof value === 'string' ? normalizeDoi(value) : value);
      }
      if (body.starred !== undefined) {
        sets.push('starred = ?');
        values.push(body.starred ? 1 : 0);
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
      if (!entry.publications.some((p) => p.id === row.publication_id)) {
        entry.publications.push({ id: row.publication_id, title: row.title });
      }
      entry.count = entry.publications.length;
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
      const linked = linkRows(unlinkedRowIds(body.name), person.id);
      clearDismissal(body.name);
      touchPeople([person.id]);
      return { person, linked };
    });
  });

  app.post('/api/suggestions/link', async (req) => {
    const body = suggestionLinkInput.parse(req.body);
    getPersonRow(body.person_id);
    return withTransaction(() => {
      const linked = linkRows(unlinkedRowIds(body.name), body.person_id);
      clearDismissal(body.name);
      touchPeople([body.person_id]);
      return { linked };
    });
  });

  app.post('/api/suggestions/dismiss', async (req, reply) => {
    const body = suggestionDismissInput.parse(req.body);
    db.prepare('INSERT OR REPLACE INTO dismissed_suggestions (author_name) VALUES (?)').run(
      body.name.trim(),
    );
    return reply.code(204).send();
  });

  app.get('/api/suggestions/dismissed', async (): Promise<DismissedSuggestion[]> => {
    return db
      .prepare('SELECT * FROM dismissed_suggestions ORDER BY dismissed_at DESC')
      .all() as unknown as DismissedSuggestion[];
  });

  app.delete('/api/suggestions/dismissed/:name', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    clearDismissal(name);
    return reply.code(204).send();
  });
}
