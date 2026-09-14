/**
 * POST /auth/logout
 *
 * Revokes the active session (and all its refresh tokens by cascade) for the
 * authenticated user. Requires a valid Bearer access token.
 *
 * Security decisions:
 * - Requires a valid, non-expired access token — not just a refresh token —
 *   so that a stolen refresh token alone cannot silently revoke an active session.
 * - Revokes the session identified by the `sid` claim in the access token.
 * - Refresh tokens for the session are implicitly invalidated because the
 *   /auth/refresh route checks session revocation.
 * - The access token itself cannot be revoked server-side (it's stateless) but
 *   will expire within accessTokenTtlSeconds (default: 15 min).
 *   Token blocklisting is a Phase 2 feature.
 *
 * Deferred:
 * - Access token blocklisting (Phase 2)
 * - "Logout all devices" / global session revocation (Phase 2)
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Database } from '@fieldcore/database';
import { sessions } from '@fieldcore/database';
import type { AuthConfig } from './config.js';
import { requireAuth } from './middleware.js';

/**
 * Registers the POST /auth/logout route on the given Fastify instance.
 */
export function registerLogoutRoute(
  app: FastifyInstance,
  db: Database,
  config: AuthConfig
): void {
  app.post(
    '/auth/logout',
    { preHandler: requireAuth(config, db) },
    async (request, reply) => {
      // auth is guaranteed to be set because requireAuth ran successfully
      const { sid } = request.auth!;

      await db
        .update(sessions)
        .set({
          isRevoked: true,
          revokedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sessions.id, sid));

      return reply.status(200).send({ message: 'Logged out successfully.' });
    }
  );
}
