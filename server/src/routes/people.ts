import type { FastifyInstance } from 'fastify';
import {
  personInput,
  personPatch,
  tagsInput,
  affiliationInput,
  affiliationPatch,
  mergeInput,
  type AffiliationWithInstitution,
  type Interaction,
  type MergeCounts,
  type Person,
  type PersonCoauthor,
  type PersonDetail,
  type PersonListItem,
  type PersonPatch,
  type PersonPublication,
  type PersonRelation,
  type TagWithCount,
} from '@crm/shared';
import { db, withTransaction } from '../db.js';
import { ConflictError, NotFoundError } from '../errors.js';
import {
  cleanOrcid,
  getPersonRow,
  idParam,
  likeClause,
  placeholders,
  queryText,
  touchPeople,
} from '../helpers.js';

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

export function insertPerson(input: PersonPatch & { name: string }, source = 'manual'): Person {
  const info = db
    .prepare(
      `INSERT INTO people (name, titles, email, website, country, note, orcid, openalex_id, semantic_scholar_id, source)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.name.trim(),
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

interface AffiliationRow {
  id: number;
  person_id: number;
  role: string | null;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
  institution_id: number;
  institution_name: string;
  institution_short_name: string | null;
}

const AFFILIATION_SELECT = `
  SELECT a.id, a.person_id, a.role, a.start_date, a.end_date, a.note,
         i.id AS institution_id, i.name AS institution_name, i.short_name AS institution_short_name
  FROM affiliations a JOIN institutions i ON i.id = a.institution_id`;

function shapeAffiliation(r: AffiliationRow): AffiliationWithInstitution {
  return {
    id: r.id,
    role: r.role,
    start_date: r.start_date,
    end_date: r.end_date,
    note: r.note,
    institution: {
      id: r.institution_id,
      name: r.institution_name,
      short_name: r.institution_short_name,
    },
  };
}

function getAffiliation(id: number): AffiliationWithInstitution & { person_id: number } {
  const row = db.prepare(`${AFFILIATION_SELECT} WHERE a.id = ?`).get(id) as unknown as
    | AffiliationRow
    | undefined;
  if (!row) throw new NotFoundError(`Affiliation ${id} not found`);
  return { ...shapeAffiliation(row), person_id: row.person_id };
}

function affiliationsForPerson(personId: number): AffiliationWithInstitution[] {
  const rows = db
    .prepare(
      `${AFFILIATION_SELECT}
       WHERE a.person_id = ?
       ORDER BY (a.end_date IS NOT NULL), COALESCE(a.start_date, '') DESC, a.id`,
    )
    .all(personId) as unknown as AffiliationRow[];
  return rows.map(shapeAffiliation);
}

function interactionsForPerson(personId: number): Interaction[] {
  return db
    .prepare(
      `SELECT * FROM interactions WHERE person_id = ?
       ORDER BY date DESC, id DESC`,
    )
    .all(personId) as unknown as Interaction[];
}

function publicationsForPerson(personId: number): PersonPublication[] {
  const pubs = db
    .prepare(
      `SELECT pub.id, pub.title, pub.year, pub.venue, pub.type, pub.doi, pub.url,
              pub.starred, pa.position
       FROM publication_authors pa JOIN publications pub ON pub.id = pa.publication_id
       WHERE pa.person_id = ?
       ORDER BY pub.year IS NULL, pub.year DESC, pub.title COLLATE NOCASE`,
    )
    .all(personId) as unknown as (Omit<PersonPublication, 'coauthors' | 'starred'> & {
    starred: number;
    position: number;
  })[];
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
  return pubs.map((p) => ({
    ...p,
    starred: p.starred !== 0,
    coauthors: byPub.get(p.id) ?? [],
  }));
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
    interactions: interactionsForPerson(personId),
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
  const name = input.institution_name!.trim();
  if (input.ror_id) {
    const byRor = db.prepare('SELECT id FROM institutions WHERE ror_id = ?').get(input.ror_id) as
      | { id: number }
      | undefined;
    if (byRor) return byRor.id;
  }
  const existing = db
    .prepare('SELECT id, ror_id FROM institutions WHERE name = ? COLLATE NOCASE')
    .get(name) as { id: number; ror_id: string | null } | undefined;
  if (existing) {
    if (input.ror_id && !existing.ror_id) {
      db.prepare('UPDATE institutions SET ror_id = ? WHERE id = ?').run(input.ror_id, existing.id);
    }
    return existing.id;
  }
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
    // prune tags no one holds so the filter dropdown stays honest
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM person_tags)').run();
    touchPeople([personId]);
  });
  return tagsForPerson(personId);
}

/** Merges loser into winner: repoints all references, fills blank fields, deletes loser. */
function mergePeople(loserId: number, winnerId: number): MergeCounts {
  const loser = getPersonRow(loserId);
  const winner = getPersonRow(winnerId);
  const counts: MergeCounts = {
    publications: 0,
    affiliations: 0,
    relations: 0,
    interactions: 0,
    tags: 0,
    fields: 0,
  };

  // Authorships: repoint, but where the winner already appears on the same
  // publication (duplicate-person case) the loser's row is redundant credit.
  const authorships = db
    .prepare('SELECT publication_id, position FROM publication_authors WHERE person_id = ?')
    .all(loserId) as unknown as { publication_id: number; position: number }[];
  for (const row of authorships) {
    const already = db
      .prepare('SELECT 1 AS x FROM publication_authors WHERE publication_id = ? AND person_id = ?')
      .get(row.publication_id, winnerId);
    if (already) {
      db.prepare(
        'DELETE FROM publication_authors WHERE publication_id = ? AND position = ?',
      ).run(row.publication_id, row.position);
    } else {
      db.prepare(
        'UPDATE publication_authors SET person_id = ? WHERE publication_id = ? AND position = ?',
      ).run(winnerId, row.publication_id, row.position);
      counts.publications += 1;
    }
  }

  // Affiliations: repoint unless an identical one exists on the winner.
  const affs = db
    .prepare('SELECT id, institution_id, role, start_date FROM affiliations WHERE person_id = ?')
    .all(loserId) as unknown as {
    id: number;
    institution_id: number;
    role: string | null;
    start_date: string | null;
  }[];
  for (const aff of affs) {
    const duplicate = db
      .prepare(
        `SELECT id FROM affiliations
         WHERE person_id = ? AND institution_id = ?
           AND COALESCE(role, '') = COALESCE(?, '')
           AND COALESCE(start_date, '') = COALESCE(?, '')`,
      )
      .get(winnerId, aff.institution_id, aff.role, aff.start_date);
    if (duplicate) {
      db.prepare('DELETE FROM affiliations WHERE id = ?').run(aff.id);
    } else {
      db.prepare('UPDATE affiliations SET person_id = ? WHERE id = ?').run(winnerId, aff.id);
      counts.affiliations += 1;
    }
  }

  // Relations: edges between the two would become self-relations — drop them,
  // then repoint (skipping exact duplicates), then clean up leftovers and
  // symmetric-type reverse duplicates.
  db.prepare(
    `DELETE FROM relations
     WHERE (from_person_id = ? AND to_person_id = ?) OR (from_person_id = ? AND to_person_id = ?)`,
  ).run(loserId, winnerId, winnerId, loserId);
  const movedFrom = db
    .prepare('UPDATE OR IGNORE relations SET from_person_id = ? WHERE from_person_id = ?')
    .run(winnerId, loserId);
  const movedTo = db
    .prepare('UPDATE OR IGNORE relations SET to_person_id = ? WHERE to_person_id = ?')
    .run(winnerId, loserId);
  counts.relations = Number(movedFrom.changes) + Number(movedTo.changes);
  db.prepare('DELETE FROM relations WHERE from_person_id = ? OR to_person_id = ?').run(
    loserId,
    loserId,
  );
  const winnerRelations = db
    .prepare('SELECT id, from_person_id, to_person_id, type FROM relations WHERE from_person_id = ? OR to_person_id = ?')
    .all(winnerId, winnerId) as unknown as {
    id: number;
    from_person_id: number;
    to_person_id: number;
    type: string;
  }[];
  const seen = new Set<string>();
  for (const rel of winnerRelations) {
    const [a, b] = [rel.from_person_id, rel.to_person_id].sort((x, y) => x - y);
    const key = `${a}|${b}|${rel.type}`;
    if (seen.has(key)) {
      db.prepare('DELETE FROM relations WHERE id = ?').run(rel.id);
    } else {
      seen.add(key);
    }
  }

  const movedInteractions = db
    .prepare('UPDATE interactions SET person_id = ? WHERE person_id = ?')
    .run(winnerId, loserId);
  counts.interactions = Number(movedInteractions.changes);

  const movedTags = db
    .prepare(
      `INSERT OR IGNORE INTO person_tags (person_id, tag_id)
       SELECT ?, tag_id FROM person_tags WHERE person_id = ?`,
    )
    .run(winnerId, loserId);
  counts.tags = Number(movedTags.changes);

  for (const field of PERSON_FIELDS) {
    if (field === 'name') continue;
    const loserValue = loser[field];
    if (loserValue === null || loserValue === '') continue;
    if (winner[field] === null || winner[field] === '') {
      db.prepare(`UPDATE people SET ${field} = ? WHERE id = ?`).run(loserValue, winnerId);
      counts.fields += 1;
    }
  }

  db.prepare('DELETE FROM people WHERE id = ?').run(loserId);
  touchPeople([winnerId]);
  return counts;
}

export default function peopleRoutes(app: FastifyInstance): void {
  app.get('/api/people', async (req) => {
    const search = queryText(req.query, 'search');
    const tag = queryText(req.query, 'tag');
    const sort = queryText(req.query, 'sort');
    const params: (string | number | null)[] = [];
    let where = '1=1';
    if (search) {
      const person = likeClause(['p.name', 'p.titles', 'p.email', 'p.note'], search);
      const inst = likeClause(['i.name', 'i.short_name'], search);
      where += ` AND (${person.sql} OR EXISTS (
        SELECT 1 FROM affiliations a JOIN institutions i ON i.id = a.institution_id
        WHERE a.person_id = p.id AND ${inst.sql}))`;
      params.push(...person.params, ...inst.params);
    }
    if (tag) {
      where += ` AND p.id IN (SELECT pt.person_id FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ? COLLATE NOCASE)`;
      params.push(tag);
    }
    const orderBy =
      sort === 'recent'
        ? '(last_contact IS NULL), last_contact DESC, p.name COLLATE NOCASE'
        : sort === 'stale'
          ? '(last_contact IS NOT NULL), last_contact ASC, p.name COLLATE NOCASE'
          : 'p.name COLLATE NOCASE';
    const people = db
      .prepare(
        `SELECT p.id, p.name, p.titles, p.country, p.orcid,
                (SELECT COUNT(DISTINCT pa.publication_id) FROM publication_authors pa WHERE pa.person_id = p.id) AS publication_count,
                (SELECT COUNT(*) FROM relations r WHERE r.from_person_id = p.id OR r.to_person_id = p.id) AS relation_count,
                (SELECT MAX(i2.date) FROM interactions i2 WHERE i2.person_id = p.id) AS last_contact
         FROM people p WHERE ${where}
         ORDER BY ${orderBy}`,
      )
      .all(...params) as unknown as Omit<PersonListItem, 'tags' | 'affiliations'>[];

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

    const currentAffs = db
      .prepare(
        `SELECT a.person_id, COALESCE(i.short_name, i.name) AS label
         FROM affiliations a JOIN institutions i ON i.id = a.institution_id
         WHERE a.end_date IS NULL ORDER BY a.id`,
      )
      .all() as unknown as { person_id: number; label: string }[];
    const affByPerson = new Map<number, string[]>();
    for (const row of currentAffs) {
      const list = affByPerson.get(row.person_id) ?? [];
      if (!list.includes(row.label)) list.push(row.label);
      affByPerson.set(row.person_id, list);
    }
    // people whose affiliations all ended still get their latest one, marked
    const formerAffs = db
      .prepare(
        `SELECT a.person_id, COALESCE(i.short_name, i.name) AS label, MAX(COALESCE(a.end_date, '')) AS ended
         FROM affiliations a JOIN institutions i ON i.id = a.institution_id
         WHERE a.end_date IS NOT NULL GROUP BY a.person_id`,
      )
      .all() as unknown as { person_id: number; label: string }[];
    for (const row of formerAffs) {
      if (!affByPerson.has(row.person_id)) {
        affByPerson.set(row.person_id, [`${row.label} · former`]);
      }
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
    const body = personPatch.parse(req.body);
    getPersonRow(id);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const field of PERSON_FIELDS) {
      const value = field === 'orcid' ? cleanOrcid(body.orcid) : body[field];
      if (value === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(field === 'name' && typeof value === 'string' ? value.trim() : (value ?? null));
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
    const person = getPersonRow(id);
    withTransaction(() => {
      db.prepare('DELETE FROM people WHERE id = ?').run(id);
      // their authorship rows keep the raw name (ON DELETE SET NULL) and would
      // resurface in the suggestions inbox — dismiss deliberately (undoable)
      db.prepare('INSERT OR IGNORE INTO dismissed_suggestions (author_name) VALUES (?)').run(
        person.name,
      );
    });
    return reply.code(204).send();
  });

  app.post('/api/people/:id/merge', async (req) => {
    const loserId = idParam(req.params);
    const body = mergeInput.parse(req.body);
    if (loserId === body.into_id) {
      throw new ConflictError('Cannot merge a person into themselves');
    }
    const moved = withTransaction(() => mergePeople(loserId, body.into_id));
    return { detail: personDetail(body.into_id), moved };
  });

  app.put('/api/people/:id/tags', async (req) => {
    const id = idParam(req.params);
    const body = tagsInput.parse(req.body);
    return setPersonTags(id, body.tags);
  });

  app.post('/api/people/:id/affiliations', async (req) => {
    const id = idParam(req.params);
    const body = affiliationInput.parse(req.body);
    getPersonRow(id);
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
    touchPeople([id]);
    return getAffiliation(Number(info.lastInsertRowid));
  });

  app.patch('/api/affiliations/:id', async (req) => {
    const id = idParam(req.params);
    const body = affiliationPatch.parse(req.body);
    const existing = getAffiliation(id);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const field of ['role', 'start_date', 'end_date', 'note'] as const) {
      if (body[field] === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(body[field] ?? null);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE affiliations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      touchPeople([existing.person_id]);
    }
    return getAffiliation(id);
  });

  app.delete('/api/affiliations/:id', async (req, reply) => {
    const id = idParam(req.params);
    const existing = getAffiliation(id);
    db.prepare('DELETE FROM affiliations WHERE id = ?').run(id);
    touchPeople([existing.person_id]);
    return reply.code(204).send();
  });

  app.get('/api/tags', async (): Promise<TagWithCount[]> => {
    return db
      .prepare(
        `SELECT t.id, t.name, t.color, COUNT(pt.person_id) AS person_count
         FROM tags t LEFT JOIN person_tags pt ON pt.tag_id = t.id
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
      )
      .all() as unknown as TagWithCount[];
  });
}
