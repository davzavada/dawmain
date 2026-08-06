import type { FastifyInstance } from 'fastify';
import { interactionInput, interactionPatch, type Interaction } from '@crm/shared';
import { db } from '../db.js';
import { NotFoundError } from '../errors.js';
import { getPersonRow, idParam, touchPeople } from '../helpers.js';

function getInteractionRow(id: number): Interaction {
  const row = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as unknown as
    | Interaction
    | undefined;
  if (!row) throw new NotFoundError(`Interaction ${id} not found`);
  return row;
}

export default function interactionRoutes(app: FastifyInstance): void {
  app.post('/api/people/:id/interactions', async (req) => {
    const personId = idParam(req.params);
    const body = interactionInput.parse(req.body);
    getPersonRow(personId);
    const info = db
      .prepare('INSERT INTO interactions (person_id, date, kind, note) VALUES (?,?,?,?)')
      .run(personId, body.date.trim(), body.kind ?? 'other', body.note ?? null);
    touchPeople([personId]);
    return getInteractionRow(Number(info.lastInsertRowid));
  });

  app.patch('/api/interactions/:id', async (req) => {
    const id = idParam(req.params);
    const body = interactionPatch.parse(req.body);
    const existing = getInteractionRow(id);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (body.date !== undefined) {
      sets.push('date = ?');
      values.push(body.date.trim());
    }
    if (body.kind !== undefined) {
      sets.push('kind = ?');
      values.push(body.kind);
    }
    if (body.note !== undefined) {
      sets.push('note = ?');
      values.push(body.note ?? null);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE interactions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      touchPeople([existing.person_id]);
    }
    return getInteractionRow(id);
  });

  app.delete('/api/interactions/:id', async (req, reply) => {
    const id = idParam(req.params);
    const existing = getInteractionRow(id);
    db.prepare('DELETE FROM interactions WHERE id = ?').run(id);
    touchPeople([existing.person_id]);
    return reply.code(204).send();
  });
}
