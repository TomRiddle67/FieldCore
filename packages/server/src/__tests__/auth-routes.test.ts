/**
 * Integration tests for authentication routes:
 *   - POST /auth/login
 *   - POST /auth/refresh
 *   - POST /auth/logout
 *   - POST /auth/devices/register
 *
 * Adheres strictly to Section 14 (Database Test Isolation):
 * - Explicit deterministic tracking of all created test entities
 * - Cleaned up in afterAll and verified by count query
 * - Uses unique UUIDs to avoid any collision with dev/seed data
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  createDatabaseClient,
  users,
  devices,
  sessions,
  refreshTokens,
} from '@fieldcore/database';
import { createServer } from '../server.js';
import { hashPassword } from '../auth/password.js';

describe('Authentication Route Integration & Isolation Suite', () => {
  const dbUrl =
    process.env.DATABASE_URL ||
    'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';
  const { db, client } = createDatabaseClient(dbUrl);
  const app = createServer({ db });

  const testUserPassword = 'StrongAuthPassword!123';
  let testPasswordHash: string;

  // Track all test IDs for deterministic cleanup
  const createdUserIds: string[] = [];
  const createdDeviceIds: string[] = [];

  const mainUserId = randomUUID();
  const mainUserEmail = `auth-test-${randomUUID()}@fieldcore.io`;
  const mainDeviceId = randomUUID();
  const revokedDeviceId = randomUUID();

  // Secondary user to prove device ownership isolation
  const otherUserId = randomUUID();
  const otherUserEmail = `other-user-${randomUUID()}@fieldcore.io`;
  const otherUserDeviceId = randomUUID();

  beforeAll(async () => {
    testPasswordHash = await hashPassword(testUserPassword);

    // Create primary test user
    await db.insert(users).values({
      id: mainUserId,
      email: mainUserEmail,
      name: 'Auth Route Test Engineer',
      role: 'GEOLOGIST',
      passwordHash: testPasswordHash,
    });
    createdUserIds.push(mainUserId);

    // Create secondary test user
    await db.insert(users).values({
      id: otherUserId,
      email: otherUserEmail,
      name: 'Other Engineer',
      role: 'GEOLOGIST',
      passwordHash: testPasswordHash,
    });
    createdUserIds.push(otherUserId);

    // Create active test device for primary user
    await db.insert(devices).values({
      id: mainDeviceId,
      userId: mainUserId,
      deviceIdentifier: `test-dev-${randomUUID()}`,
      name: 'Test Laptop',
      platform: 'DESKTOP',
      isRevoked: false,
      lastRevalidatedAt: new Date().toISOString(),
      offlineAuthWindowDays: 7,
    });
    createdDeviceIds.push(mainDeviceId);

    // Create test device owned by secondary user
    await db.insert(devices).values({
      id: otherUserDeviceId,
      userId: otherUserId,
      deviceIdentifier: `other-dev-${randomUUID()}`,
      name: 'Other User Tablet',
      platform: 'DESKTOP',
      isRevoked: false,
      lastRevalidatedAt: new Date().toISOString(),
      offlineAuthWindowDays: 7,
    });
    createdDeviceIds.push(otherUserDeviceId);

    // Create revoked test device
    await db.insert(devices).values({
      id: revokedDeviceId,
      userId: mainUserId,
      deviceIdentifier: `test-revoked-${randomUUID()}`,
      name: 'Revoked Device',
      platform: 'DESKTOP',
      isRevoked: true,
      revokedReason: 'Reported stolen',
      lastRevalidatedAt: new Date().toISOString(),
      offlineAuthWindowDays: 7,
    });
    createdDeviceIds.push(revokedDeviceId);
  });

  afterAll(async () => {
    // Deterministic teardown of all test-created resources
    if (createdUserIds.length > 0) {
      // Cascade removes sessions and refresh tokens
      await db.delete(refreshTokens).where(inArray(refreshTokens.userId, createdUserIds));
      await db.delete(sessions).where(inArray(sessions.userId, createdUserIds));
      await db.delete(devices).where(inArray(devices.userId, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }

    // Verify cleanup
    const remainingUsers = await db
      .select()
      .from(users)
      .where(inArray(users.id, createdUserIds));
    expect(remainingUsers.length).toBe(0);

    await app.close();
    await client.end();
  });

  // ─────────────────────────────────────────────────────────
  // POST /auth/login
  // ─────────────────────────────────────────────────────────

  describe('POST /auth/login', () => {
    it('authenticates with correct credentials and returns tokens', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: mainDeviceId,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.expiresIn).toBe(900);
      expect(body.tokenType).toBe('Bearer');
      expect(body.userId).toBe(mainUserId);
      expect(body.deviceId).toBe(mainDeviceId);
      expect(body.sessionId).toBeDefined();
    });

    it('rejects wrong password with generic error message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: 'wrong-password-here',
          deviceId: mainDeviceId,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(body.message).toBe('Invalid email or password.');
    });

    it('rejects non-existent email with same generic error message (anti-enumeration)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'nonexistent-user@fieldcore.io',
          password: testUserPassword,
          deviceId: mainDeviceId,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(body.message).toBe('Invalid email or password.');
    });

    it('rejects login for revoked device with 403 DEVICE_REVOKED', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: revokedDeviceId,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('DEVICE_REVOKED');
    });

    it('rejects login for device not registered to user with 400 DEVICE_NOT_FOUND', async () => {
      const randomDeviceId = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: randomDeviceId,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('DEVICE_NOT_FOUND');
    });

    it('rejects login when device belongs to a different user (cross-user device hijacking)', async () => {
      // mainUser has valid credentials, but passes otherUserDeviceId (registered to otherUser)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: otherUserDeviceId,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('DEVICE_NOT_FOUND');
      expect(body.message).toBe('The specified deviceId is not registered to this account.');
    });
  });

  // ─────────────────────────────────────────────────────────
  // POST /auth/refresh & POST /auth/logout
  // ─────────────────────────────────────────────────────────

  describe('POST /auth/refresh & POST /auth/logout', () => {
    it('refreshes an access token using valid refresh token', async () => {
      // First log in to get credentials
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: mainDeviceId,
        },
      });
      const { refreshToken, accessToken: oldAccessToken } = JSON.parse(loginRes.body);

      // Refresh
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken },
      });

      expect(refreshRes.statusCode).toBe(200);
      const refreshBody = JSON.parse(refreshRes.body);
      expect(refreshBody.accessToken).toBeDefined();
      expect(refreshBody.tokenType).toBe('Bearer');
      expect(refreshBody.expiresIn).toBe(900);
    });

    it('rejects invalid or tampered refresh token with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: '0'.repeat(96) },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('revokes session on logout and prevents subsequent refresh', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: mainDeviceId,
        },
      });
      const { accessToken, refreshToken } = JSON.parse(loginRes.body);

      // Logout with Bearer token
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      expect(logoutRes.statusCode).toBe(200);
      expect(JSON.parse(logoutRes.body).message).toBe('Logged out successfully.');

      // Refresh should now fail because session and token are revoked
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken },
      });

      expect(refreshRes.statusCode).toBe(401);
      expect(JSON.parse(refreshRes.body).code).toBe('SESSION_EXPIRED');
    });
  });

  // ─────────────────────────────────────────────────────────
  // POST /auth/devices/register (Section 8)
  // ─────────────────────────────────────────────────────────

  describe('POST /auth/devices/register', () => {
    it('requires valid authenticated Bearer token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/devices/register',
        payload: {
          name: 'Unauthenticated Device',
          platform: 'MOBILE_ANDROID',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).code).toBe('MISSING_TOKEN');
    });

    it('registers new device deriving user strictly from token, ignoring body userId and generating deviceId server-side', async () => {
      // 1. Log in to acquire authenticated access token
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: mainDeviceId,
        },
      });
      const { accessToken } = JSON.parse(loginRes.body);

      // 2. Attacker attempts to forge userId and deviceId in body
      const attackerAttemptUserId = randomUUID();
      const attackerAttemptDeviceId = randomUUID();

      const registerRes = await app.inject({
        method: 'POST',
        url: '/auth/devices/register',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          name: 'Rugged Tablet A',
          platform: 'MOBILE_ANDROID',
          userId: attackerAttemptUserId, // Should be completely ignored!
          id: attackerAttemptDeviceId, // Should be completely ignored!
          deviceId: attackerAttemptDeviceId, // Should be completely ignored!
        },
      });

      expect(registerRes.statusCode).toBe(201);
      const resBody = JSON.parse(registerRes.body);

      // Device ID must be server-generated, NOT the attacker-specified ID
      expect(resBody.device.id).toBeDefined();
      expect(resBody.device.id).not.toBe(attackerAttemptDeviceId);
      createdDeviceIds.push(resBody.device.id);

      // User ID must be derived from token (mainUserId), NOT the attacker-specified userId
      expect(resBody.device.userId).toBe(mainUserId);
      expect(resBody.device.userId).not.toBe(attackerAttemptUserId);

      expect(resBody.device.name).toBe('Rugged Tablet A');
      expect(resBody.device.platform).toBe('MOBILE_ANDROID');

      // Check that a fresh session was established for the new device
      expect(resBody.session.sessionId).toBeDefined();
      expect(resBody.session.accessToken).toBeDefined();
      expect(resBody.session.refreshToken).toBeDefined();

      // Verify directly in DB
      const [dbDevice] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, resBody.device.id));
      expect(dbDevice).toBeDefined();
      expect(dbDevice.userId).toBe(mainUserId);
    });

    it('rejects device registration when conflicting deviceIdentifier is used', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: mainUserEmail,
          password: testUserPassword,
          deviceId: mainDeviceId,
        },
      });
      const { accessToken } = JSON.parse(loginRes.body);

      const uniqueIdentifier = `unique-id-${randomUUID()}`;

      // Register first time
      const res1 = await app.inject({
        method: 'POST',
        url: '/auth/devices/register',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Device 1',
          platform: 'DESKTOP',
          deviceIdentifier: uniqueIdentifier,
        },
      });
      expect(res1.statusCode).toBe(201);
      const body1 = JSON.parse(res1.body);
      createdDeviceIds.push(body1.device.id);

      // Register second time with duplicate identifier
      const res2 = await app.inject({
        method: 'POST',
        url: '/auth/devices/register',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Device 2',
          platform: 'DESKTOP',
          deviceIdentifier: uniqueIdentifier,
        },
      });
      expect(res2.statusCode).toBe(409);
      expect(JSON.parse(res2.body).code).toBe('DEVICE_IDENTIFIER_EXISTS');
    });
  });
});
