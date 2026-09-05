import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { PullSyncService, type PullTransport } from '../services/pull-sync.js';
import { ProjectRepository } from '../repository/project.js';
import type { ServerChangeLog, PullResponse } from '@fieldcore/types';

describe('PullSyncService (Client Sync Engine)', () => {
  let db: FieldCoreDexie;
  let pullService: PullSyncService;
  let projectRepo: ProjectRepository;

  const testUserId = '11111111-1111-4111-8111-111111111111';
  const testDeviceId = '22222222-2222-4222-8222-222222222222';
  const testClientId = 'client-1';

  beforeEach(async () => {
    db = new FieldCoreDexie(`test_pull_db_${Date.now()}_${Math.random()}`);
    await db.open();
    pullService = new PullSyncService(db);
    projectRepo = new ProjectRepository(db, {
      userId: testUserId,
      deviceId: testDeviceId,
      clientId: testClientId,
    });
  });

  afterEach(async () => {
    await db.delete();
  });

  it('atomically commits domain apply and cursor advance in one transaction, rolling back on failure', async () => {
    const initialCursor = await pullService.getLocalCursor();
    expect(initialCursor).toBe('0');

    const project1Id = crypto.randomUUID();
    const project2Id = crypto.randomUUID();

    const mockResponse: PullResponse = {
      changes: [
        {
          sequence: '1',
          entityType: 'PROJECT',
          entityId: project1Id,
          version: 1,
          operationType: 'CREATE',
          payload: { id: project1Id, name: 'Project One', code: 'P-1' },
          isTombstone: false,
          changedByUserId: testUserId,
          changedByDeviceId: testDeviceId,
          operationId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        },
        {
          sequence: '2',
          entityType: 'PROJECT',
          entityId: project2Id,
          version: 1,
          operationType: 'CREATE',
          payload: { id: project2Id, name: 'Project Two', code: 'P-2' },
          isTombstone: false,
          changedByUserId: testUserId,
          changedByDeviceId: testDeviceId,
          operationId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        },
      ],
      latestSequence: '2',
      hasMore: false,
    };

    // 1. Simulate crash mid-transaction by intercepting table write for project2
    const originalPut = db.projects.put.bind(db.projects);
    let callCount = 0;
    vi.spyOn(db.projects, 'put').mockImplementation(((item: any) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Simulated crash during apply');
      }
      return originalPut(item);
    }) as any);

    const failingTransport: PullTransport = async () => mockResponse;

    await expect(pullService.pullBatch(failingTransport)).rejects.toThrow('Simulated crash during apply');

    // Verify rollback: cursor did NOT advance, neither project is persisted
    const cursorAfterCrash = await pullService.getLocalCursor();
    expect(cursorAfterCrash).toBe('0');
    const p1AfterCrash = await db.projects.get(project1Id);
    expect(p1AfterCrash).toBeUndefined();

    // 2. Restore normal put behavior and re-pull
    vi.restoreAllMocks();

    const successResult = await pullService.pullBatch(failingTransport);
    expect(successResult.changesApplied).toBe(2);
    expect(successResult.latestSequence).toBe('2');

    const cursorAfterSuccess = await pullService.getLocalCursor();
    expect(cursorAfterSuccess).toBe('2');
    const p1 = await db.projects.get(project1Id);
    const p2 = await db.projects.get(project2Id);
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1?.name).toBe('Project One');
  });

  it('drains multiple pages with hasMore loop, advancing cursor per-page', async () => {
    const pages: PullResponse[] = [
      {
        changes: [
          {
            sequence: '1',
            entityType: 'PROJECT',
            entityId: crypto.randomUUID(),
            version: 1,
            operationType: 'CREATE',
            payload: { name: 'Page 1 - A', code: 'P1A' },
            isTombstone: false,
            changedByUserId: testUserId,
            changedByDeviceId: testDeviceId,
            operationId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          },
          {
            sequence: '2',
            entityType: 'PROJECT',
            entityId: crypto.randomUUID(),
            version: 1,
            operationType: 'CREATE',
            payload: { name: 'Page 1 - B', code: 'P1B' },
            isTombstone: false,
            changedByUserId: testUserId,
            changedByDeviceId: testDeviceId,
            operationId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          },
        ],
        latestSequence: '2',
        hasMore: true,
      },
      {
        changes: [
          {
            sequence: '3',
            entityType: 'PROJECT',
            entityId: crypto.randomUUID(),
            version: 1,
            operationType: 'CREATE',
            payload: { name: 'Page 2 - A', code: 'P2A' },
            isTombstone: false,
            changedByUserId: testUserId,
            changedByDeviceId: testDeviceId,
            operationId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          },
          {
            sequence: '4',
            entityType: 'PROJECT',
            entityId: crypto.randomUUID(),
            version: 1,
            operationType: 'CREATE',
            payload: { name: 'Page 2 - B', code: 'P2B' },
            isTombstone: false,
            changedByUserId: testUserId,
            changedByDeviceId: testDeviceId,
            operationId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          },
        ],
        latestSequence: '4',
        hasMore: true,
      },
      {
        changes: [
          {
            sequence: '5',
            entityType: 'PROJECT',
            entityId: crypto.randomUUID(),
            version: 1,
            operationType: 'CREATE',
            payload: { name: 'Page 3 - A', code: 'P3A' },
            isTombstone: false,
            changedByUserId: testUserId,
            changedByDeviceId: testDeviceId,
            operationId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
          },
        ],
        latestSequence: '5',
        hasMore: false,
      },
    ];

    let pageIndex = 0;
    const mockTransport: PullTransport = async (req) => {
      const page = pages[pageIndex++];
      return page;
    };

    const result = await pullService.pullAll(mockTransport);
    expect(result.pagesPulled).toBe(3);
    expect(result.totalApplied).toBe(5);
    expect(result.latestSequence).toBe('5');

    const finalCursor = await pullService.getLocalCursor();
    expect(finalCursor).toBe('5');

    const allProjects = await db.projects.toArray();
    expect(allProjects).toHaveLength(5);
  });

  it('handles own-operation round-trip without duplicate writes or version corruption', async () => {
    // 1. Device creates project offline
    const created = await projectRepo.create({
      name: 'Local Origin Project',
      code: 'LOP-1',
    });
    expect(created.version).toBe(1);

    // 2. Server delivers own pushed change back to client
    const mockTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '42',
          entityType: 'PROJECT',
          entityId: created.id,
          version: 1,
          operationType: 'CREATE',
          payload: {
            id: created.id,
            name: created.name,
            code: created.code,
          },
          isTombstone: false,
          changedByUserId: testUserId,
          changedByDeviceId: testDeviceId, // Own device ID
          operationId: crypto.randomUUID(),
          createdAt: created.createdAt,
        },
      ],
      latestSequence: '42',
      hasMore: false,
    });

    const pullResult = await pullService.pullBatch(mockTransport);

    // Skipped because local record already has version >= incoming.version (1 >= 1)
    expect(pullResult.changesApplied).toBe(0);
    expect(pullResult.latestSequence).toBe('42');

    // Verify exactly 1 record exists in Dexie at version 1
    const projects = await db.projects.toArray();
    expect(projects).toHaveLength(1);
    expect(projects[0].version).toBe(1);
  });

  it('applies tombstones idempotently across cursor-gap re-deliveries', async () => {
    const projectId = crypto.randomUUID();
    // Pre-insert entity at version 1
    await db.projects.put({
      id: projectId,
      name: 'Active Project',
      code: 'ACT-1',
      status: 'ACTIVE',
      version: 1,
      isDeleted: false,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const tombstoneChange: ServerChangeLog = {
      sequence: '10',
      entityType: 'PROJECT',
      entityId: projectId,
      version: 2,
      operationType: 'DELETE',
      payload: { id: projectId, isDeleted: true, deletedAt: new Date().toISOString() },
      isTombstone: true,
      changedByUserId: testUserId,
      changedByDeviceId: testDeviceId,
      operationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };

    const mockTransport: PullTransport = async () => ({
      changes: [tombstoneChange],
      latestSequence: '10',
      hasMore: false,
    });

    // First pull: applies tombstone
    const res1 = await pullService.pullBatch(mockTransport);
    expect(res1.changesApplied).toBe(1);

    const recordAfter1 = await db.projects.get(projectId);
    expect(recordAfter1?.isDeleted).toBe(true);
    expect(recordAfter1?.version).toBe(2);

    // Second pull (simulating cursor-gap re-delivery of the same sequence):
    const res2 = await pullService.pullBatch(mockTransport);
    // Skipped: record already isDeleted at version 2 >= 2
    expect(res2.changesApplied).toBe(0);

    const recordAfter2 = await db.projects.get(projectId);
    expect(recordAfter2?.isDeleted).toBe(true);
    expect(recordAfter2?.version).toBe(2);
  });

  it('surfaces cursorExpired: true without advancing cursor or throwing', async () => {
    const expiredTransport: PullTransport = async () => ({
      changes: [],
      latestSequence: '0',
      hasMore: false,
      cursorExpired: true,
    });

    const result = await pullService.pullBatch(expiredTransport);
    expect(result.cursorExpired).toBe(true);
    expect(result.changesApplied).toBe(0);

    const cursor = await pullService.getLocalCursor();
    expect(cursor).toBe('0');
  });

  it('⚑ STALE PULL SKIPPED: preserves local pending edit at version N+1 and leaves baseVersion unchanged when pull delivers version N', async () => {
    // 1. Create project locally (version = 1)
    const project = await projectRepo.create({
      name: 'Initial Name',
      code: 'INIT-1',
    });
    expect(project.version).toBe(1);

    // 2. Perform local update while offline -> local version becomes 2 (N+1)
    // Dexie domain row has version = 2; sync_operations table has queued UPDATE with baseVersion = 1
    const updated = await projectRepo.update(project.id, {
      name: 'Locally Edited Name',
    });
    expect(updated.version).toBe(2);

    const queuedOps = await db.sync_operations
      .where('entityId')
      .equals(project.id)
      .toArray();

    const updateOp = queuedOps.find((op) => op.operationType === 'UPDATE');
    expect(updateOp).toBeDefined();
    expect(updateOp!.baseVersion).toBe(1); // Explicitly captured baseVersion = 1

    // 3. A pull cycle runs before the update pushes, delivering server state at version 1 (N)
    const stalePullTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '55',
          entityType: 'PROJECT',
          entityId: project.id,
          version: 1, // Stale relative to local version 2
          operationType: 'UPDATE',
          payload: {
            id: project.id,
            name: 'Server Overwrite Attempt',
            code: 'INIT-1',
          },
          isTombstone: false,
          changedByUserId: testUserId,
          changedByDeviceId: 'other-device-33333333-3333',
          operationId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        },
      ],
      latestSequence: '55',
      hasMore: false,
    });

    const pullResult = await pullService.pullBatch(stalePullTransport);

    // 4. Assert pull is skipped: changesApplied = 0
    expect(pullResult.changesApplied).toBe(0);

    // 5. Assert local Dexie record is NOT clobbered:
    const localEntity = await db.projects.get(project.id);
    expect(localEntity).toBeDefined();
    expect(localEntity!.version).toBe(2); // Stays at 2
    expect(localEntity!.name).toBe('Locally Edited Name'); // Stays locally edited

    // 6. Assert SyncOperation.baseVersion is strictly unchanged
    const opAfterPull = await db.sync_operations
      .where('operationId')
      .equals(updateOp!.operationId)
      .first();

    expect(opAfterPull).toBeDefined();
    expect(opAfterPull!.baseVersion).toBe(1); // baseVersion was not touched by pull
    expect(opAfterPull!.status).toBe('PENDING'); // Remains PENDING for push
  });
});
