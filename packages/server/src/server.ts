import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { pushRequestSchema } from '@fieldcore/validation';
import type { Database } from '@fieldcore/database';
import { processPushRequest } from './push-handler.js';

export interface ServerOptions {
  db: Database;
  logger?: boolean;
}

/**
 * Creates and configures the FieldCore Fastify sync server.
 */
export function createServer({ db, logger = false }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.register(cors, {
    origin: true,
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  /**
   * Batched Push Synchronization Route.
   * Processes up to 25 operations independently with per-operation transaction isolation.
   * Returns HTTP 200 for all structurally valid requests, carrying per-operation outcomes.
   * HTTP 4xx/5xx are strictly reserved for request-level failures.
   */
  app.post('/sync/push', async (request, reply) => {
    const parseResult = pushRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.errors,
      });
    }

    try {
      const response = await processPushRequest({
        db,
        request: parseResult.data,
      });
      return reply.status(200).send(response);
    } catch (err: any) {
      return reply.status(500).send({
        error: 'Internal server error during sync push processing',
        message: err?.message,
      });
    }
  });

  return app;
}
