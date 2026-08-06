import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class BadRequestError extends Error {}
export class UpstreamError extends Error {}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Validation failed', issues: err.issues });
    }
    if (err instanceof BadRequestError) {
      return reply.code(400).send({ error: err.message || 'Bad request' });
    }
    if (err instanceof NotFoundError) {
      return reply.code(404).send({ error: err.message || 'Not found' });
    }
    if (err instanceof ConflictError) {
      return reply.code(409).send({ error: err.message || 'Conflict' });
    }
    if (err instanceof UpstreamError) {
      return reply.code(502).send({ error: err.message || 'Upstream service failed' });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      return reply.code(409).send({ error: 'Already exists (unique constraint)' });
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return reply.code(400).send({ error: 'Referenced row does not exist' });
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode < 500) {
      return reply.code(statusCode).send({ error: message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Internal server error' });
  });
}
