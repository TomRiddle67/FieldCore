import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createDatabaseClient,
  type Database,
  users,
  devices,
  projects,
  changeLog,
  idempotencyRecords,
  conflicts,
} from '@fieldcore/database';
import { createServer } from '../server.js';
import { processPushRequest } from '../push-handler.js';
import type { PushRequest, SyncOperation } from '@fieldcore/types';

describe('Server Push Synchronization Engine', () => {
  const dbUrl = 'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';
  const { db, client } = createDatabaseClient(dbUrl);
  const app = createServer({ db });

  const testUserId = randomUUID();
  const testDeviceId = randomUUID();
  const revokedDeviceId = randomUUID();
  const expiredDeviceId = randomUUID();

  beforeAll(async () => {
    // Seed user and devices
    await db.insert(users).values({
      id: testUserId,
      email: `test-user-${randomUUID()}@fieldcore.io`,
      name: 'Sync Field Engineer',
      role: 'GEOLOGIST',
    });

    await db.insert(devices).values([
      {
        id: testDeviceId,
        userId: testUserId,
        deviceIdentifier: `dev-${randomUUID()}`,
        name: 'Field Toughbook 1',
        platform: 'DESKTOP',
        isRevoked: false,
        lastRevalidatedAt: new Date().toISOString(),
        offlineAuthWindowDays: 7,
      },
      {
        id: revokedDeviceId,
        userId: testUserId,
        deviceIdentifier: `revoked-${randomUUID()}`,
        name: 'Compromised Device',
        platform: 'DESKTOP',
        isRevoked: true,
        revokedReason: 'Lost in the field',
        lastRevalidatedAt: new Date().toISOString(),
      },
      {
        id: expiredDeviceId,
        userId: testUserId,
        deviceIdentifier: `expired-${randomUUID()}`,
        name: 'Expired Auth Device',
        platform: 'DESKTOP',
        isRevoked: false,
        // Set lastRevalidatedAt to 10 days ago (window is 7 days)
        lastRevalidatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        offlineAuthWindowDays: 7,
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it('applies CREATE operation, writes to domain table, change_log, and idempotency_records', async () => {
    const projectId = randomUUID();
    const operationId = randomUUID();

    const pushReq: PushRequest = {
      deviceId: testDeviceId,
      operations: [
        {
          operationId,
          entityType: 'PROJECT',
          entityId: projectId,
          operationType: 'CREATE',
          baseVersion: null,
          payload: {
            name: 'Gold Exploration Area A',
            code: `GEA-${randomUUID().slice(0, 8)}`,
            status: 'ACTIVE',
          },
          status: 'PENDING',
          clientId: 'client-1',
          deviceId: testDeviceId,
          userId: testUserId,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    };

    const response = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: pushReq,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe('APPLIED');
    expect(body.results[0].version).toBe(1);
    expect(typeof body.results[0].sequence).toBe('number');

    // Verify domain table record exists
    const [savedProject] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(savedProject).toBeDefined();
    expect(savedProject.version).toBe(1);
    expect(savedProject.name).toBe('Gold Exploration Area A');

    // Verify change_log has entry
    const [change] = await db.select().from(changeLog).where(eq(changeLog.operationId, operationId));
    expect(change).toBeDefined();
    expect(change.operationType).toBe('CREATE');
    expect(change.version).toBe(1);

    // Verify idempotency record exists
    const [idempotency] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.operationId, operationId));
    expect(idempotency).toBeDefined();
    expect(idempotency.status).toBe('APPLIED');
  });

  it('replays cached response for duplicate delivery of same operationId without duplicate writes', async () => {
    const projectId = randomUUID();
    const operationId = randomUUID();

    const pushReq: PushRequest = {
      deviceId: testDeviceId,
      operations: [
        {
          operationId,
          entityType: 'PROJECT',
          entityId: projectId,
          operationType: 'CREATE',
          baseVersion: null,
          payload: {
            name: 'Duplicate Test Project',
            code: `DTP-${randomUUID().slice(0, 8)}`,
            status: 'ACTIVE',
          },
          status: 'PENDING',
          clientId: 'client-1',
          deviceId: testDeviceId,
          userId: testUserId,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    };

    // First push
    const res1 = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: pushReq,
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.results[0].status).toBe('APPLIED');

    // Count change_log entries before second push
    const changesBefore = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.operationId, operationId));
    expect(changesBefore).toHaveLength(1);

    // Second push with same operationId (duplicate delivery)
    const res2 = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: pushReq,
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.results[0]).toEqual(body1.results[0]);

    // Verify zero additional change_log entries
    const changesAfter = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.operationId, operationId));
    expect(changesAfter).toHaveLength(1);
  });

  it('detects EDIT_EDIT conflict on version mismatch during UPDATE', async () => {
    const projectId = randomUUID();
    const createOpId = randomUUID();

    // 1. Create initial project
    await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: testDeviceId,
        operations: [
          {
            operationId: createOpId,
            entityType: 'PROJECT',
            entityId: projectId,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Initial Name', code: `CONF-${randomUUID().slice(0, 8)}` },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: testDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    // 2. Server updates to version 2
    await db.update(projects).set({ version: 2, name: 'Server Updated Name' }).where(eq(projects.id, projectId));

    // 3. Client tries to update based on stale version 1
    const staleUpdateOpId = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: testDeviceId,
        operations: [
          {
            operationId: staleUpdateOpId,
            entityType: 'PROJECT',
            entityId: projectId,
            operationType: 'UPDATE',
            baseVersion: 1, // Stale! Server is version 2
            payload: { name: 'Client Stale Update' },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: testDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].status).toBe('CONFLICT');
    expect(body.results[0].conflict.conflictType).toBe('EDIT_EDIT');
    expect(body.results[0].conflict.serverVersion).toBe(2);
    expect(body.results[0].conflict.clientVersion).toBe(1);
    expect(body.results[0].conflict.serverState.name).toBe('Server Updated Name');
    expect(body.results[0].conflict.status).toBe('PENDING');

    // Verify row was NOT overwritten
    const [current] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(current.name).toBe('Server Updated Name');
    expect(current.version).toBe(2);
  });

  it('detects EDIT_DELETE conflict on UPDATE against soft-deleted row and auto-resolves KEEP_SERVER', async () => {
    const projectId = randomUUID();
    const createOpId = randomUUID();

    // 1. Create project
    await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: testDeviceId,
        operations: [
          {
            operationId: createOpId,
            entityType: 'PROJECT',
            entityId: projectId,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'To Be Deleted', code: `DEL-${randomUUID().slice(0, 8)}` },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: testDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    // 2. Soft-delete project on server
    await db
      .update(projects)
      .set({ isDeleted: true, deletedAt: new Date().toISOString(), version: 2 })
      .where(eq(projects.id, projectId));

    // 3. Client attempts UPDATE on deleted project
    const updateOpId = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: testDeviceId,
        operations: [
          {
            operationId: updateOpId,
            entityType: 'PROJECT',
            entityId: projectId,
            operationType: 'UPDATE',
            baseVersion: 1,
            payload: { name: 'Attempted Revive' },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: testDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].status).toBe('CONFLICT');
    expect(body.results[0].conflict.conflictType).toBe('EDIT_DELETE');
    expect(body.results[0].conflict.status).toBe('RESOLVED');
    expect(body.results[0].conflict.resolution).toBe('KEEP_SERVER');
    expect(body.results[0].conflict.resolvedByUserId).toBeNull();
    expect(body.results[0].conflict.serverState).toBeNull();
  });

  it('maps CREATE collision on entityId to EDIT_EDIT conflict instead of unhandled DB error', async () => {
    const projectId = randomUUID();
    const op1 = randomUUID();
    const op2 = randomUUID();

    // 1. Initial CREATE
    await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: testDeviceId,
        operations: [
          {
            operationId: op1,
            entityType: 'PROJECT',
            entityId: projectId,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Original Entity', code: `COL1-${randomUUID().slice(0, 8)}` },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: testDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    // 2. Second CREATE with DIFFERENT operationId but SAME entityId
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: testDeviceId,
        operations: [
          {
            operationId: op2,
            entityType: 'PROJECT',
            entityId: projectId,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Colliding Entity', code: `COL2-${randomUUID().slice(0, 8)}` },
            status: 'PENDING',
            clientId: 'client-2',
            deviceId: testDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].status).toBe('CONFLICT');
    expect(body.results[0].conflict.conflictType).toBe('EDIT_EDIT');
    expect(body.results[0].conflict.serverState.name).toBe('Original Entity');
  });

  it('evaluates partial batch failure independently: op 2 conflict does not block ops 1 and 3', async () => {
    const p1 = randomUUID();
    const p2 = randomUUID();
    const p3 = randomUUID();

    // Seed p2 on server at version 2 so op 2 conflicts
    await db.insert(projects).values({
      id: p2,
      name: 'Existing P2',
      code: `PART-${randomUUID().slice(0, 8)}`,
      version: 2,
    });

    const batchReq: PushRequest = {
      deviceId: testDeviceId,
      operations: [
        {
          operationId: randomUUID(),
          entityType: 'PROJECT',
          entityId: p1,
          operationType: 'CREATE',
          baseVersion: null,
          payload: { name: 'Batch P1', code: `BP1-${randomUUID().slice(0, 8)}` },
          status: 'PENDING',
          clientId: 'client-1',
          deviceId: testDeviceId,
          userId: testUserId,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
        {
          operationId: randomUUID(),
          entityType: 'PROJECT',
          entityId: p2,
          operationType: 'UPDATE',
          baseVersion: 1, // Stale! Server is at 2
          payload: { name: 'Batch P2 Stale Update' },
          status: 'PENDING',
          clientId: 'client-1',
          deviceId: testDeviceId,
          userId: testUserId,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
        {
          operationId: randomUUID(),
          entityType: 'PROJECT',
          entityId: p3,
          operationType: 'CREATE',
          baseVersion: null,
          payload: { name: 'Batch P3', code: `BP3-${randomUUID().slice(0, 8)}` },
          status: 'PENDING',
          clientId: 'client-1',
          deviceId: testDeviceId,
          userId: testUserId,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: batchReq,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results[0].status).toBe('APPLIED');
    expect(body.results[1].status).toBe('CONFLICT');
    expect(body.results[2].status).toBe('APPLIED');

    // Verify p1 and p3 are created in Postgres
    const [savedP1] = await db.select().from(projects).where(eq(projects.id, p1));
    const [savedP3] = await db.select().from(projects).where(eq(projects.id, p3));
    expect(savedP1).toBeDefined();
    expect(savedP3).toBeDefined();

    // Verify p2 remains at version 2
    const [savedP2] = await db.select().from(projects).where(eq(projects.id, p2));
    expect(savedP2.version).toBe(2);
    expect(savedP2.name).toBe('Existing P2');
  });

  it('rejects batch immediately with DEVICE_REVOKED for revoked device', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: revokedDeviceId,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'PROJECT',
            entityId: randomUUID(),
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Revoked Attempt', code: 'REV-1' },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: revokedDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].status).toBe('DEVICE_REVOKED');
    expect(body.results[0].error).toBe('Lost in the field');
  });

  it('returns REQUIRES_REVALIDATION for all operations when device offline auth window expired', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: {
        deviceId: expiredDeviceId,
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'PROJECT',
            entityId: randomUUID(),
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'Expired Attempt', code: 'EXP-1' },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: expiredDeviceId,
            userId: testUserId,
            createdAt: new Date().toISOString(),
            retryCount: 0,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].status).toBe('REQUIRES_REVALIDATION');
  });

  it('handles concurrent identical operation delivery: DB constraint catches 23505 race and returns committed payload without double application', async () => {
    const projectId = randomUUID();
    const operationId = randomUUID();

    const operation = {
      operationId,
      entityType: 'PROJECT' as const,
      entityId: projectId,
      operationType: 'CREATE' as const,
      baseVersion: null,
      payload: {
        name: 'Concurrent Race Project',
        code: `RACE-${randomUUID().slice(0, 8)}`,
        status: 'ACTIVE',
      },
      status: 'PENDING' as const,
      clientId: 'client-1',
      deviceId: testDeviceId,
      userId: testUserId,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };

    // Spy to prove the 23505 catch branch fired, not just that the outcome looks correct.
    // The spy is incremented inside the uniqueness-violation catch block — the only way
    // it can reach 1 is if both requests passed the pre-transaction fast-path SELECT
    // simultaneously, one committed, and the other hit the PRIMARY KEY constraint.
    const constraintRaceSpy = vi.fn();

    // In a single-process test, Node.js's event loop would serialize the fast-path SELECT
    // so the second request is deduplicated before entering a transaction — making the 23505
    // path unreachable. skipFastPathForOperationIds bypasses it for this operationId,
    // forcing both concurrent calls into the transaction path where the PRIMARY KEY constraint
    // is the actual enforcer. In production this bypass is always undefined.
    const skipFastPath = new Set([operationId]);

    // Call processPushRequest directly (bypassing Fastify inject) so we can inject the spy.
    // Both requests carry the same operationId — a legitimate crash-retry race.
    const [res1, res2] = await Promise.all([
      processPushRequest({
        db,
        request: { deviceId: testDeviceId, operations: [operation] },
        onIdempotencyConstraintRace: constraintRaceSpy,
        skipFastPathForOperationIds: skipFastPath,
      }),
      processPushRequest({
        db,
        request: { deviceId: testDeviceId, operations: [operation] },
        onIdempotencyConstraintRace: constraintRaceSpy,
        skipFastPathForOperationIds: skipFastPath,
      }),
    ]);

    // Both responses report APPLIED with identical version and sequence
    expect(res1.results[0].status).toBe('APPLIED');
    expect(res2.results[0].status).toBe('APPLIED');
    expect(res1.results[0].sequence).toBe(res2.results[0].sequence);
    expect(res1.results[0].version).toBe(res2.results[0].version);

    // MECHANISM PROVEN: the constraint catch branch fired exactly once —
    // confirming that one request lost the DB race and was recovered via 23505,
    // not that both happened to serialize by chance through some other code path.
    expect(constraintRaceSpy).toHaveBeenCalledTimes(1);

    // Assert change_log has exactly 1 entry for this operationId
    const changes = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.operationId, operationId));
    expect(changes).toHaveLength(1);

    // Assert idempotency_records has exactly 1 record
    const records = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.operationId, operationId));
    expect(records).toHaveLength(1);
  });
});
