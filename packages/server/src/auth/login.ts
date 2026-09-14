/**
 * POST /auth/login
 *
 * Authenticates a user with email + password, creates a session and issues:
 *   - A short-lived JWT access token  (15 min by default)
 *   - A long-lived opaque refresh token (30 days by default)
 *
 * Security decisions:
 * - The user is identified by email; the password is verified with Argon2id.
 * - Generic error message ("Invalid email or password") for both missing user
 *   and wrong password — avoids user enumeration.
 * - Session is scoped to a specific (user, device) pair.
 *   The `deviceId` in the request body MUST match a device already registered
 *   in the `devices` table and owned by the authenticated user.
 * - Refresh token is returned in the response body (to be stored by the client
 *   in secure device storage, not localStorage).  Phase 2 will add HttpOnly
 *   cookie support for web clients.
 * - On each login a new session + refresh token are created; old sessions from
 *   the same device are NOT automatically revoked here (handled by Phase 2
 *   token rotation / session management).
 *
 * Deferred:
 * - Rate limiting / account lockout (Phase 2)
 * - Trusted device fingerprinting (Phase 3)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@fieldcore/database';
import { users, devices, sessions, refreshTokens } from '@fieldcore/database';
import { verifyPassword } from './password.js';
import { signAccessToken } from './jwt.js';
import { generateRefreshToken, hashRefreshToken } from './token.js';
import type { AuthConfig } from './config.js';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /**
   * The caller's pre-registered device UUID.
   * This must match a device row owned by the authenticated user.
   * For the dev seed, the well-known IDs from bin.ts apply.
   */
  deviceId: z.string().uuid(),
});

export type LoginBody = z.infer<typeof loginBodySchema>;

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  userId: string;
  deviceId: string;
  sessionId: string;
}

/**
 * Registers the POST /auth/login route on the given Fastify instance.
 */
export function registerLoginRoute(
  app: FastifyInstance,
  db: Database,
  config: AuthConfig
): void {
  app.post('/auth/login', async (request, reply) => {
    // 1. Validate request body
    const parseResult = loginBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.errors,
      });
    }
    const { email, password, deviceId } = parseResult.data;

    // 2. Look up user by email
    const [user] = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        role: users.role,
      })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    // 3. Generic error — no user enumeration
    if (!user || !user.passwordHash) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      });
    }

    // 4. Verify password (Argon2id — timing-safe)
    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      });
    }

    // 5. Verify device belongs to this user and is not revoked
    const [device] = await db
      .select({ id: devices.id, isRevoked: devices.isRevoked })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, user.id)))
      .limit(1);

    if (!device) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'DEVICE_NOT_FOUND',
        message: 'The specified deviceId is not registered to this account.',
      });
    }

    if (device.isRevoked) {
      return reply.status(403).send({
        error: 'Forbidden',
        code: 'DEVICE_REVOKED',
        message: 'This device has been revoked.',
      });
    }

    // 6. Create session
    const sessionId = uuidv4();
    const sessionExpiresAt = new Date(
      Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000
    ).toISOString();

    await db.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      deviceId: device.id,
      isRevoked: false,
      expiresAt: sessionExpiresAt,
    });

    // 7. Issue refresh token (raw returned to client; hash stored in DB)
    const rawRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const refreshTokenExpiresAt = sessionExpiresAt; // refresh token mirrors session lifetime

    await db.insert(refreshTokens).values({
      id: uuidv4(),
      sessionId,
      userId: user.id,
      tokenHash,
      isRevoked: false,
      expiresAt: refreshTokenExpiresAt,
    });

    // 8. Sign access token
    const accessToken = await signAccessToken(
      { sub: user.id, deviceId: device.id, sid: sessionId },
      config
    );

    // 9. Update device lastSeenAt
    await db
      .update(devices)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(devices.id, device.id));

    const response: LoginResponse = {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: config.accessTokenTtlSeconds,
      tokenType: 'Bearer',
      userId: user.id,
      deviceId: device.id,
      sessionId,
    };

    return reply.status(200).send(response);
  });
}
