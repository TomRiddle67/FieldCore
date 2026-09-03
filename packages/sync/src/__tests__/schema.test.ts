import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';

describe('Local Dexie Database Schema', () => {
  let db: FieldCoreDexie;

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_schema_${Date.now()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('defines all required domain and sync tables', () => {
    expect(db.projects).toBeDefined();
    expect(db.sites).toBeDefined();
    expect(db.inspections).toBeDefined();
    expect(db.measurements).toBeDefined();
    expect(db.sync_operations).toBeDefined();
    expect(db.conflicts).toBeDefined();
    expect(db.sync_cursors).toBeDefined();
  });

  it('supports compound index queries on sync_operations [deviceId+status]', async () => {
    const validUUID = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.sync_operations.add({
      operationId: crypto.randomUUID(),
      entityType: 'PROJECT',
      entityId: validUUID,
      operationType: 'CREATE',
      baseVersion: 0,
      payload: { name: 'Test Project' },
      status: 'PENDING',
      clientId: 'c1',
      deviceId: 'dev-1',
      userId: validUUID,
      createdAt: now,
      retryCount: 0,
    });

    const pendingForDev1 = await db.sync_operations
      .where('[deviceId+status]')
      .equals(['dev-1', 'PENDING'])
      .toArray();

    expect(pendingForDev1).toHaveLength(1);
    expect(pendingForDev1[0].deviceId).toBe('dev-1');
  });

  it('supports compound primary key on sync_cursors [deviceId+scope]', async () => {
    const now = new Date().toISOString();

    await db.sync_cursors.put({
      deviceId: 'dev-1',
      scope: 'default',
      lastServerSequence: 42,
      lastSyncAt: now,
      updatedAt: now,
    });

    const cursor = await db.sync_cursors.get(['dev-1', 'default']);
    expect(cursor).toBeDefined();
    expect(cursor?.lastServerSequence).toBe(42);
  });
});
