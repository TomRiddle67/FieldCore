import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import type { RepositoryContext } from '../repository/base.js';

describe('Atomic Mutation & Transaction Rollback Safety', () => {
  let db: FieldCoreDexie;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_atomic_${Date.now()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('atomically creates domain record and enqueues sync operation in single transaction', async () => {
    const repo = new ProjectRepository(db, context);

    const project = await repo.create({
      name: 'Gold Ridge Project',
      code: 'GRP-001',
      description: 'Gold exploration drill program',
    });

    // Verify domain row exists
    const domainRow = await db.projects.get(project.id);
    expect(domainRow).toBeDefined();
    expect(domainRow?.version).toBe(1);

    // Verify sync queue row exists
    const queueRows = await db.sync_operations.where('entityId').equals(project.id).toArray();
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].operationType).toBe('CREATE');
    expect(queueRows[0].baseVersion).toBeNull(); // CREATE must use null, never 0
    expect(queueRows[0].localSeq).toBeTypeOf('number'); // auto-assigned by Dexie
    expect(queueRows[0].status).toBe('PENDING');
    expect(queueRows[0].deviceId).toBe(context.deviceId);
  });

  it('rolls back both domain record and queue operation if an atomic transaction fails', async () => {
    const repo = new ProjectRepository(db, context);

    // Attempt to update non-existent record
    const fakeId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a99';
    await expect(repo.update(fakeId, { name: 'New Name' })).rejects.toThrow();

    // Verify no queue row was inserted
    const queueRows = await db.sync_operations.where('entityId').equals(fakeId).toArray();
    expect(queueRows).toHaveLength(0);
  });
});
