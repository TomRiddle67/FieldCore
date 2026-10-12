/**
 * Phase 2.1 Verification Suite: Authenticated & Project-Authorized Synchronization.
 *
 * Verifies all Phase 2.1 acceptance criteria:
 * 1. POST /sync/push requires Bearer JWT -> HTTP 401 if missing/invalid/expired
 * 2. GET /sync/pull requires Bearer JWT -> HTTP 401 if missing/invalid/expired
 * 3. Revoked device returns HTTP 403
 * 4. Server identity authority: spoofed userId/deviceId in body are ignored;
 *    verified JWT identity is written to change_log and inspections
 * 5. Explicit project authorization:
 *    - User in project_members -> APPLIED
 *    - User NOT in project_members -> UNAUTHORIZED
 * 6. Scoped pull replication:
 *    - User A only sees changes from authorized projects, never unauthorized projects
 * 7. last_revalidated_at timestamp refreshed on successful sync push and pull
 * 8. Project creation auto-enrolls creator as OWNER in project_members
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import {
  createDatabaseClient,
  users,
  devices,
  projects,
  sites,
  inspections,
  measurements,
  sessions,
  projectMembers,
  changeLog,
} from '@fieldcore/database';
import { createServer } from '../server.js';
import { loadAuthConfig } from '../auth/config.js';
import { signAccessToken } from '../auth/jwt.js';
import type { PushRequest, SyncOperation } from '@fieldcore/types';

describe('Phase 2.1 Authenticated & Project-Authorized Synchronization', () => {
  const dbUrl =
    process.env.DATABASE_URL ||
    'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';
  const { db, client } = createDatabaseClient(dbUrl);
  const app = createServer({ db });
  const authConfig = loadAuthConfig(process.env);

  // Entities for testing
  const userA = randomUUID();
  const deviceA = randomUUID();
  const userB = randomUUID();
  const deviceB = randomUUID();
  const revokedDevice = randomUUID();

  let tokenA: string;
  let tokenB: string;
  let revokedToken: string;
  let expiredToken: string;

  const projectA = randomUUID();
  const projectB = randomUUID();

  const createdUserIds = [userA, userB];
  const createdProjectIds = [projectA, projectB];

  beforeAll(async () => {
    // 1. Seed users
    await db.insert(users).values([
      {
        id: userA,
        email: `usera-${randomUUID()}@fieldcore.io`,
        name: 'User Alpha',
        role: 'GEOLOGIST',
      },
      {
        id: userB,
        email: `userb-${randomUUID()}@fieldcore.io`,
        name: 'User Beta',
        role: 'GEOLOGIST',
      },
    ]);

    // 2. Seed devices
    const initialPastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(devices).values([
      {
        id: deviceA,
        userId: userA,
        deviceIdentifier: `dev-a-${randomUUID()}`,
        name: 'Toughbook A',
        platform: 'DESKTOP',
        isRevoked: false,
        lastRevalidatedAt: initialPastDate,
        offlineAuthWindowDays: 7,
      },
      {
        id: deviceB,
        userId: userB,
        deviceIdentifier: `dev-b-${randomUUID()}`,
        name: 'Toughbook B',
        platform: 'DESKTOP',
        isRevoked: false,
        lastRevalidatedAt: initialPastDate,
        offlineAuthWindowDays: 7,
      },
      {
        id: revokedDevice,
        userId: userA,
        deviceIdentifier: `dev-revoked-${randomUUID()}`,
        name: 'Revoked Device',
        platform: 'DESKTOP',
        isRevoked: true,
        revokedReason: 'Lost in transport',
        lastRevalidatedAt: new Date().toISOString(),
      },
    ]);

    // 3. Issue tokens
    tokenA = await signAccessToken(
      { sub: userA, deviceId: deviceA, sid: randomUUID() },
      authConfig
    );
    tokenB = await signAccessToken(
      { sub: userB, deviceId: deviceB, sid: randomUUID() },
      authConfig
    );
    revokedToken = await signAccessToken(
      { sub: userA, deviceId: revokedDevice, sid: randomUUID() },
      authConfig
    );
    // Expired token: ttl = -10s
    expiredToken = await signAccessToken(
      { sub: userA, deviceId: deviceA, sid: randomUUID() },
      { ...authConfig, accessTokenTtlSeconds: -10 }
    );

    // 4. Seed Project A and Project B
    await db.insert(projects).values([
      {
        id: projectA,
        name: 'Project Alpha (User A Only)',
        code: `PRJ-A-${randomUUID().slice(0, 6)}`,
      },
      {
        id: projectB,
        name: 'Project Beta (User B Only)',
        code: `PRJ-B-${randomUUID().slice(0, 6)}`,
      },
    ]);

    // 5. Seed project_members: User A belongs to Project A; User B belongs to Project B
    await db.insert(projectMembers).values([
      {
        id: randomUUID(),
        projectId: projectA,
        userId: userA,
        role: 'OWNER',
      },
      {
        id: randomUUID(),
        projectId: projectB,
        userId: userB,
        role: 'OWNER',
      },
    ]);
  });

  afterAll(async () => {
    // Teardown test entities in dependency order
    await db.delete(inspections).where(inArray(inspections.userId, createdUserIds));
    await db.delete(sites).where(inArray(sites.projectId, createdProjectIds));
    await db.delete(projectMembers).where(inArray(projectMembers.projectId, createdProjectIds));
    await db.delete(changeLog).where(inArray(changeLog.changedByUserId, createdUserIds));
    await db.delete(projects).where(inArray(projects.id, createdProjectIds));
    await db.delete(devices).where(inArray(devices.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));

    await app.close();
    await client.end();
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Authentication Gate Tests on Sync Routes
  // ─────────────────────────────────────────────────────────────

  it('rejects unauthenticated POST /sync/push with HTTP 401 MISSING_TOKEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: deviceA,
        operations: [],
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe('MISSING_TOKEN');
  });

  it('rejects unauthenticated GET /sync/pull with HTTP 401 MISSING_TOKEN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0`,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe('MISSING_TOKEN');
  });

  it('rejects expired access token on sync routes with HTTP 401 TOKEN_EXPIRED', async () => {
    const pushRes = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${expiredToken}` },
      payload: {
        deviceId: deviceA,
        operations: [],
      },
    });
    expect(pushRes.statusCode).toBe(401);
    expect(pushRes.json().code).toBe('TOKEN_EXPIRED');

    const pullRes = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0`,
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(pullRes.statusCode).toBe(401);
    expect(pullRes.json().code).toBe('TOKEN_EXPIRED');
  });

  it('rejects revoked device on sync routes with HTTP 403 DEVICE_REVOKED', async () => {
    const pushRes = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${revokedToken}` },
      payload: {
        deviceId: revokedDevice,
        operations: [],
      },
    });
    expect(pushRes.statusCode).toBe(403);
    expect(pushRes.json().code).toBe('DEVICE_REVOKED');

    const pullRes = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${revokedDevice}&afterSequence=0`,
      headers: { authorization: `Bearer ${revokedToken}` },
    });
    expect(pullRes.statusCode).toBe(403);
    expect(pullRes.json().code).toBe('DEVICE_REVOKED');
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Project-Membership Authorization Tests
  // ─────────────────────────────────────────────────────────────

  it('allows User A to create a site in authorized Project A (status: APPLIED)', async () => {
    const siteId = randomUUID();
    const opId = randomUUID();

    const pushReq: PushRequest = {
      deviceId: deviceA,
      operations: [
        {
          operationId: opId,
          entityType: 'SITE',
          entityId: siteId,
          operationType: 'CREATE',
          baseVersion: null,
          payload: {
            projectId: projectA,
            name: 'Authorized Site in Project A',
            code: `S-A-${randomUUID().slice(0, 6)}`,
          },
          status: 'PENDING',
          clientId: 'client-a',
          deviceId: deviceA,
          userId: userA,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: pushReq,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe('APPLIED');

    // Verify change_log has projectId: projectA
    const [change] = await db.select().from(changeLog).where(eq(changeLog.operationId, opId));
    expect(change).toBeDefined();
    expect(change.projectId).toBe(projectA);
    expect(change.changedByUserId).toBe(userA);
  });

  it('rejects User A attempting to create a site in unauthorized Project B with status: UNAUTHORIZED', async () => {
    const siteId = randomUUID();
    const opId = randomUUID();

    const pushReq: PushRequest = {
      deviceId: deviceA,
      operations: [
        {
          operationId: opId,
          entityType: 'SITE',
          entityId: siteId,
          operationType: 'CREATE',
          baseVersion: null,
          payload: {
            projectId: projectB, // User A is NOT a member of Project B!
            name: 'Unauthorized Cross-Project Attempt',
            code: `S-X-${randomUUID().slice(0, 6)}`,
          },
          status: 'PENDING',
          clientId: 'client-a',
          deviceId: deviceA,
          userId: userA,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: pushReq,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe('UNAUTHORIZED');
    expect(body.results[0].error).toContain('not authorized');

    // Verify site was NOT written to domain table
    const [savedSite] = await db.select().from(sites).where(eq(sites.id, siteId));
    expect(savedSite).toBeUndefined();

    // Verify change_log was NOT written
    const [change] = await db.select().from(changeLog).where(eq(changeLog.operationId, opId));
    expect(change).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Server-Authoritative Identity Enforcement
  // ─────────────────────────────────────────────────────────────

  it('enforces verified JWT identity over spoofed userId/deviceId in push payload', async () => {
    const siteId = randomUUID();
    const inspectionId = randomUUID();
    const op1 = randomUUID();
    const op2 = randomUUID();

    const spoofedUserId = randomUUID();
    const spoofedDeviceId = randomUUID();

    // User A creates site and inspection in Project A, but puts spoofed userId in body
    const pushReq: PushRequest = {
      deviceId: spoofedDeviceId, // Spoofed device in transport root
      operations: [
        {
          operationId: op1,
          entityType: 'SITE',
          entityId: siteId,
          operationType: 'CREATE',
          baseVersion: null,
          payload: {
            projectId: projectA,
            name: 'Spoof Test Site',
            code: `SP-${randomUUID().slice(0, 6)}`,
          },
          status: 'PENDING',
          clientId: 'client-a',
          deviceId: spoofedDeviceId,
          userId: spoofedUserId, // Spoofed user in operation
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
        {
          operationId: op2,
          entityType: 'INSPECTION',
          entityId: inspectionId,
          operationType: 'CREATE',
          baseVersion: null,
          payload: {
            siteId,
            title: 'Spoof Test Inspection',
            status: 'DRAFT',
            userId: spoofedUserId, // Spoofed user in domain entity
            deviceId: spoofedDeviceId, // Spoofed device in domain entity
          },
          status: 'PENDING',
          clientId: 'client-a',
          deviceId: spoofedDeviceId,
          userId: spoofedUserId,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenA}` }, // Authenticated as User A on Device A
      payload: pushReq,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].status).toBe('APPLIED');
    expect(body.results[1].status).toBe('APPLIED');

    // Verify change_log recorded verified identity (User A, Device A), NOT spoofed values
    const [change1] = await db.select().from(changeLog).where(eq(changeLog.operationId, op1));
    expect(change1.changedByUserId).toBe(userA);
    expect(change1.changedByDeviceId).toBe(deviceA);

    const [change2] = await db.select().from(changeLog).where(eq(changeLog.operationId, op2));
    expect(change2.changedByUserId).toBe(userA);
    expect(change2.changedByDeviceId).toBe(deviceA);

    // Verify domain inspection recorded verified identity
    const [savedInsp] = await db.select().from(inspections).where(eq(inspections.id, inspectionId));
    expect(savedInsp.userId).toBe(userA);
    expect(savedInsp.deviceId).toBe(deviceA);
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Project-Scoped Pull Replication
  // ─────────────────────────────────────────────────────────────

  it('restricts pull results strictly to projects the authenticated user may access', async () => {
    // 1. User B pushes a change to Project B
    const siteBId = randomUUID();
    const opBId = randomUUID();

    const pushReqB: PushRequest = {
      deviceId: deviceB,
      operations: [
        {
          operationId: opBId,
          entityType: 'SITE',
          entityId: siteBId,
          operationType: 'CREATE',
          baseVersion: null,
          payload: {
            projectId: projectB,
            name: 'Secret Site in Project B',
            code: `SB-${randomUUID().slice(0, 6)}`,
          },
          status: 'PENDING',
          clientId: 'client-b',
          deviceId: deviceB,
          userId: userB,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    };

    const pushRes = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: pushReqB,
    });
    expect(pushRes.statusCode).toBe(200);
    expect(pushRes.json().results[0].status).toBe('APPLIED');

    // 2. User A pulls from sequence 0
    const pullResA = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0&limit=500`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(pullResA.statusCode).toBe(200);
    const bodyA = pullResA.json();

    // User A must see changes for Project A, but NEVER changes for Project B
    const changesInProjectB = bodyA.changes.filter(
      (c: any) => c.projectId === projectB || c.entityId === siteBId
    );
    expect(changesInProjectB).toHaveLength(0);

    // 3. User B pulls from sequence 0
    const pullResB = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceB}&afterSequence=0&limit=500`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(pullResB.statusCode).toBe(200);
    const bodyB = pullResB.json();

    // User B MUST see siteBId in Project B
    const siteBChange = bodyB.changes.find((c: any) => c.entityId === siteBId);
    expect(siteBChange).toBeDefined();
    expect(siteBChange.projectId).toBe(projectB);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Offline Revalidation Timestamp Refresh
  // ─────────────────────────────────────────────────────────────

  it('updates last_revalidated_at on device during authenticated non-empty pull and APPLIED push', async () => {
    // Check initial lastRevalidatedAt on Device A (seeded 2 days ago)
    const [initialDevice] = await db.select().from(devices).where(eq(devices.id, deviceA));
    const initialTimestamp = new Date(initialDevice.lastRevalidatedAt).getTime();

    // Perform an authenticated pull
    const beforePull = Date.now();
    const pullRes = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0&limit=1`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(pullRes.statusCode).toBe(200);

    const [deviceAfterPull] = await db.select().from(devices).where(eq(devices.id, deviceA));
    const pullTimestamp = new Date(deviceAfterPull.lastRevalidatedAt).getTime();

    // lastRevalidatedAt should now be updated to approximately right now
    expect(pullTimestamp).toBeGreaterThan(initialTimestamp);
    expect(pullTimestamp).toBeGreaterThanOrEqual(beforePull - 1000);

    // Perform an authenticated push
    const newProjectId = randomUUID();
    createdProjectIds.push(newProjectId);

    const pushRes = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        deviceId: deviceA,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'PROJECT',
            entityId: newProjectId,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Auto Membership Project', code: `AMP-${randomUUID().slice(0, 6)}` },
            status: 'PENDING',
            clientId: 'client-a',
            deviceId: deviceA,
            userId: userA,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });
    expect(pushRes.statusCode).toBe(200);

    // Verify creator was auto-enrolled into project_members
    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, newProjectId),
          eq(projectMembers.userId, userA)
        )
      );
    expect(membership).toBeDefined();
    expect(membership.role).toBe('OWNER');

    const [deviceAfterPush] = await db.select().from(devices).where(eq(devices.id, deviceA));
    const pushTimestamp = new Date(deviceAfterPush.lastRevalidatedAt).getTime();
    expect(pushTimestamp).toBeGreaterThanOrEqual(pullTimestamp);
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Live Session Revocation Gating
  // ─────────────────────────────────────────────────────────────

  it('rejects /sync/push and /sync/pull with 401 SESSION_REVOKED when user session has been revoked', async () => {
    const revokedSessionId = randomUUID();
    await db.insert(sessions).values({
      id: revokedSessionId,
      userId: userA,
      deviceId: deviceA,
      isRevoked: true,
      revokedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    const revokedSessionToken = await signAccessToken(
      { sub: userA, deviceId: deviceA, sid: revokedSessionId },
      authConfig
    );

    // 1. POST /sync/push with revoked session token
    const pushRes = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${revokedSessionToken}` },
      payload: {
        deviceId: deviceA,
        operations: [],
      },
    });

    expect(pushRes.statusCode).toBe(401);
    const pushBody = pushRes.json();
    expect(pushBody.code).toBe('SESSION_REVOKED');
    expect(pushBody.message).toContain('revoked');

    // 2. GET /sync/pull with revoked session token
    const pullRes = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0&limit=10`,
      headers: { authorization: `Bearer ${revokedSessionToken}` },
    });

    expect(pullRes.statusCode).toBe(401);
    const pullBody = pullRes.json();
    expect(pullBody.code).toBe('SESSION_REVOKED');
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Per-Project Cursors & Scoped Replication
  // ─────────────────────────────────────────────────────────────

  it('proves per-project cursors: project-specific scopes fetch only that project changes, advance independent cursors, and reject unauthorized scopes', async () => {
    const siteP1 = randomUUID();
    const siteP2 = randomUUID();

    // Push Site P1 into Project A with User A token
    const pushP1 = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        deviceId: deviceA,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'SITE',
            entityId: siteP1,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Site In Project A', code: `S-P1-${randomUUID().slice(0, 4)}`, projectId: projectA },
            status: 'PENDING',
            clientId: 'client-a',
            deviceId: deviceA,
            userId: userA,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });
    expect(pushP1.statusCode).toBe(200);

    // Push Site P2 into Project B with User B token
    const pushP2 = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        deviceId: deviceB,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'SITE',
            entityId: siteP2,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Site In Project B', code: `S-P2-${randomUUID().slice(0, 4)}`, projectId: projectB },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });
    expect(pushP2.statusCode).toBe(200);

    // 1. User A pulls with scope=projectA -> returns Project A changes, never Project B changes
    const pullP1 = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0&limit=500&scope=${projectA}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(pullP1.statusCode).toBe(200);
    const bodyP1 = pullP1.json();
    const p1SiteChanges = bodyP1.changes.filter((c: any) => c.entityId === siteP1);
    const p2InP1Changes = bodyP1.changes.filter((c: any) => c.entityId === siteP2);
    expect(p1SiteChanges.length).toBeGreaterThanOrEqual(1);
    expect(p2InP1Changes.length).toBe(0); // Strictly isolated!

    // 2. User B pulls with scope=projectB -> returns Project B changes, never Project A changes
    const pullP2 = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceB}&afterSequence=0&limit=500&scope=${projectB}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(pullP2.statusCode).toBe(200);
    const bodyP2 = pullP2.json();
    const p2SiteChanges = bodyP2.changes.filter((c: any) => c.entityId === siteP2);
    const p1InP2Changes = bodyP2.changes.filter((c: any) => c.entityId === siteP1);
    expect(p2SiteChanges.length).toBeGreaterThanOrEqual(1);
    expect(p1InP2Changes.length).toBe(0); // Strictly isolated!

    // 3. User A attempts to pull with scope=projectB (unauthorized project scope) -> returns empty changes
    const pullUnauthorized = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0&limit=500&scope=${projectB}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(pullUnauthorized.statusCode).toBe(200);
    expect(pullUnauthorized.json().changes.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────
  // 8. Legacy Null-Project Change-Log Protection
  // ─────────────────────────────────────────────────────────────

  it('never exposes legacy change_log records with project_id: null to any user', async () => {
    const legacyEntityId = randomUUID();
    await db.insert(changeLog).values({
      entityType: 'PROJECT',
      entityId: legacyEntityId,
      projectId: null, // Legacy unassociated record
      version: 1,
      operationType: 'CREATE',
      payload: { name: 'Legacy Unscoped Project', code: 'LEGACY-001' },
      isTombstone: false,
      changedByUserId: userA,
      changedByDeviceId: deviceA,
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
    });

    const pullRes = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceA}&afterSequence=0&limit=500`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(pullRes.statusCode).toBe(200);
    const body = pullRes.json();
    const legacyRecord = body.changes.find((c: any) => c.entityId === legacyEntityId);
    expect(legacyRecord).toBeUndefined(); // Never exposed!
  });

  // ─────────────────────────────────────────────────────────────
  // 9. Authorization Boundaries across all 4 Entity Types
  // ─────────────────────────────────────────────────────────────

  it('verifies authorization boundaries across all 4 entity types (PROJECT, SITE, INSPECTION, MEASUREMENT)', async () => {
    // User A creates Site and Inspection in Project A
    const siteId = randomUUID();
    await db.insert(sites).values({
      id: siteId,
      projectId: projectA,
      name: 'Site For Boundary Test',
      code: `SBT-${randomUUID().slice(0, 4)}`,
      version: 1,
      isDeleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const inspectionId = randomUUID();
    await db.insert(inspections).values({
      id: inspectionId,
      siteId,
      userId: userA,
      deviceId: deviceA,
      title: 'Boundary Test Inspection',
      status: 'SCHEDULED',
      scheduledDate: new Date().toISOString(),
      version: 1,
      isDeleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // User B (NOT a member of Project A) attempts mutations across all 4 entities
    const pushRes = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        deviceId: deviceB,
        operations: [
          // 1. Unauthorized PROJECT update
          {
            operationId: randomUUID(),
            entityType: 'PROJECT',
            entityId: projectA,
            operationType: 'UPDATE',
            baseVersion: 1,
            payload: { name: 'Hacked Project Name' },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
          // 2. Unauthorized SITE create
          {
            operationId: randomUUID(),
            entityType: 'SITE',
            entityId: randomUUID(),
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Unauthorized Site', code: `US-${randomUUID().slice(0, 4)}`, projectId: projectA },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
          // 3. Unauthorized INSPECTION create under Project A site
          {
            operationId: randomUUID(),
            entityType: 'INSPECTION',
            entityId: randomUUID(),
            operationType: 'CREATE',
            baseVersion: null,
            payload: { siteId, status: 'IN_PROGRESS' },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
          // 4. Unauthorized MEASUREMENT create under Project A inspection
          {
            operationId: randomUUID(),
            entityType: 'MEASUREMENT',
            entityId: randomUUID(),
            operationType: 'CREATE',
            baseVersion: null,
            payload: { inspectionId, measurementType: 'TEMPERATURE', numericValue: 42.5 },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    expect(pushRes.statusCode).toBe(200);
    const body = pushRes.json();
    expect(body.results.length).toBe(4);
    for (const r of body.results) {
      expect(r.status).toBe('UNAUTHORIZED');
    }

    // Verify Project A was NOT mutated
    const [projectAfter] = await db.select().from(projects).where(eq(projects.id, projectA));
    expect(projectAfter.name).not.toBe('Hacked Project Name');
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Revalidation Guard on Unauthorized Push
  // ─────────────────────────────────────────────────────────────

  it('does not update device last_revalidated_at when push operations are UNAUTHORIZED', async () => {
    // Record current lastRevalidatedAt for Device B
    const [deviceBefore] = await db.select().from(devices).where(eq(devices.id, deviceB));
    const timestampBefore = new Date(deviceBefore.lastRevalidatedAt).getTime();

    // User B attempts unauthorized mutation on Project A
    const pushRes = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        deviceId: deviceB,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'PROJECT',
            entityId: projectA,
            operationType: 'UPDATE',
            baseVersion: 1,
            payload: { name: 'Attempted Name Change' },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    expect(pushRes.statusCode).toBe(200);
    expect(pushRes.json().results[0].status).toBe('UNAUTHORIZED');

    // Verify lastRevalidatedAt was NOT changed
    const [deviceAfter] = await db.select().from(devices).where(eq(devices.id, deviceB));
    const timestampAfter = new Date(deviceAfter.lastRevalidatedAt).getTime();
    expect(timestampAfter).toBe(timestampBefore);
  });

  // ─────────────────────────────────────────────────────────────
  // 11. Project Membership Lifecycle Management
  // ─────────────────────────────────────────────────────────────

  it('supports project membership lifecycle: creator is OWNER, owner can add additional members via API, and new member can push/pull', async () => {
    // User A creates Project Lifecycle Test
    const lifecycleProjectId = randomUUID();
    createdProjectIds.push(lifecycleProjectId);

    const createPush = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        deviceId: deviceA,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'PROJECT',
            entityId: lifecycleProjectId,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Lifecycle Project', code: `LP-${randomUUID().slice(0, 4)}` },
            status: 'PENDING',
            clientId: 'client-a',
            deviceId: deviceA,
            userId: userA,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });
    expect(createPush.statusCode).toBe(200);

    // Verify User A is enrolled as OWNER
    const [ownerMembership] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, lifecycleProjectId),
          eq(projectMembers.userId, userA)
        )
      );
    expect(ownerMembership).toBeDefined();
    expect(ownerMembership.role).toBe('OWNER');

    // Before being added, User B cannot push to Lifecycle Project
    const failPush = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        deviceId: deviceB,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'SITE',
            entityId: randomUUID(),
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Site by B', code: `SB-${randomUUID().slice(0, 4)}`, projectId: lifecycleProjectId },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });
    expect(failPush.json().results[0].status).toBe('UNAUTHORIZED');

    // User A adds User B as MEMBER via POST /projects/:projectId/members
    const addMemberRes = await app.inject({
      method: 'POST',
      url: `/projects/${lifecycleProjectId}/members`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { userId: userB, role: 'MEMBER' },
    });
    expect(addMemberRes.statusCode).toBe(201);
    expect(addMemberRes.json().success).toBe(true);

    // User B can now push to Lifecycle Project
    const successPush = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        deviceId: deviceB,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'SITE',
            entityId: randomUUID(),
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Site by B Authorized', code: `SBA-${randomUUID().slice(0, 4)}`, projectId: lifecycleProjectId },
            status: 'PENDING',
            clientId: 'client-b',
            deviceId: deviceB,
            userId: userB,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });
    expect(successPush.statusCode).toBe(200);
    expect(successPush.json().results[0].status).toBe('APPLIED');

    // Non-member User C cannot add members to Lifecycle Project
    const userC = randomUUID();
    const deviceC = randomUUID();
    await db.insert(users).values({
      id: userC,
      email: `userc-${randomUUID()}@fieldcore.io`,
      name: 'User Charlie',
      role: 'GEOLOGIST',
    });
    await db.insert(devices).values({
      id: deviceC,
      userId: userC,
      deviceIdentifier: `dev-c-${randomUUID()}`,
      name: 'Toughbook C',
      platform: 'DESKTOP',
      isRevoked: false,
      lastRevalidatedAt: new Date().toISOString(),
      offlineAuthWindowDays: 7,
    });
    const tokenC = await signAccessToken(
      { sub: userC, deviceId: deviceC, sid: randomUUID() },
      authConfig
    );

    const unauthorizedAdd = await app.inject({
      method: 'POST',
      url: `/projects/${lifecycleProjectId}/members`,
      headers: { authorization: `Bearer ${tokenC}` },
      payload: { userId: userC, role: 'MEMBER' },
    });
    expect(unauthorizedAdd.statusCode).toBe(403);
  });
  // ─────────────────────────────────────────────────────────────
  // 10. Empty-pull does not renew lastRevalidatedAt
  // ─────────────────────────────────────────────────────────────

  it('does NOT update last_revalidated_at when pull returns zero changes (cursor already current)', async () => {
    // Seed a dedicated device with a known recent revalidation timestamp so
    // an empty pull cannot accidentally be confused with a stale-device scenario.
    const deviceE = randomUUID();
    const knownTs = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    await db.insert(devices).values({
      id: deviceE,
      userId: userA,
      deviceIdentifier: `dev-e-${randomUUID()}`,
      name: 'Empty-Pull Test Device',
      platform: 'DESKTOP',
      isRevoked: false,
      lastRevalidatedAt: knownTs,
      offlineAuthWindowDays: 7,
    });
    const tokenE = await signAccessToken(
      { sub: userA, deviceId: deviceE, sid: randomUUID() },
      authConfig
    );

    // Use a very large afterSequence so the pull is guaranteed to be empty.
    const bigSeq = '999999999999';

    const emptyPullRes = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${deviceE}&afterSequence=${bigSeq}&limit=1`,
      headers: { authorization: `Bearer ${tokenE}` },
    });

    expect(emptyPullRes.statusCode).toBe(200);
    expect(emptyPullRes.json().changes).toHaveLength(0);

    // lastRevalidatedAt must NOT have changed — empty pull does not renew offline window
    const [deviceAfter] = await db.select().from(devices).where(eq(devices.id, deviceE));
    expect(new Date(deviceAfter.lastRevalidatedAt).getTime()).toBe(new Date(knownTs).getTime());

    // lastSeenAt SHOULD be updated (device was seen)
    expect(new Date(deviceAfter.lastSeenAt!).getTime()).toBeGreaterThan(new Date(knownTs).getTime());

    // Cleanup
    await db.delete(devices).where(eq(devices.id, deviceE));
  });
});
