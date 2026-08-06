import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

const TABLES = [
  'people',
  'institutions',
  'affiliations',
  'publications',
  'publication_authors',
  'relations',
  'interactions',
  'tags',
  'person_tags',
  'dismissed_suggestions',
] as const;

/** Full JSON dump of every table — the safety net for a one-file database. */
export default function exportRoutes(app: FastifyInstance): void {
  app.get('/api/export', async (req, reply) => {
    const tables: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
    }
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="academic-crm-${stamp}.json"`);
    return { exported_at: new Date().toISOString(), tables };
  });
}
