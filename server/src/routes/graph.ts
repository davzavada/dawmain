import type { FastifyInstance } from 'fastify';
import { isDirected, type GraphData, type GraphEdge, type GraphNode } from '@crm/shared';
import { db } from '../db.js';

export default function graphRoutes(app: FastifyInstance): void {
  app.get('/api/graph', async (): Promise<GraphData> => {
    const people = db
      .prepare('SELECT id, name FROM people ORDER BY name COLLATE NOCASE')
      .all() as unknown as { id: number; name: string }[];

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

    const relationRows = db
      .prepare('SELECT id, from_person_id, to_person_id, type, date, note FROM relations')
      .all() as unknown as {
      id: number;
      from_person_id: number;
      to_person_id: number;
      type: string;
      date: string | null;
      note: string | null;
    }[];

    const coauthorRows = db
      .prepare(
        `SELECT a.person_id AS source, b.person_id AS target,
                COUNT(DISTINCT a.publication_id) AS weight
         FROM publication_authors a
         JOIN publication_authors b
           ON a.publication_id = b.publication_id AND a.person_id < b.person_id
         WHERE a.person_id IS NOT NULL AND b.person_id IS NOT NULL
         GROUP BY a.person_id, b.person_id`,
      )
      .all() as unknown as { source: number; target: number; weight: number }[];

    const edges: GraphEdge[] = [
      ...relationRows.map(
        (r): GraphEdge => ({
          id: `r${r.id}`,
          kind: 'relation',
          source: r.from_person_id,
          target: r.to_person_id,
          type: r.type,
          directed: isDirected(r.type),
          date: r.date,
          note: r.note,
        }),
      ),
      ...coauthorRows.map(
        (c): GraphEdge => ({
          id: `c${c.source}-${c.target}`,
          kind: 'coauthor',
          source: c.source,
          target: c.target,
          weight: c.weight,
        }),
      ),
    ];

    const degree = new Map<number, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const nodes: GraphNode[] = people.map((p) => ({
      id: p.id,
      name: p.name,
      tags: tagsByPerson.get(p.id) ?? [],
      degree: degree.get(p.id) ?? 0,
    }));

    return { nodes, edges };
  });
}
