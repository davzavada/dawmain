import type { FastifyInstance } from 'fastify';
import { isDirected, relationInput, relationPatch, type Relation } from '@crm/shared';
import { db } from '../db.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { getPersonRow, idParam, touchPeople } from '../helpers.js';

function getRelationRow(id: number): Relation {
  const row = db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as unknown as
    | Relation
    | undefined;
  if (!row) throw new NotFoundError(`Relation ${id} not found`);
  return row;
}

function assertNoDuplicate(
  fromId: number,
  toId: number,
  type: string,
  ignoreId?: number,
): void {
  const exact = db
    .prepare(
      `SELECT id FROM relations WHERE from_person_id = ? AND to_person_id = ? AND type = ?`,
    )
    .get(fromId, toId, type) as { id: number } | undefined;
  if (exact && exact.id !== ignoreId) {
    throw new ConflictError('This relation already exists');
  }
  if (!isDirected(type)) {
    const reverse = db
      .prepare(
        `SELECT id FROM relations WHERE from_person_id = ? AND to_person_id = ? AND type = ?`,
      )
      .get(toId, fromId, type) as { id: number } | undefined;
    if (reverse && reverse.id !== ignoreId) {
      throw new ConflictError('This relation already exists (in the other direction)');
    }
  }
}

export default function relationRoutes(app: FastifyInstance): void {
  app.post('/api/relations', async (req) => {
    const body = relationInput.parse(req.body);
    getPersonRow(body.from_person_id);
    getPersonRow(body.to_person_id);
    assertNoDuplicate(body.from_person_id, body.to_person_id, body.type);
    const info = db
      .prepare(
        `INSERT INTO relations (from_person_id, to_person_id, type, date, note)
         VALUES (?,?,?,?,?)`,
      )
      .run(
        body.from_person_id,
        body.to_person_id,
        body.type,
        body.date ?? null,
        body.note ?? null,
      );
    touchPeople([body.from_person_id, body.to_person_id]);
    return getRelationRow(Number(info.lastInsertRowid));
  });

  app.patch('/api/relations/:id', async (req) => {
    const id = idParam(req.params);
    const body = relationPatch.parse(req.body);
    const existing = getRelationRow(id);
    const type = body.type ?? existing.type;
    if (type !== existing.type) {
      assertNoDuplicate(existing.from_person_id, existing.to_person_id, type, id);
    }
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (body.type !== undefined) {
      sets.push('type = ?');
      values.push(body.type);
    }
    for (const field of ['date', 'note'] as const) {
      if (body[field] === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(body[field] ?? null);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE relations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      touchPeople([existing.from_person_id, existing.to_person_id]);
    }
    return getRelationRow(id);
  });

  app.delete('/api/relations/:id', async (req, reply) => {
    const id = idParam(req.params);
    const existing = getRelationRow(id);
    db.prepare('DELETE FROM relations WHERE id = ?').run(id);
    touchPeople([existing.from_person_id, existing.to_person_id]);
    return reply.code(204).send();
  });
}
