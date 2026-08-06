import type { FastifyInstance } from 'fastify';
import {
  fromOrcidInput,
  orcidImportInput,
  type OrcidImportInput,
  type Person,
} from '@crm/shared';
import { db, withTransaction, touchPerson } from '../db.js';
import { ConflictError } from '../errors.js';
import { cleanOrcid, getPersonRow, idParam, normalizeDoi } from '../helpers.js';
import { orcidPreview, requireOrcid } from '../enrichment/orcid.js';
import { insertPerson, personDetail, resolveInstitution } from './people.js';

const FILLABLE_FIELDS = [
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

interface ImportCounts {
  fields: number;
  affiliations: number;
  publications: number;
}

/**
 * Applies a user-selected subset of an ORCID preview to a person. Fields fill
 * blanks only (unless overwrite), affiliations and publications are matched
 * against existing rows so re-imports don't duplicate.
 */
function applyOrcidImport(personId: number, input: OrcidImportInput): ImportCounts {
  const counts: ImportCounts = { fields: 0, affiliations: 0, publications: 0 };
  const person = getPersonRow(personId);

  if (input.fields) {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const field of FILLABLE_FIELDS) {
      const value = field === 'orcid' ? cleanOrcid(input.fields.orcid) : input.fields[field];
      if (value === undefined || value === null || value === '') continue;
      const current = person[field];
      if (!input.overwrite && current !== null && current !== '') continue;
      sets.push(`${field} = ?`);
      values.push(value);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...values, personId);
      counts.fields = sets.length;
    }
  }

  for (const aff of input.affiliations ?? []) {
    const institutionId = resolveInstitution({
      institution_name: aff.institution_name,
      ror_id: aff.ror_id ?? null,
    });
    const duplicate = db
      .prepare(
        `SELECT id FROM affiliations
         WHERE person_id = ? AND institution_id = ?
           AND COALESCE(role, '') = COALESCE(?, '')
           AND COALESCE(start_date, '') = COALESCE(?, '')`,
      )
      .get(personId, institutionId, aff.role ?? null, aff.start_date ?? null);
    if (duplicate) continue;
    db.prepare(
      `INSERT INTO affiliations (person_id, institution_id, role, start_date, end_date)
       VALUES (?,?,?,?,?)`,
    ).run(personId, institutionId, aff.role ?? null, aff.start_date ?? null, aff.end_date ?? null);
    counts.affiliations += 1;
  }

  const personName = (getPersonRow(personId)).name;
  for (const pub of input.publications ?? []) {
    let publicationId: number | undefined;
    if (pub.doi) {
      const normalized = normalizeDoi(pub.doi);
      const existing = db
        .prepare('SELECT id, doi FROM publications WHERE doi IS NOT NULL')
        .all() as unknown as { id: number; doi: string }[];
      publicationId = existing.find((p) => normalizeDoi(p.doi) === normalized)?.id;
    }
    if (publicationId === undefined) {
      const byTitle = db
        .prepare('SELECT id FROM publications WHERE title = ? COLLATE NOCASE')
        .get(pub.title) as { id: number } | undefined;
      publicationId = byTitle?.id;
    }
    if (publicationId === undefined) {
      const info = db
        .prepare(
          `INSERT INTO publications (title, year, venue, type, doi, url, source)
           VALUES (?,?,?,?,?,?, 'orcid')`,
        )
        .run(
          pub.title,
          pub.year ?? null,
          pub.venue ?? null,
          pub.type ?? 'article',
          pub.doi ? normalizeDoi(pub.doi) : null,
          pub.url ?? null,
        );
      publicationId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO publication_authors (publication_id, position, author_name, person_id)
         VALUES (?, 1, ?, ?)`,
      ).run(publicationId, personName, personId);
      counts.publications += 1;
    } else {
      const linked = db
        .prepare(
          'SELECT 1 AS x FROM publication_authors WHERE publication_id = ? AND person_id = ?',
        )
        .get(publicationId, personId);
      if (!linked) {
        const max = db
          .prepare(
            'SELECT COALESCE(MAX(position), 0) AS max_pos FROM publication_authors WHERE publication_id = ?',
          )
          .get(publicationId) as { max_pos: number };
        db.prepare(
          `INSERT INTO publication_authors (publication_id, position, author_name, person_id)
           VALUES (?, ?, ?, ?)`,
        ).run(publicationId, max.max_pos + 1, personName, personId);
        counts.publications += 1;
      }
    }
  }

  touchPerson(personId);
  return counts;
}

export default function orcidRoutes(app: FastifyInstance): void {
  app.get('/api/orcid/:orcid/preview', async (req) => {
    const orcid = requireOrcid((req.params as { orcid: string }).orcid);
    return orcidPreview(orcid);
  });

  app.post('/api/people/:id/orcid-import', async (req) => {
    const personId = idParam(req.params);
    getPersonRow(personId);
    const body = orcidImportInput.parse(req.body);
    const imported = withTransaction(() => applyOrcidImport(personId, body));
    return { detail: personDetail(personId), imported };
  });

  app.post('/api/people/from-orcid', async (req) => {
    const body = fromOrcidInput.parse(req.body);
    const orcid = requireOrcid(body.orcid);
    const existing = db.prepare('SELECT id, name FROM people WHERE orcid = ?').get(orcid) as
      | { id: number; name: string }
      | undefined;
    if (existing) {
      throw new ConflictError(`${existing.name} already has this ORCID iD`);
    }
    const result = withTransaction(() => {
      const person: Person = insertPerson(
        { ...body.fields, name: body.name, orcid },
        'orcid',
      );
      const imported = applyOrcidImport(person.id, { ...body, fields: undefined });
      return { person, imported };
    });
    return { detail: personDetail(result.person.id), imported: result.imported };
  });
}
