import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
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
import { FieldCoreDexie, PushSyncService, ProjectRepository, type PushTransport } from '@fieldcore/sync';
import { createServer } from '../server.js';
import type { PushRequest, PushResponse } from '@fieldcore/types';

describe('Stage 3 Adversarial Push Sync Suite', () => {
  const dbUrl = 'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';
  const { db, client } = createDatabaseClient(dbUrl);
  const app = createServer({ db });

  let dexieDb: FieldCoreDexie;
  let pushService: PushSyncService;
  let projectRepo: ProjectRepository;

  const testUserId = randomUUID();
  const testDeviceId = randomUUID();
  const testClientId = 'adversarial-client-1';

  beforeAll(async () => {
    // Seed user and device in Postgres
    await db.insert(users).values({
      id: testUserId,
      email: `adversarial-${randomUUID()}@fieldcore.io`,
      name: 'Adversarial Field Geologist',
      role: 'GEOLOGIST',
    });

    await db.insert(devices).values({
      id: testDeviceId,
      userId: testUserId,
      deviceIdentifier: `adv-device-${randomUUID()}`,
      name: 'Adversarial Toughbook',
      platform: 'DESKTOP',
      isRevoked: false,
      lastRevalidatedAt: new Date().toISOString(),
      offlineAuthWindowDays: 7,
    });
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  beforeEach(async () => {
    dexieDb = new FieldCoreDexie(`adv_dexie_${Date.now()}_${Math.random()}`);
    await dexieDb.open();
    pushService = new PushSyncService(dexieDb);
    projectRepo = new ProjectRepository(dexieDb, {
      userId: testUserId,
      deviceId: testDeviceId,
      clientId: testClientId,
    });
  });

  // End-to-end transport adapter connecting PushSyncService directly to Fastify /sync/push
  const createFastifyTransport = (interceptResponse?: (res: PushResponse) => PushResponse): PushTransport => {
    return async (req: PushRequest): Promise<PushResponse> => {
      const httpRes = await app.inject({
        method: 'POST',
        url: '/sync/push',
        payload: req,
      });

      expect(httpRes.statusCode).toBe(200);
      const json = httpRes.json() as PushResponse;
      return interceptResponse ? interceptResponse(json) : json;
    };
  };

  it('1. Duplicate delivery: same operation delivered twice applies once with zero duplicate change_log rows', async () => {
    // Client creates project offline
    const project = await projectRepo.create({
      name: 'Idempotency Proof Project',
      code: `IDEM-${randomUUID().slice(0, 8)}`,
    });

    const [localOp] = await dexieDb.sync_operations.toArray();
    expect(localOp.status).toBe('PENDING');

    const transport = createFastifyTransport();

    // 1st Push
    const res1 = await pushService.pushBatch(transport);
    expect(res1.appliedCount).toBe(1);

    // Verify Postgres state
    const changes1 = await db.select().from(changeLog).where(eq(changeLog.operationId, localOp.operationId));
    expect(changes1).toHaveLength(1);

    // Reset local operation back to PENDING to simulate client-side retransmission (e.g. lost ACK)
    await dexieDb.sync_operations.where('operationId').equals(localOp.operationId).modify({
      status: 'PENDING',
    });

    // 2nd Push (duplicate delivery)
    const res2 = await pushService.pushBatch(transport);
    expect(res2.appliedCount).toBe(1);

    // Verify Postgres state: ZERO additional change_log rows or duplicate project rows
    const changes2 = await db.select().from(changeLog).where(eq(changeLog.operationId, localOp.operationId));
    expect(changes2).toHaveLength(1);

    const savedProjects = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(savedProjects).toHaveLength(1);
  });

  it('2. Partial batch failure: batch of 5 where op 3 conflicts commits 1-2 & 4-5 and never re-sends acknowledged ops', async () => {
    // Create 5 projects offline
    const p1 = await projectRepo.create({ name: 'Batch 1', code: `B1-${randomUUID().slice(0, 6)}` });
    const p2 = await projectRepo.create({ name: 'Batch 2', code: `B2-${randomUUID().slice(0, 6)}` });
    const p3 = await projectRepo.create({ name: 'Batch 3', code: `B3-${randomUUID().slice(0, 6)}` });
    const p4 = await projectRepo.create({ name: 'Batch 4', code: `B4-${randomUUID().slice(0, 6)}` });
    const p5 = await projectRepo.create({ name: 'Batch 5', code: `B5-${randomUUID().slice(0, 6)}` });

    // Pre-insert p3 on server with a conflicting version to simulate CREATE collision on entityId
    await db.insert(projects).values({
      id: p3.id,
      name: 'Conflicting Server P3',
      code: `SRV-${randomUUID().slice(0, 6)}`,
      version: 5,
    });

    const transport = createFastifyTransport();

    // Push batch of 5
    const batchResult = await pushService.pushBatch(transport, { batchSize: 5 });
    expect(batchResult.pushedCount).toBe(5);
    expect(batchResult.appliedCount).toBe(4);
    expect(batchResult.conflictCount).toBe(1);

    // Check client Dexie states
    const ops = (await dexieDb.sync_operations.toArray()).sort(
      (a, b) => (a.localSeq ?? 0) - (b.localSeq ?? 0)
    );
    expect(ops[0].status).toBe('SYNCED'); // Op 1
    expect(ops[1].status).toBe('SYNCED'); // Op 2
    expect(ops[2].status).toBe('CONFLICT'); // Op 3 (Conflicted!)
    expect(ops[3].status).toBe('SYNCED'); // Op 4
    expect(ops[4].status).toBe('SYNCED'); // Op 5

    // Verify in Postgres: p1, p2, p4, p5 are created
    const [dbP1] = await db.select().from(projects).where(eq(projects.id, p1.id));
    const [dbP2] = await db.select().from(projects).where(eq(projects.id, p2.id));
    const [dbP4] = await db.select().from(projects).where(eq(projects.id, p4.id));
    const [dbP5] = await db.select().from(projects).where(eq(projects.id, p5.id));
    expect(dbP1).toBeDefined();
    expect(dbP2).toBeDefined();
    expect(dbP4).toBeDefined();
    expect(dbP5).toBeDefined();

    // Verify p3 on server was NOT overwritten
    const [dbP3] = await db.select().from(projects).where(eq(projects.id, p3.id));
    expect(dbP3.name).toBe('Conflicting Server P3');
    expect(dbP3.version).toBe(5);

    // Verify subsequent pushBatch() does NOT re-send acknowledged ops 1, 2, 4, 5
    let operationsSentInNextPush = -1;
    const trackingTransport: PushTransport = async (req) => {
      operationsSentInNextPush = req.operations.length;
      return { results: [] };
    };

    const nextBatchResult = await pushService.pushBatch(trackingTransport);
    expect(nextBatchResult.pushedCount).toBe(0);
    expect(operationsSentInNextPush).toBe(-1); // Transport was never even called because pending queue is clean!
  });

  it('3. Stale write conflict: server version mismatch yields CONFLICT without silent overwrite', async () => {
    // 1. Create project offline and push to server
    const project = await projectRepo.create({
      name: 'Original Geological Survey',
      code: `GEO-${randomUUID().slice(0, 6)}`,
    });
    const transport = createFastifyTransport();
    await pushService.pushBatch(transport);

    // 2. Server-side peer updates project to version 2
    await db
      .update(projects)
      .set({ version: 2, name: 'Peer Updated Name From Web' })
      .where(eq(projects.id, project.id));

    // 3. Client attempts update based on stale version 1
    // (We bypass repository's in-memory lock check by directly creating an UPDATE operation with baseVersion 1)
    const staleUpdateOpId = randomUUID();
    await dexieDb.sync_operations.add({
      operationId: staleUpdateOpId,
      entityType: 'PROJECT',
      entityId: project.id,
      operationType: 'UPDATE',
      baseVersion: 1, // Stale! Server is version 2
      payload: { name: 'Client Stale Overwrite Attempt' },
      status: 'PENDING',
      clientId: testClientId,
      deviceId: testDeviceId,
      userId: testUserId,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    const pushResult = await pushService.pushBatch(transport);
    expect(pushResult.conflictCount).toBe(1);

    // Verify client record transitioned to CONFLICT
    const [conflictOp] = await dexieDb.sync_operations.where('operationId').equals(staleUpdateOpId).toArray();
    expect(conflictOp.status).toBe('CONFLICT');

    // Verify conflict record stored locally
    const [localConflict] = await dexieDb.conflicts.toArray();
    expect(localConflict).toBeDefined();
    expect(localConflict.conflictType).toBe('EDIT_EDIT');
    if (localConflict.conflictType === 'EDIT_EDIT') {
      expect(localConflict.serverVersion).toBe(2);
      expect(localConflict.clientVersion).toBe(1);
      expect(localConflict.serverState.name).toBe('Peer Updated Name From Web');
    }

    // Verify server row was NOT overwritten
    const [currentServerRow] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(currentServerRow.name).toBe('Peer Updated Name From Web');
    expect(currentServerRow.version).toBe(2);
  });

  it('4. Interrupted push / crash recovery: process dies after server applies; restart recovers to PENDING and re-push completes with zero duplicate writes', async () => {
    // Client creates project
    const project = await projectRepo.create({
      name: 'Crash Recovery Invariant Project',
      code: `CRASH-${randomUUID().slice(0, 6)}`,
    });
    const [initialOp] = await dexieDb.sync_operations.toArray();

    // Transport executes against server, but simulates process death before client writes ACK to IndexedDB
    let serverCommitted = false;
    const crashTransport: PushTransport = async (req) => {
      const httpRes = await app.inject({
        method: 'POST',
        url: '/sync/push',
        payload: req,
      });
      expect(httpRes.statusCode).toBe(200);
      serverCommitted = true;

      // Simulate crash right now before returning response to pushBatch()
      throw new Error('PROCESS_CRASH_SIMULATION');
    };

    // Client attempts push, which crashes mid-flight
    await pushService.pushBatch(crashTransport);
    expect(serverCommitted).toBe(true);

    // Verify server wrote to Postgres
    const changesBefore = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.operationId, initialOp.operationId));
    expect(changesBefore).toHaveLength(1);

    // Simulate app killed mid-push while status was SYNCING
    await dexieDb.sync_operations.where('operationId').equals(initialOp.operationId).modify({
      status: 'SYNCING',
    });

    // --- APP RESTART CYCLE ---
    // On startup, client runs recoverDanglingSyncingOperations()
    const recovered = await pushService.recoverDanglingSyncingOperations();
    expect(recovered).toBe(1);

    const [recoveredOp] = await dexieDb.sync_operations.where('operationId').equals(initialOp.operationId).toArray();
    expect(recoveredOp.status).toBe('PENDING');

    // Re-push using normal transport
    const normalTransport = createFastifyTransport();
    const resumeResult = await pushService.pushBatch(normalTransport);
    expect(resumeResult.appliedCount).toBe(1);

    // Client operation is now SYNCED
    const [finalOp] = await dexieDb.sync_operations.where('operationId').equals(initialOp.operationId).toArray();
    expect(finalOp.status).toBe('SYNCED');

    // INVARIANT: Exactly 1 change_log entry and 1 project in Postgres (idempotency prevented double application)
    const changesAfter = await db
      .select()
      .from(changeLog)
      .where(eq(changeLog.operationId, initialOp.operationId));
    expect(changesAfter).toHaveLength(1);

    const serverProjects = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(serverProjects).toHaveLength(1);
  });
});
