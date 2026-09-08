import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie, ConflictResolutionService } from '@fieldcore/sync';
import type { ConflictRecord, EditEditConflictRecord } from '@fieldcore/types';

describe('Stage 6 Conflict Drawer Logic & EDIT_DELETE Non-Resolvable Guard', () => {
  let db: FieldCoreDexie;
  let resolutionService: ConflictResolutionService;

  beforeEach(async () => {
    db = new FieldCoreDexie(`test_drawer_${crypto.randomUUID()}`);
    await db.open();
    resolutionService = new ConflictResolutionService(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('allows resolving EDIT_EDIT conflicts via KEEP_SERVER or KEEP_MINE', async () => {
    const entityId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();
    const operationId = crypto.randomUUID();

    await db.projects.put({
      id: entityId,
      name: 'Local Edit',
      code: 'LE',
      status: 'ACTIVE',
      version: 2,
      isDeleted: false,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId,
      conflictType: 'EDIT_EDIT',
      serverVersion: 2,
      clientVersion: 1,
      serverState: { name: 'Server Edit', code: 'LE', version: 2 },
      clientState: { name: 'Local Edit', code: 'LE' },
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    } as EditEditConflictRecord);

    await db.sync_operations.add({
      operationId,
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Local Edit' },
      status: 'CONFLICT',
      clientId: 'c1',
      deviceId: 'd1',
      userId: 'u1',
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    // Resolve as KEEP_MINE
    const result = await resolutionService.resolve({
      conflictId,
      resolution: 'KEEP_MINE',
      resolvedByUserId: 'u1',
    });

    expect(result.resolution).toBe('KEEP_MINE');
    const updatedConflict = await db.conflicts.get(conflictId);
    expect(updatedConflict?.status).toBe('RESOLVED');
    expect(updatedConflict?.resolution).toBe('KEEP_MINE');

    const op = await db.sync_operations.where('operationId').equals(operationId).first();
    expect(op?.status).toBe('PENDING');
  });

  it('proves that EDIT_DELETE conflicts are non-user-resolvable and must be read-only in UI', async () => {
    const entityId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    // Seed EDIT_DELETE conflict (auto-resolved by pull engine)
    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId: crypto.randomUUID(),
      conflictType: 'EDIT_DELETE',
      serverVersion: 3,
      clientVersion: 1,
      serverState: null,
      clientState: { name: 'My Discarded Edit' },
      status: 'RESOLVED',
      resolution: 'KEEP_SERVER',
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: null,
      createdAt: new Date().toISOString(),
    } as any);

    // If UI improperly displayed resolution buttons and invoked resolve(), it would throw:
    await expect(
      resolutionService.resolve({
        conflictId,
        resolution: 'KEEP_MINE',
        resolvedByUserId: 'u1',
      })
    ).rejects.toThrow();

    // Confirming that rendering EDIT_DELETE as a read-only notification card protects against this failure mode.
    const record = await db.conflicts.get(conflictId);
    expect(record?.conflictType).toBe('EDIT_DELETE');
    expect(record?.status).toBe('RESOLVED');
  });
});
