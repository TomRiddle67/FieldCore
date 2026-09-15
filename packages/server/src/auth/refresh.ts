/**
 * POST /auth/refresh
 *
 * Issues a new access token using a valid, non-expired, non-revoked refresh token.
 *
 * Security decisions:
 * - The raw refresh token is hashed (SHA-256) before lookup — the DB never contains
 *   the raw token.
 * - The session must be active (not revoked, not expired).
 * - The device must not be revoked.
 * - A new access token is issued on every successful call.
 * - The refresh token itself is NOT rotated here — rotation is a Phase 2 feature.
 *   Until then, the same refresh token can be used multiple times within its TTL.
 *
 * Deferred:
 * - Token rotation / reuse detection (Phase 2)
 * - Session-family revocation on reuse detection (Phase 2)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@fieldcore/database';
import { users, devices, sessions, refreshTokens } from '@fieldcore/database';
import { signAccessToken } from './jwt.js';
import { hashRefreshToken } from './token.js';
import type { AuthConfig } from './config.js';

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

/**
 * Registers the POST /auth/refresh route on the given Fastify instance.
 */
export function registerRefreshRoute(
  app: FastifyInstance,
  db: Database,
  config: AuthConfig
): void {
  app.post('/auth/refresh', async (request, reply) => {
    // 1. Validate request body
    const parseResult = refreshBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.errors,
      });
    }
    const { refreshToken: rawToken } = parseResult.data;

    // 2. Hash the raw token for DB lookup
    const tokenHash = hashRefreshToken(rawToken);

    // 3. Look up the refresh token record
    const [tokenRecord] = await db
      .select({
        id: refreshTokens.id,
        sessionId: refreshTokens.sessionId,
        userId: refreshTokens.userId,
        isRevoked: refreshTokens.isRevoked,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!tokenRecord) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid.',
      });
    }

    if (tokenRecord.isRevoked) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'REFRESH_TOKEN_REVOKED',
        message: 'Refresh token has been revoked.',
      });
    }

    if (new Date(tokenRecord.expiresAt) <= new Date()) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired. Please log in again.',
      });
    }

    // 4. Validate the session
    const [session] = await db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        deviceId: sessions.deviceId,
        isRevoked: sessions.isRevoked,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(eq(sessions.id, tokenRecord.sessionId))
      .limit(1);

    if (!session || session.isRevoked || new Date(session.expiresAt) <= new Date()) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'SESSION_EXPIRED',
        message: 'Session is no longer valid. Please log in again.',
      });
    }

    // 5. Check device is still active
    const [device] = await db
      .select({ id: devices.id, isRevoked: devices.isRevoked })
      .from(devices)
      .where(eq(devices.id, session.deviceId))
      .limit(1);

    if (!device || device.isRevoked) {
      return reply.status(403).send({
        error: 'Forbidden',
        code: 'DEVICE_REVOKED',
        message: 'This device has been revoked.',
      });
    }

    // 6. Issue a new access token
    const accessToken = await signAccessToken(
      { sub: session.userId, deviceId: session.deviceId, sid: session.id },
      config
    );

    const response: RefreshResponse = {
      accessToken,
      expiresIn: config.accessTokenTtlSeconds,
      tokenType: 'Bearer',
    };

    return reply.status(200).send(response);
  });
}
