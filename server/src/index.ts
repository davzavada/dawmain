import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import { registerErrorHandler } from './errors.js';
import peopleRoutes from './routes/people.js';
import institutionRoutes from './routes/institutions.js';
import publicationRoutes from './routes/publications.js';
import relationRoutes from './routes/relations.js';
import graphRoutes from './routes/graph.js';
import orcidRoutes from './routes/orcid.js';

const here = path.dirname(fileURLToPath(import.meta.url));

migrate();

const app = Fastify({ logger: true });
registerErrorHandler(app);

app.get('/api/health', async () => ({ ok: true }));
peopleRoutes(app);
institutionRoutes(app);
publicationRoutes(app);
relationRoutes(app);
graphRoutes(app);
orcidRoutes(app);

// In production the server also serves the built SPA. In dev, Vite serves it
// on its own port and proxies /api here, so web/dist may not exist.
const webDist = path.resolve(here, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
