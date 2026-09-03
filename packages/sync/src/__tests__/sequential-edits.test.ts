import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import type { RepositoryContext } from '../repository/base.js';

describe('Sequential Offline Edits — baseVersion Chain & localSeq Ordering', () => {
  let db: FieldCoreDexie;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_sequential_${Date.now()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('two offline updates before sync produce correct baseVersion chain (1 → 2) and monotonically increasing localSeq', async () => {
    const repo = new ProjectRepository(db, context);

    // Create — version becomes 1, no sync yet
    const created = await repo.create({ name: 'Original Name', code: 'SEQ-01' });
    expect(created.version).toBe(1);

    // First offline update — should capture baseVersion 1, entity version becomes 2
    const afterEdit1 = await repo.update(created.id, { name: 'Edit 1' });
    expect(afterEdit1.version).toBe(2);

    // Second offline update — should capture baseVersion 2, entity version becomes 3
    const afterEdit2 = await repo.update(created.id, { name: 'Edit 2' });
    expect(afterEdit2.version).toBe(3);

    // Fetch all queued operations for this entity
    const allOps = await db.sync_operations
      .where('entityId')
      .equals(created.id)
      .toArray();

    // Must be exactly 3 operations (CREATE + 2 UPDATEs); not coalesced
    expect(allOps).toHaveLength(3);

    // Sort by localSeq to verify ordering is monotonically ascending
    const sorted = allOps.slice().sort((a, b) => (a.localSeq ?? 0) - (b.localSeq ?? 0));
    expect(sorted[0].localSeq).toBeLessThan(sorted[1].localSeq!);
    expect(sorted[1].localSeq).toBeLessThan(sorted[2].localSeq!);

    // Verify operation types in order
    expect(sorted[0].operationType).toBe('CREATE');
    expect(sorted[1].operationType).toBe('UPDATE');
    expect(sorted[2].operationType).toBe('UPDATE');

    // Verify baseVersion chain: CREATE = null, first UPDATE = 1 (pre-edit1 version), second UPDATE = 2
    expect(sorted[0].baseVersion).toBeNull(); // CREATE → null
    expect(sorted[1].baseVersion).toBe(1);    // UPDATE 1 → based on version 1
    expect(sorted[2].baseVersion).toBe(2);    // UPDATE 2 → based on version 2

    // Final entity version is 3 (two increments from initial 1)
    const finalEntity = await repo.getById(created.id);
    expect(finalEntity?.version).toBe(3);
    expect(finalEntity?.name).toBe('Edit 2');
  });
});
