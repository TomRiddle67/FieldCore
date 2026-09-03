import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import { RecordConflictLockedError, type RepositoryContext } from '../repository/base.js';

describe('Conflict-Lock Enforcement (Read-Only Until Resolved)', () => {
  let db: FieldCoreDexie;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_conflict_lock_${Date.now()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('rejects update() on a record with an unresolved (PENDING) conflict', async () => {
    const repo = new ProjectRepository(db, context);

    const project = await repo.create({
      name: 'Conflicted Project',
      code: 'CP-01',
    });

    const conflictId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Simulate conflict recorded locally during previous sync
    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId: project.id,
      operationId: crypto.randomUUID(),
      conflictType: 'EDIT_EDIT',
      serverVersion: 3,
      clientVersion: 1,
      serverState: { name: 'Server Project Name', code: 'CP-01', version: 3 },
      clientState: { name: 'Conflicted Project', code: 'CP-01', version: 1 },
      status: 'PENDING',
      createdAt: now,
    });

    // Attempting to update should throw RecordConflictLockedError
    await expect(repo.update(project.id, { name: 'New Attempt' })).rejects.toThrow(
      RecordConflictLockedError
    );
  });

  it('rejects delete() on a record with an unresolved (PENDING) conflict', async () => {
    const repo = new ProjectRepository(db, context);

    const project = await repo.create({
      name: 'Conflicted Project 2',
      code: 'CP-02',
    });

    const conflictId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId: project.id,
      operationId: crypto.randomUUID(),
      conflictType: 'EDIT_EDIT',
      serverVersion: 3,
      clientVersion: 1,
      serverState: { name: 'Server Project Name', code: 'CP-02', version: 3 },
      clientState: { name: 'Conflicted Project 2', code: 'CP-02', version: 1 },
      status: 'PENDING',
      createdAt: now,
    });

    await expect(repo.delete(project.id)).rejects.toThrow(RecordConflictLockedError);
  });

  it('allows update() once the conflict status is RESOLVED', async () => {
    const repo = new ProjectRepository(db, context);

    const project = await repo.create({
      name: 'Resolvable Project',
      code: 'RP-01',
    });

    const conflictId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId: project.id,
      operationId: crypto.randomUUID(),
      conflictType: 'EDIT_EDIT',
      serverVersion: 3,
      clientVersion: 1,
      serverState: { name: 'Server Project Name', code: 'RP-01', version: 3 },
      clientState: { name: 'Resolvable Project', code: 'RP-01', version: 1 },
      status: 'RESOLVED',
      resolution: 'KEEP_MINE',
      resolvedAt: now,
      resolvedByUserId: context.userId,
      createdAt: now,
    });

    // Since conflict is RESOLVED, update succeeds
    const updated = await repo.update(project.id, { name: 'Resolved & Updated' });
    expect(updated.name).toBe('Resolved & Updated');
  });
});
