import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import {
  createDatabaseClient,
  type Database,
  users,
  devices,
  projects,
  changeLog,
  syncCursors,
} from '@fieldcore/database';
import {
  FieldCoreDexie,
  PushSyncService,
  PullSyncService,
  ProjectRepository,
  type PushTransport,
  type PullTransport,
} from '@fieldcore/sync';
import { createServer } from '../server.js';
import type {
  PushRequest,
  PushResponse,
  PullRequest,
  PullResponse,
} from '@fieldcore/types';

describe('Stage 4 Adversarial Pull Sync Suite', () => {
  const dbUrl = 'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';
  const { db, client } = createDatabaseClient(dbUrl);
  const app = createServer({ db });

  let dexieDb: FieldCoreDexie;
  let pushService: PushSyncService;
  let pullService: PullSyncService;
  let projectRepo: ProjectRepository;

  const testUserId = randomUUID();
  const testDeviceId = randomUUID();
  const peerUserId = randomUUID();
  const peerDeviceId = randomUUID();
  const testClientId = 'adversarial-pull-client-1';

  async function getLatestServerSequence(): Promise<string> {
    const rows = await db
      .select({ sequence: changeLog.sequence })
      .from(changeLog)
      .orderBy(desc(changeLog.sequence))
      .limit(1);
    return rows.length > 0 ? String(rows[0].sequence) : '0';
  }

  beforeAll(async () => {
    await db.insert(users).values([
      {
        id: testUserId,
        email: `adv-pull-${randomUUID()}@fieldcore.io`,
        name: 'Adversarial Pull Geologist',
        role: 'GEOLOGIST',
      },
      {
        id: peerUserId,
        email: `adv-peer-${randomUUID()}@fieldcore.io`,
        name: 'Peer Remote Geologist',
        role: 'GEOLOGIST',
      },
    ]);

    await db.insert(devices).values([
      {
        id: testDeviceId,
        userId: testUserId,
        deviceIdentifier: `adv-pull-dev-${randomUUID()}`,
        name: 'Adversarial Pull Toughbook',
        platform: 'DESKTOP',
        isRevoked: false,
        lastRevalidatedAt: new Date().toISOString(),
        offlineAuthWindowDays: 7,
      },
      {
        id: peerDeviceId,
        userId: peerUserId,
        deviceIdentifier: `adv-peer-dev-${randomUUID()}`,
        name: 'Peer Toughbook',
        platform: 'DESKTOP',
        isRevoked: false,
        lastRevalidatedAt: new Date().toISOString(),
        offlineAuthWindowDays: 7,
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  beforeEach(async () => {
    dexieDb = new FieldCoreDexie(`adv_pull_dexie_${Date.now()}_${Math.random()}`);
    await dexieDb.open();
    pushService = new PushSyncService(dexieDb);
    pullService = new PullSyncService(dexieDb);
    projectRepo = new ProjectRepository(dexieDb, {
      userId: testUserId,
      deviceId: testDeviceId,
      clientId: testClientId,
    });
  });

  // End-to-end transport adapter connecting PullSyncService directly to Fastify GET /sync/pull
  const createFastifyPullTransport = (): PullTransport => {
    return async (req: PullRequest): Promise<PullResponse> => {
      const httpRes = await app.inject({
        method: 'GET',
        url: `/sync/pull?deviceId=${req.deviceId}&afterSequence=${req.afterSequence}&limit=${req.limit ?? 100}`,
      });

      expect(httpRes.statusCode).toBe(200);
      return httpRes.json() as PullResponse;
    };
  };

  // End-to-end transport adapter connecting PushSyncService directly to Fastify POST /sync/push
  const createFastifyPushTransport = (): PushTransport => {
    return async (req: PushRequest): Promise<PushResponse> => {
      const httpRes = await app.inject({
        method: 'POST',
        url: '/sync/push',
        payload: req,
      });

      expect(httpRes.statusCode).toBe(200);
      return httpRes.json() as PushResponse;
    };
  };

  it('1. Crash after apply, before cursor write: atomicity rollback leaves cursor at prior value; re-pull applies with zero duplicates', async () => {
    const startSeq = await getLatestServerSequence();

    // 1. Seed two project rows on server via push
    const p1 = await projectRepo.create({ name: 'Crash Test Project 1', code: `CP1-${randomUUID().slice(0, 6)}` });
    const p2 = await projectRepo.create({ name: 'Crash Test Project 2', code: `CP2-${randomUUID().slice(0, 6)}` });

    const pushTransport = createFastifyPushTransport();
    await pushService.pushBatch(pushTransport);

    // 2. Wipe client Dexie to simulate a new device pulling from startSeq
    await dexieDb.delete();
    dexieDb = new FieldCoreDexie(`adv_pull_crash_recovery_${Date.now()}_${Math.random()}`);
    await dexieDb.open();
    pullService = new PullSyncService(dexieDb);

    await dexieDb.pull_cursors.put({
      scope: 'default',
      lastServerSequence: startSeq,
      updatedAt: new Date().toISOString(),
    });

    const pullTransport = createFastifyPullTransport();

    // 3. Simulate crash right before cursor write commit inside Dexie transaction
    const originalPut = dexieDb.pull_cursors.put.bind(dexieDb.pull_cursors);
    vi.spyOn(dexieDb.pull_cursors, 'put').mockImplementation((() => {
      throw new Error('Simulated process kill right before cursor write');
    }) as any);

    await expect(
      pullService.pullBatch(pullTransport, { deviceId: testDeviceId })
    ).rejects.toThrow('Simulated process kill right before cursor write');

    // Verify atomic rollback: cursor stays at startSeq, no projects were committed in Dexie
    const cursorAfterCrash = await pullService.getLocalCursor();
    expect(cursorAfterCrash).toBe(startSeq);

    const projectsAfterCrash = await dexieDb.projects.toArray();
    expect(projectsAfterCrash).toHaveLength(0);

    // 4. Restore normal cursor put behavior and re-pull
    vi.restoreAllMocks();

    const rePullResult = await pullService.pullBatch(pullTransport, { deviceId: testDeviceId });
    expect(rePullResult.changesApplied).toBe(2);

    // Verify zero duplicates and exact version
    const p1InDexie = await dexieDb.projects.get(p1.id);
    const p2InDexie = await dexieDb.projects.get(p2.id);
    expect(p1InDexie).toBeDefined();
    expect(p2InDexie).toBeDefined();
    expect(p1InDexie?.version).toBe(1);
    expect(p2InDexie?.version).toBe(1);

    // Second re-pull with same startSeq (simulating re-delivery from startSeq)
    await dexieDb.pull_cursors.put({
      scope: 'default',
      lastServerSequence: startSeq,
      updatedAt: new Date().toISOString(),
    });
    const idempotentPull = await pullService.pullBatch(pullTransport, { deviceId: testDeviceId });
    expect(idempotentPull.changesApplied).toBe(0); // Version compare skipped already applied rows

    // Count is strictly 1 per entityId
    const allP1 = (await dexieDb.projects.toArray()).filter((p) => p.id === p1.id);
    expect(allP1).toHaveLength(1);
  });

  it('2. Long-offline drain: seeds 250 change_log rows, drains via 3-page loop, cursor matches page 3 latestSequence', async () => {
    // 1. Get current sequence before seeding
    const pullTransport = createFastifyPullTransport();
    const baseSeq = await getLatestServerSequence();

    // 2. Seed 250 distinct change_log entries in Postgres
    const nowIso = new Date().toISOString();
    const insertedIds: string[] = [];

    for (let i = 0; i < 250; i++) {
      const id = randomUUID();
      insertedIds.push(id);
      await db.insert(changeLog).values({
        entityType: 'PROJECT',
        entityId: id,
        version: 1,
        operationType: 'CREATE',
        payload: {
          id,
          name: `Long Offline Project ${i}`,
          code: `LOP-${i}-${randomUUID().slice(0, 4)}`,
        },
        isTombstone: false,
        changedByUserId: peerUserId,
        changedByDeviceId: peerDeviceId,
        operationId: randomUUID(),
        createdAt: nowIso,
      });
    }

    // 3. Client starts fresh cursor at baseSeq
    await dexieDb.pull_cursors.put({
      scope: 'default',
      lastServerSequence: baseSeq,
      updatedAt: nowIso,
    });

    // 4. Drain via pullAll with limit = 100
    const drainResult = await pullService.pullAll(pullTransport, {
      deviceId: testDeviceId,
      limit: 100,
    });

    // 250 changes at 100/page = 3 pages (100 + 100 + 50)
    expect(drainResult.pagesPulled).toBe(3);
    expect(drainResult.totalApplied).toBe(250);

    const finalCursor = await pullService.getLocalCursor();
    expect(finalCursor).toBe(drainResult.latestSequence);

    // Verify all 250 projects are present in client Dexie
    for (let i = 0; i < 250; i += 50) {
      const row = await dexieDb.projects.get(insertedIds[i]);
      expect(row).toBeDefined();
      expect(row?.name).toBe(`Long Offline Project ${i}`);
    }
  });

  it('3. baseVersion isolation: push CREATE (v1), server peer bumps to v2, client pulls, client queued UPDATE (baseVersion=1) pushes and detects CONFLICT', async () => {
    // 1. Client creates project offline at version 1
    const project = await projectRepo.create({
      name: 'Isolation Test Project',
      code: `ISO-${randomUUID().slice(0, 6)}`,
    });
    expect(project.version).toBe(1);

    const pushTransport = createFastifyPushTransport();
    const pullTransport = createFastifyPullTransport();

    // 2. Initial push succeeds -> server project is at version 1
    const initialPush = await pushService.pushBatch(pushTransport);
    expect(initialPush.appliedCount).toBe(1);

    // Advance client pull cursor to match initial state
    const afterPushSeq = await getLatestServerSequence();
    await dexieDb.pull_cursors.put({
      scope: 'default',
      lastServerSequence: afterPushSeq,
      updatedAt: new Date().toISOString(),
    });

    // 3. Client goes offline and performs local UPDATE -> Dexie record version becomes 2
    // Stored baseVersion in sync_operations is captured as 1
    await projectRepo.update(project.id, {
      name: 'Client Local Edit',
    });

    const [queuedOp] = await dexieDb.sync_operations
      .where('entityId')
      .equals(project.id)
      .filter((op) => op.status === 'PENDING')
      .toArray();

    expect(queuedOp).toBeDefined();
    expect(queuedOp.baseVersion).toBe(1); // Stored baseVersion = 1

    // 4. Concurrently, a peer updates the project on the server to version 2
    const peerNow = new Date().toISOString();
    await db
      .update(projects)
      .set({
        name: 'Peer Remote Edit',
        version: 2,
        updatedAt: peerNow,
      })
      .where(eq(projects.id, project.id));

    await db.insert(changeLog).values({
      entityType: 'PROJECT',
      entityId: project.id,
      version: 2,
      operationType: 'UPDATE',
      payload: { id: project.id, name: 'Peer Remote Edit' },
      isTombstone: false,
      changedByUserId: peerUserId,
      changedByDeviceId: peerDeviceId,
      operationId: randomUUID(),
      createdAt: peerNow,
    });

    // 5. Client performs a pull sync while the local UPDATE is still pending in push queue
    const pullResult = await pullService.pullBatch(pullTransport, { deviceId: testDeviceId });
    // Local version was 2, incoming server version was 2 -> skipped (2 >= 2)
    expect(pullResult.changesApplied).toBe(0);

    // CRITICAL INVARIANT: Stored baseVersion on the queued SyncOperation is untouched
    const opAfterPull = await dexieDb.sync_operations
      .where('operationId')
      .equals(queuedOp.operationId)
      .first();

    expect(opAfterPull?.baseVersion).toBe(1); // STILL 1, never re-derived!

    // 6. Client now pushes its queued UPDATE with baseVersion: 1
    const pushResult = await pushService.pushBatch(pushTransport);

    // Server evaluates baseVersion (1) !== serverVersion (2) -> returns CONFLICT
    expect(pushResult.conflictCount).toBe(1);
    expect(pushResult.appliedCount).toBe(0);

    // Verify operation in Dexie is in CONFLICT status
    const conflictOp = await dexieDb.sync_operations
      .where('operationId')
      .equals(queuedOp.operationId)
      .first();

    expect(conflictOp?.status).toBe('CONFLICT');

    // Verify conflict record was saved in client Dexie conflicts table
    const storedConflict = await dexieDb.conflicts
      .where('[entityType+entityId]')
      .equals(['PROJECT', project.id])
      .first();

    expect(storedConflict).toBeDefined();
    expect(storedConflict?.conflictType).toBe('EDIT_EDIT');
    expect(storedConflict?.serverVersion).toBe(2);
    expect(storedConflict?.clientVersion).toBe(1);
  });
});
