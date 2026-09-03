import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import { SyncStatusService } from '../services/sync-status.js';
import type { RepositoryContext } from '../repository/base.js';

describe('SyncStatusService', () => {
  let db: FieldCoreDexie;
  let statusService: SyncStatusService;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_sync_status_${Date.now()}`);
    statusService = new SyncStatusService(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('correctly tracks pending mutation count and returns pending operations in order', async () => {
    const repo = new ProjectRepository(db, context);

    expect(await statusService.getPendingCount(context.deviceId)).toBe(0);

    const p1 = await repo.create({ name: 'Project 1', code: 'P1' });
    const p2 = await repo.create({ name: 'Project 2', code: 'P2' });

    expect(await statusService.getPendingCount(context.deviceId)).toBe(2);

    const pendingOps = await statusService.getPendingOperations(context.deviceId);
    expect(pendingOps).toHaveLength(2);
    expect(pendingOps[0].entityId).toBe(p1.id);
    expect(pendingOps[1].entityId).toBe(p2.id);
  });

  it('queries last sync timestamp and sequence cursor', async () => {
    const now = new Date().toISOString();

    await db.sync_cursors.put({
      deviceId: context.deviceId,
      scope: 'default',
      lastServerSequence: 250,
      lastSyncAt: now,
      updatedAt: now,
    });

    const lastSync = await statusService.getLastSyncAt(context.deviceId);
    expect(lastSync).toBe(now);

    const lastSeq = await statusService.getLastServerSequence(context.deviceId);
    expect(lastSeq).toBe(250);
  });

  it('retrieves unresolved conflicts filtered by entity type', async () => {
    const now = new Date().toISOString();

    await db.conflicts.bulkAdd([
      {
        conflictId: crypto.randomUUID(),
        entityType: 'PROJECT',
        entityId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        conflictType: 'EDIT_EDIT',
        serverVersion: 2,
        clientVersion: 1,
        serverState: {},
        clientState: {},
        status: 'PENDING',
        createdAt: now,
      },
      {
        conflictId: crypto.randomUUID(),
        entityType: 'SITE',
        entityId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        conflictType: 'EDIT_EDIT',
        serverVersion: 3,
        clientVersion: 2,
        serverState: {},
        clientState: {},
        status: 'PENDING',
        createdAt: now,
      },
    ]);

    const allConflicts = await statusService.getConflicts();
    expect(allConflicts).toHaveLength(2);

    const siteConflicts = await statusService.getConflicts('SITE');
    expect(siteConflicts).toHaveLength(1);
    expect(siteConflicts[0].entityType).toBe('SITE');
  });
});
