/**
 * POST /auth/login
 *
 * Authenticates a user with email + password, supporting two paths:
 *   1. Existing-device login: client provides `deviceId`. Verifies device ownership
 *      and revocation; issues session + tokens.
 *   2. First-device auto-provisioning: `deviceId` is omitted for a brand-new user
 *      with zero registered devices. Atomically creates a server-generated device,
 *      session, and refresh token in a single database transaction. If the user
 *      already has registered devices, `deviceId` is strictly required.
 *
 * Security decisions:
 * - The user is identified by email; password is verified with Argon2id before any DB transaction.
 * - Generic error message ("Invalid email or password") for both missing user
 *   and wrong password — avoids user enumeration.
 * - `deviceId` is NEVER a creation authority: supplying an unknown or unowned `deviceId`
 *   is rejected with 400 DEVICE_NOT_FOUND. Only omission of `deviceId` triggers auto-provisioning.
 * - `userId` is never accepted from the client anywhere in this flow; it is derived
 *   exclusively from the authenticated user.
 * - Server-generated UUIDs are authoritative for all created devices and sessions.
 * - Device + session + refresh-token creation is wrapped in an atomic database transaction.
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
   * Optional for brand-new users with zero registered devices (triggers auto-provisioning).
   * Strictly required once at least one device exists for the account.
   */
  deviceId: z.string().uuid().optional(),
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

    // 4. Verify password (Argon2id — timing-safe, outside transaction)
    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      return reply.status(401).send({
        error: 'Unauthorized',
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      });
    }

    const sessionId = uuidv4();
    const rawRefreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const sessionExpiresAt = new Date(
      Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000
    ).toISOString();

    let effectiveDeviceId: string;

    if (deviceId) {
      // ─────────────────────────────────────────────────────────────
      // PATH 1: Existing-device login
      // ─────────────────────────────────────────────────────────────

      // Verify device belongs to this user and is not revoked
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

      // Atomic session + refresh token creation + lastSeenAt update
      await db.transaction(async (tx) => {
        await tx.insert(sessions).values({
          id: sessionId,
          userId: user.id,
          deviceId: device.id,
          isRevoked: false,
          expiresAt: sessionExpiresAt,
        });

        await tx.insert(refreshTokens).values({
          id: uuidv4(),
          sessionId,
          userId: user.id,
          tokenHash,
          isRevoked: false,
          expiresAt: sessionExpiresAt,
        });

        await tx
          .update(devices)
          .set({ lastSeenAt: new Date().toISOString() })
          .where(eq(devices.id, device.id));
      });

      effectiveDeviceId = device.id;
    } else {
      // ─────────────────────────────────────────────────────────────
      // PATH 2: First/New-device auto-provisioning
      // ─────────────────────────────────────────────────────────────

      // Reject if user already has at least one registered device
      const existingDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.userId, user.id))
        .limit(1);

      if (existingDevices.length > 0) {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'DEVICE_ID_REQUIRED',
          message: 'deviceId is required when devices are already registered to this account.',
        });
      }

      // Generate device ID server-side
      const newDeviceId = uuidv4();
      const now = new Date().toISOString();

      // ONE atomic transaction: device creation + session creation + refresh-token creation
      await db.transaction(async (tx) => {
        await tx.insert(devices).values({
          id: newDeviceId,
          userId: user.id, // Strictly derived from authenticated user
          deviceIdentifier: `dev-${uuidv4()}`,
          name: 'Initial Device',
          platform: 'WEB',
          isRevoked: false,
          lastSeenAt: now,
          lastRevalidatedAt: now,
          offlineAuthWindowDays: 7,
        });

        await tx.insert(sessions).values({
          id: sessionId,
          userId: user.id,
          deviceId: newDeviceId,
          isRevoked: false,
          expiresAt: sessionExpiresAt,
        });

        await tx.insert(refreshTokens).values({
          id: uuidv4(),
          sessionId,
          userId: user.id,
          tokenHash,
          isRevoked: false,
          expiresAt: sessionExpiresAt,
        });
      });

      effectiveDeviceId = newDeviceId;
    }

    // Sign JWT access token with bound deviceId and sid
    const accessToken = await signAccessToken(
      { sub: user.id, deviceId: effectiveDeviceId, sid: sessionId },
      config
    );

    const response: LoginResponse = {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: config.accessTokenTtlSeconds,
      tokenType: 'Bearer',
      userId: user.id,
      deviceId: effectiveDeviceId,
      sessionId,
    };

    return reply.status(200).send(response);
  });
}
