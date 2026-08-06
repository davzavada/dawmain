import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true });

app.get('/api/health', async () => ({ ok: true }));

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
