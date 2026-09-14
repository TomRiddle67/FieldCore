/**
 * JWT authentication middleware for Fastify.
 *
 * Usage:
 *   app.addHook('preHandler', requireAuth(authConfig, db));
 *   // or on a single route:
 *   app.post('/sync/push', { preHandler: requireAuth(authConfig, db) }, handler);
 *
 * On success: populates `request.auth` with `VerifiedAccessToken`.
 * On failure: replies with HTTP 401 (missing/invalid token) or 403 (device revoked).
 *
 * Security decisions:
 * - Only Bearer scheme is accepted; any other Authorization header value returns 401.
 * - Clock drift is handled by jose internally (allows 0s skew by default; configurable).
 * - The device revocation check runs after JWT verification so that tampered tokens
 *   cannot trigger unnecessary DB queries.
 * - Augments Fastify's Request type via module augmentation below.
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { verifyAccessToken, type VerifiedAccessToken } from './jwt.js';
import type { AuthConfig } from './config.js';
import type { Database } from '@fieldcore/database';
import { devices } from '@fieldcore/database';
import { eq } from 'drizzle-orm';

// ---------- Module augmentation — adds `auth` to FastifyRequest ----------

declare module 'fastify' {
  interface FastifyRequest {
    auth?: VerifiedAccessToken;
  }
}

// ---------- Middleware factory ----------

/**
 * Returns a Fastify preHandler that enforces JWT authentication.
 *
 * @param config - Auth configuration (JWT secret + algorithm).
 * @param db     - Database client for device revocation check.
 */
export function requireAuth(
  config: Pick<AuthConfig, 'jwtSecret' | 'jwtAlgorithm'>,
  db: Database
): preHandlerHookHandler {
  return async function authPreHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // 1. Extract Bearer token
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'MISSING_TOKEN',
        message: 'Authorization: Bearer <token> header is required.',
      });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'MISSING_TOKEN',
        message: 'Bearer token is empty.',
      });
    }

    // 2. Verify JWT (signature, expiry, algorithm, required claims)
    let claims: VerifiedAccessToken;
    try {
      claims = await verifyAccessToken(token, config);
    } catch (err: any) {
      const isExpired =
        err?.code === 'ERR_JWT_EXPIRED' || err?.constructor?.name === 'JWTExpired';
      return reply.status(401).send({
        error: 'Unauthorized',
        code: isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: isExpired ? 'Access token has expired.' : 'Access token is invalid.',
      });
    }

    // 3. Check device revocation in DB
    const [device] = await db
      .select({ id: devices.id, isRevoked: devices.isRevoked })
      .from(devices)
      .where(eq(devices.id, claims.deviceId))
      .limit(1);

    if (!device) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'DEVICE_NOT_FOUND',
        message: 'The device associated with this token no longer exists.',
      });
    }

    if (device.isRevoked) {
      return reply.status(403).send({
        error: 'Forbidden',
        code: 'DEVICE_REVOKED',
        message: 'This device has been revoked. Please re-authenticate on a new device.',
      });
    }

    // 4. Attach verified claims to request
    request.auth = claims;
  };
}
