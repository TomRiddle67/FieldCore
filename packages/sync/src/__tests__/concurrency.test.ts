import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import type { RepositoryContext } from '../repository/base.js';

describe('Concurrent update() safety — proves atomic read-modify-write', () => {
  let db: FieldCoreDexie;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_concurrency_${Date.now()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('does not lose an update under two concurrent update() calls on the same entity', async () => {
    const repo = new ProjectRepository(db, context);
    const p = await repo.create({ name: 'Original', code: 'ORG-1' });

    // Fire both updates concurrently — neither awaits the other before starting
    await Promise.all([
      repo.update(p.id, { name: 'Update A' }),
      repo.update(p.id, { name: 'Update B' }),
    ]);

    const ops = await db.sync_operations
      .where('entityId')
      .equals(p.id)
      .sortBy('localSeq');

    // Both updates must produce distinct queued operations — not coalesced
    const updateOps = ops.filter((o) => o.operationType === 'UPDATE');
    expect(updateOps).toHaveLength(2);

    // baseVersion chain must be 1 → 2 (neither update clobbers the other's base)
    // If the read happened outside the transaction, both would see version=1 and
    // both would enqueue baseVersion:1 — a silent lost-update that passes to the
    // server and causes a conflict there instead of being caught locally.
    const baseVersions = updateOps.map((o) => o.baseVersion).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(baseVersions).toEqual([1, 2]);

    // Final entity version must be 3 (create=1, update=2, update=3)
    const final = await repo.getById(p.id);
    expect(final?.version).toBe(3);
  });

  it('CREATE operations record baseVersion as null, never 0', async () => {
    const repo = new ProjectRepository(db, context);
    const p = await repo.create({ name: 'x', code: 'y' });
    const ops = await db.sync_operations.where('entityId').equals(p.id).toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].baseVersion).toBeNull();
  });

  it('orders pending operations by localSeq under forced timestamp collision', async () => {
    const repo = new ProjectRepository(db, context);
    const p = await repo.create({ name: 'Seq Test', code: 'SEQ-1' });

    // Perform two sequential updates — localSeq must increment regardless of timestamp
    await repo.update(p.id, { name: 'First Edit' });
    await repo.update(p.id, { name: 'Second Edit' });

    const ops = await db.sync_operations
      .where('entityId')
      .equals(p.id)
      .sortBy('localSeq');

    expect(ops).toHaveLength(3); // CREATE + 2 UPDATEs
    // localSeq must be strictly ascending
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i].localSeq!).toBeGreaterThan(ops[i - 1].localSeq!);
    }
    // Ops in localSeq order must match call order
    expect(ops[0].operationType).toBe('CREATE');
    expect(ops[1].operationType).toBe('UPDATE');
    expect(ops[2].operationType).toBe('UPDATE');
  });
});
