/**
 * POST /auth/devices/register
 *
 * Registers a new device for the authenticated user.
 *
 * Security decisions:
 * - Requires a valid JWT access token via `requireAuth`.
 * - The authenticated user identity is derived strictly from `request.auth.sub`
 *   (the verified token principal). Any `userId` provided in the request body is
 *   completely ignored / rejected.
 * - The authoritative device ID is generated server-side via UUID v4.
 *   Any `id` or `deviceId` provided in the request body is rejected / ignored.
 * - Automatically initializes a session and issues scoped access + refresh tokens
 *   bound to the newly registered device.
 * - Device name and platform are validated with Zod.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@fieldcore/database';
import { devices, sessions, refreshTokens } from '@fieldcore/database';
import { requireAuth } from './middleware.js';
import { signAccessToken } from './jwt.js';
import { generateRefreshToken, hashRefreshToken } from './token.js';
import type { AuthConfig } from './config.js';

const registerDeviceBodySchema = z.object({
  name: z.string().min(1).max(255),
  platform: z
    .enum(['WEB', 'DESKTOP', 'MOBILE_IOS', 'MOBILE_ANDROID'])
    .default('WEB'),
  deviceIdentifier: z.string().min(1).max(255).optional(),
});

export type RegisterDeviceBody = z.infer<typeof registerDeviceBodySchema>;

export interface RegisterDeviceResponse {
  device: {
    id: string;
    userId: string;
    deviceIdentifier: string;
    name: string;
    platform: string;
    createdAt: string;
  };
  session: {
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
  };
}

/**
 * Registers the POST /auth/devices/register route on the given Fastify instance.
 */
export function registerDeviceRoute(
  app: FastifyInstance,
  db: Database,
  config: AuthConfig
): void {
  app.post(
    '/auth/devices/register',
    { preHandler: requireAuth(config, db) },
    async (request, reply) => {
      // 1. Authenticated principal from verified token (never trust request body)
      const authenticatedUserId = request.auth?.sub;
      if (!authenticatedUserId) {
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'UNAUTHORIZED',
          message: 'Authenticated principal required.',
        });
      }

      // 2. Validate request body
      const parseResult = registerDeviceBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const { name, platform, deviceIdentifier: requestedIdentifier } = parseResult.data;

      // 3. Authoritative server-generated device ID
      const deviceId = uuidv4();
      const deviceIdentifier = requestedIdentifier || `dev-${uuidv4()}`;

      // Check if deviceIdentifier is already taken
      const [existingDevice] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.deviceIdentifier, deviceIdentifier))
        .limit(1);

      if (existingDevice) {
        return reply.status(409).send({
          error: 'Conflict',
          code: 'DEVICE_IDENTIFIER_EXISTS',
          message: 'A device with this identifier is already registered.',
        });
      }

      const now = new Date().toISOString();

      // 4. Insert authoritative device row bound to authenticated user
      await db.insert(devices).values({
        id: deviceId,
        userId: authenticatedUserId, // Server-derived from verified JWT claim
        deviceIdentifier,
        name,
        platform,
        isRevoked: false,
        lastSeenAt: now,
        lastRevalidatedAt: now,
        offlineAuthWindowDays: 7,
      });

      // 5. Establish initial session and credentials for the new device
      const sessionId = uuidv4();
      const sessionExpiresAt = new Date(
        Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000
      ).toISOString();

      await db.insert(sessions).values({
        id: sessionId,
        userId: authenticatedUserId,
        deviceId,
        isRevoked: false,
        expiresAt: sessionExpiresAt,
      });

      const rawRefreshToken = generateRefreshToken();
      const tokenHash = hashRefreshToken(rawRefreshToken);

      await db.insert(refreshTokens).values({
        id: uuidv4(),
        sessionId,
        userId: authenticatedUserId,
        tokenHash,
        isRevoked: false,
        expiresAt: sessionExpiresAt,
      });

      const accessToken = await signAccessToken(
        { sub: authenticatedUserId, deviceId, sid: sessionId },
        config
      );

      const response: RegisterDeviceResponse = {
        device: {
          id: deviceId,
          userId: authenticatedUserId,
          deviceIdentifier,
          name,
          platform,
          createdAt: now,
        },
        session: {
          sessionId,
          accessToken,
          refreshToken: rawRefreshToken,
          expiresIn: config.accessTokenTtlSeconds,
          tokenType: 'Bearer',
        },
      };

      return reply.status(201).send(response);
    }
  );
}
