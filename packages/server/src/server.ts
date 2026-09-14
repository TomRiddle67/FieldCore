import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { pushRequestSchema, pullRequestSchema } from '@fieldcore/validation';
import type { Database } from '@fieldcore/database';
import { processPushRequest } from './push-handler.js';
import { processPullRequest, DeviceRevokedError } from './pull-handler.js';
import {
  loadAuthConfig,
  registerLoginRoute,
  registerRefreshRoute,
  registerLogoutRoute,
} from './auth/index.js';

export interface ServerOptions {
  db: Database;
  logger?: boolean;
}

/**
 * Creates and configures the FieldCore Fastify sync server.
 *
 * Authentication routes:
 *   POST /auth/login    — password login, issues access + refresh tokens
 *   POST /auth/refresh  — issue new access token from refresh token
 *   POST /auth/logout   — revoke current session (requires Bearer token)
 *
 * Sync routes (currently unauthenticated — Phase 2 will add requireAuth):
 *   POST /sync/push
 *   GET  /sync/pull
 */
export function createServer({ db, logger = false }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger });

  // Load auth config at server construction time — fails fast if JWT_SECRET is missing.
  const authConfig = loadAuthConfig(process.env);

  app.register(cors, {
    origin: true,
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ---------- Authentication routes ----------

  registerLoginRoute(app, db, authConfig);
  registerRefreshRoute(app, db, authConfig);
  registerLogoutRoute(app, db, authConfig);

  // ---------- Sync routes ----------

  /**
   * Batched Push Synchronization Route.
   * Processes up to 25 operations independently with per-operation transaction isolation.
   * Returns HTTP 200 for all structurally valid requests, carrying per-operation outcomes.
   * HTTP 4xx/5xx are strictly reserved for request-level failures.
   *
   * TODO(auth-phase-2): add preHandler: requireAuth(authConfig, db)
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

  /**
   * Pull Synchronization Route.
   * Fetches monotonic change_log entries strictly ascending from afterSequence.
   * Device revocation returns HTTP 403.
   * Expired offline window returns HTTP 200 with cursorExpired: true.
   *
   * TODO(auth-phase-2): add preHandler: requireAuth(authConfig, db)
   */
  app.get('/sync/pull', async (request, reply) => {
    const parseResult = pullRequestSchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.errors,
      });
    }

    try {
      const response = await processPullRequest({
        db,
        request: parseResult.data,
      });
      return reply.status(200).send(response);
    } catch (err: any) {
      if (err instanceof DeviceRevokedError || err?.code === 'DEVICE_REVOKED') {
        return reply.status(403).send({
          error: err.message,
          code: 'DEVICE_REVOKED',
        });
      }
      return reply.status(500).send({
        error: 'Internal server error during sync pull processing',
        message: err?.message,
      });
    }
  });

  return app;
}
