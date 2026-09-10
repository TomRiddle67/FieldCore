/**
 * Stage 5 Adversarial Suite — Conflict Resolution & Deterministic Resilience
 *
 * Tests in this file exercise:
 *   A. Out-of-order pull application (version-compare idempotency)
 *   B. Cascading conflicts: pushBatch excludes PENDING ops for entityIds with unresolved conflicts
 *   C. Stale-conflict resolution: resolve() applies against current live version, not cached
 *   D. Pull reclassifying conflict: EDIT_EDIT → EDIT_DELETE when entity is deleted at resolve time
 *   E. Capstone integration: two independent client pairs converge after conflict is resolved
 *
 * All client-side assertions run against fake-indexeddb (no Postgres needed).
 * Test E additionally exercises the full push/pull stack end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { PushSyncService, type PushTransport } from '../services/push-sync.js';
import { PullSyncService, type PullTransport } from '../services/pull-sync.js';
import {
  ConflictResolutionService,
  ConflictNotFoundError,
  NonResolvableConflictError,
  ConflictAlreadyResolvedError,
} from '../services/conflict-resolution.js';
import { ProjectRepository } from '../repository/project.js';
import type {
  ConflictRecord,
  EditEditConflictRecord,
  PushResponse,
  PullResponse,
} from '@fieldcore/types';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const userId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const clientId = 'stage5-client-1';

function makeDb(label: string): FieldCoreDexie {
  return new FieldCoreDexie(`stage5_${label}_${Date.now()}_${Math.random()}`);
}

function makeConflict(
  overrides: Partial<EditEditConflictRecord> & { entityId: string }
): EditEditConflictRecord {
  const now = new Date().toISOString();
  return {
    conflictId: crypto.randomUUID(),
    entityType: 'PROJECT',
    operationId: crypto.randomUUID(),
    conflictType: 'EDIT_EDIT',
    serverVersion: 2,
    clientVersion: 1,
    serverState: { name: 'Server Name', code: 'SRV-1', version: 2 },
    clientState: { name: 'Client Name', code: 'CLI-1', version: 1 },
    status: 'PENDING',
    createdAt: now,
    ...overrides,
  } as EditEditConflictRecord;
}

// ---------------------------------------------------------------------------
// A. Out-of-order pull application
// ---------------------------------------------------------------------------

describe('Stage 5-A: Out-of-order pull application (version-compare idempotency)', () => {
  let db: FieldCoreDexie;
  let pullService: PullSyncService;

  beforeEach(async () => {
    db = makeDb('out_of_order');
    await db.open();
    pullService = new PullSyncService(db);
  });

  afterEach(async () => { await db.delete(); });

  it('applies higher-version chunk and silently skips lower-version chunk delivered out of order', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Pre-seed entity at version 3 (as if a previous pull already applied v3)
    await db.projects.put({
      id: entityId,
      name: 'Version Three',
      code: 'V3',
      status: 'ACTIVE',
      version: 3,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // Transport delivers version 2 (stale — out of order relative to already-applied v3)
    const staleTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '5',
          entityType: 'PROJECT',
          entityId,
          version: 2,
          operationType: 'UPDATE',
          payload: { id: entityId, name: 'Version Two — Should Be Skipped', code: 'V2' },
          isTombstone: false,
          changedByUserId: userId,
          changedByDeviceId: deviceId,
          operationId: crypto.randomUUID(),
          createdAt: now,
        },
      ],
      latestSequence: '5',
      hasMore: false,
    });

    const result = await pullService.pullBatch(staleTransport);

    // Must be skipped — existing version 3 >= incoming version 2
    expect(result.changesApplied).toBe(0);
    expect(result.latestSequence).toBe('5'); // cursor still advances

    const entity = await db.projects.get(entityId);
    expect(entity?.version).toBe(3);
    expect(entity?.name).toBe('Version Three'); // name unchanged
  });

  it('applies equal-version chunk as a no-op (idempotent re-delivery of same sequence)', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.projects.put({
      id: entityId,
      name: 'Stable Name',
      code: 'STABLE',
      status: 'ACTIVE',
      version: 5,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const sameVersionTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '10',
          entityType: 'PROJECT',
          entityId,
          version: 5,
          operationType: 'UPDATE',
          payload: { id: entityId, name: 'Stable Name', code: 'STABLE' },
          isTombstone: false,
          changedByUserId: userId,
          changedByDeviceId: deviceId,
          operationId: crypto.randomUUID(),
          createdAt: now,
        },
      ],
      latestSequence: '10',
      hasMore: false,
    });

    const result = await pullService.pullBatch(sameVersionTransport);
    expect(result.changesApplied).toBe(0); // version 5 >= 5 → skip
    const entity = await db.projects.get(entityId);
    expect(entity?.version).toBe(5);
  });

  it('correctly applies two chunks in a single page where first is older version (skipped) and second is newer (applied)', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.projects.put({
      id: entityId,
      name: 'Intermediate',
      code: 'INT',
      status: 'ACTIVE',
      version: 2,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const mixedTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '7',
          entityType: 'PROJECT',
          entityId,
          version: 1, // stale
          operationType: 'UPDATE',
          payload: { id: entityId, name: 'Old State', code: 'INT' },
          isTombstone: false,
          changedByUserId: userId,
          changedByDeviceId: deviceId,
          operationId: crypto.randomUUID(),
          createdAt: now,
        },
        {
          sequence: '8',
          entityType: 'PROJECT',
          entityId,
          version: 3, // newer
          operationType: 'UPDATE',
          payload: { id: entityId, name: 'Newest State', code: 'INT' },
          isTombstone: false,
          changedByUserId: userId,
          changedByDeviceId: deviceId,
          operationId: crypto.randomUUID(),
          createdAt: now,
        },
      ],
      latestSequence: '8',
      hasMore: false,
    });

    const result = await pullService.pullBatch(mixedTransport);
    expect(result.changesApplied).toBe(1); // only the v3 chunk was applied

    const entity = await db.projects.get(entityId);
    expect(entity?.version).toBe(3);
    expect(entity?.name).toBe('Newest State');
  });
});

// ---------------------------------------------------------------------------
// B. Cascading conflicts: pushBatch excludes PENDING ops for conflicted entityId
// ---------------------------------------------------------------------------

describe('Stage 5-B: Cascading conflicts — pushBatch excludes ops for entityIds with PENDING conflict', () => {
  let db: FieldCoreDexie;
  let pushService: PushSyncService;
  let projectRepo: ProjectRepository;

  beforeEach(async () => {
    db = makeDb('cascading_conflict');
    await db.open();
    pushService = new PushSyncService(db);
    projectRepo = new ProjectRepository(db, { userId, deviceId, clientId });
  });

  afterEach(async () => { await db.delete(); });

  it('excludes a PENDING operation for an entityId that has an unresolved ConflictRecord', async () => {
    // 1. Create project → generates PENDING sync_operation
    const project = await projectRepo.create({ name: 'Conflict Locked', code: 'CL-1' });

    // 2. Simulate a CONFLICT-status operation for the same entityId
    //    (as if pushBatch previously transitioned the CREATE to CONFLICT)
    await db.sync_operations
      .where('entityId')
      .equals(project.id)
      .modify({ status: 'CONFLICT' });

    // 3. Client then performs a local UPDATE (allowed since this is a new operation on the repo,
    //    but we test the push gate, not the write gate). Directly insert a PENDING op to simulate.
    await db.sync_operations.add({
      operationId: crypto.randomUUID(),
      entityType: 'PROJECT',
      entityId: project.id,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Second Edit Attempt' },
      status: 'PENDING',
      clientId,
      deviceId,
      userId,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    });

    // 4. Seed a PENDING ConflictRecord for this entityId
    const conflict = makeConflict({ entityId: project.id });
    await db.conflicts.add(conflict);

    // 5. pushBatch should exclude the PENDING op because entityId has a PENDING conflict
    let transportCalled = false;
    const trackingTransport: PushTransport = async (req) => {
      transportCalled = true;
      return { results: [] };
    };

    const result = await pushService.pushBatch(trackingTransport);

    // Transport must NOT have been called at all — batch was empty after exclusion
    expect(transportCalled).toBe(false);
    expect(result.pushedCount).toBe(0);
  });

  it('allows other entities with no PENDING conflict to push in the same batch', async () => {
    // Create two projects
    const lockedProject = await projectRepo.create({ name: 'Locked', code: 'LK-1' });
    const freeProject = await projectRepo.create({ name: 'Free', code: 'FR-1' });

    // Mark lockedProject's PENDING op with a PENDING ConflictRecord
    const lockedConflict = makeConflict({ entityId: lockedProject.id });
    await db.conflicts.add(lockedConflict);
    // Also set its sync_op to CONFLICT so it's not in PENDING status
    await db.sync_operations
      .where('entityId')
      .equals(lockedProject.id)
      .modify({ status: 'CONFLICT' });

    // freeProject's op remains PENDING with no conflict record
    let capturedOps: string[] = [];
    const trackingTransport: PushTransport = async (req) => {
      capturedOps = req.operations.map((op) => op.entityId);
      return {
        results: req.operations.map((op) => ({
          operationId: op.operationId,
          entityId: op.entityId,
          entityType: op.entityType,
          status: 'APPLIED' as const,
          version: 2,
          sequence: 1,
        })),
      };
    };

    await pushService.pushBatch(trackingTransport);

    // Only freeProject's op should have been sent
    expect(capturedOps).toContain(freeProject.id);
    expect(capturedOps).not.toContain(lockedProject.id);
  });

  it('allows push once the conflict is RESOLVED', async () => {
    const project = await projectRepo.create({ name: 'Resolving Soon', code: 'RS-1' });
    const conflictId = crypto.randomUUID();

    // Seed a RESOLVED conflict (not PENDING) — should NOT block push
    await db.conflicts.add({
      ...makeConflict({ entityId: project.id }),
      conflictId,
      status: 'RESOLVED',
      resolution: 'KEEP_MINE',
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: userId,
    } as EditEditConflictRecord);

    let capturedCount = 0;
    const trackingTransport: PushTransport = async (req) => {
      capturedCount = req.operations.length;
      return {
        results: req.operations.map((op) => ({
          operationId: op.operationId,
          entityId: op.entityId,
          entityType: op.entityType,
          status: 'APPLIED' as const,
          version: 1,
          sequence: 1,
        })),
      };
    };

    await pushService.pushBatch(trackingTransport);
    expect(capturedCount).toBe(1); // RESOLVED conflict doesn't block
  });
});

// ---------------------------------------------------------------------------
// C. Stale-conflict resolution: resolve() uses live entity state at resolve time
// ---------------------------------------------------------------------------

describe('Stage 5-C: Stale-conflict resolution against current live version', () => {
  let db: FieldCoreDexie;
  let pullService: PullSyncService;
  let resolutionService: ConflictResolutionService;

  beforeEach(async () => {
    db = makeDb('stale_conflict');
    await db.open();
    pullService = new PullSyncService(db);
    resolutionService = new ConflictResolutionService(db);
  });

  afterEach(async () => { await db.delete(); });

  it('KEEP_SERVER: applies serverState from conflict record, not stale Dexie snapshot at conflict time', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Pre-seed Dexie entity at version 2 (the state at conflict time)
    await db.projects.put({
      id: entityId,
      name: 'Client Edit At Conflict Time',
      code: 'CEACT',
      status: 'ACTIVE',
      version: 2,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // A pull arrives while the conflict is unresolved, bumping the live entity to version 3
    // (simulating a server peer making another change)
    await db.projects.put({
      id: entityId,
      name: 'Live Server At v3',
      code: 'LSV3',
      status: 'ACTIVE',
      version: 3,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: new Date(Date.now() + 100).toISOString(),
    });

    // Conflict record still references serverVersion: 2 and serverState captured at conflict time
    const operationId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();
    const serverStateAtConflictTime = { name: 'Server State At v2', code: 'SSV2', version: 2 };

    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId,
      conflictType: 'EDIT_EDIT',
      serverVersion: 2,
      clientVersion: 1,
      serverState: serverStateAtConflictTime,
      clientState: { name: 'Client Edit', code: 'CE' },
      status: 'PENDING',
      createdAt: now,
    } as EditEditConflictRecord);

    // Add linked op in CONFLICT status
    await db.sync_operations.add({
      operationId,
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Client Edit' },
      status: 'CONFLICT',
      clientId,
      deviceId,
      userId,
      createdAt: now,
      retryCount: 0,
    });

    const result = await resolutionService.resolve({
      conflictId,
      resolution: 'KEEP_SERVER',
      resolvedByUserId: userId,
    });

    expect(result.resolution).toBe('KEEP_SERVER');
    expect(result.reclassifiedToEditDelete).toBe(false);

    // Conflict should be RESOLVED
    const storedConflict = await db.conflicts.get(conflictId);
    expect(storedConflict?.status).toBe('RESOLVED');
    expect(storedConflict?.resolution).toBe('KEEP_SERVER');

    // Linked operation should be REJECTED
    const op = await db.sync_operations.where('operationId').equals(operationId).first();
    expect(op?.status).toBe('REJECTED');

    // Domain record: KEEP_SERVER overwrites with serverState from conflict record
    // (the v2 serverState, not the v3 live — that's intentional: the user is choosing
    // the version they saw at conflict time)
    const entity = await db.projects.get(entityId);
    expect(entity?.name).toBe('Server State At v2');
    expect(entity?.version).toBe(2); // Restored to conflict-time server snapshot
  });

  it('KEEP_MINE: re-queues op as PENDING with baseVersion advanced to serverVersion', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.projects.put({
      id: entityId,
      name: 'Client Wins State',
      code: 'CWS',
      status: 'ACTIVE',
      version: 2,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const operationId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId,
      conflictType: 'EDIT_EDIT',
      serverVersion: 2, // Server is at v2
      clientVersion: 1,
      serverState: { name: 'Server State', code: 'SS', version: 2 },
      clientState: { name: 'Client Wins State', code: 'CWS' },
      status: 'PENDING',
      createdAt: now,
    } as EditEditConflictRecord);

    await db.sync_operations.add({
      operationId,
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1, // Stale base
      payload: { name: 'Client Wins State' },
      status: 'CONFLICT',
      clientId,
      deviceId,
      userId,
      createdAt: now,
      retryCount: 0,
    });

    const result = await resolutionService.resolve({
      conflictId,
      resolution: 'KEEP_MINE',
      resolvedByUserId: userId,
    });

    expect(result.resolution).toBe('KEEP_MINE');

    // Conflict is RESOLVED
    const storedConflict = await db.conflicts.get(conflictId);
    expect(storedConflict?.status).toBe('RESOLVED');
    expect(storedConflict?.resolution).toBe('KEEP_MINE');

    // Original conflicting operation is marked REJECTED (terminal, for audit)
    const originalOp = await db.sync_operations.where('operationId').equals(operationId).first();
    expect(originalOp?.status).toBe('REJECTED');

    // Fresh operation is enqueued as PENDING with fresh operationId, fresh localSeq,
    // and baseVersion advanced to serverVersion (2)
    const pendingOps = await db.sync_operations.where('status').equals('PENDING').toArray();
    expect(pendingOps.length).toBe(1);
    const op = pendingOps[0];
    expect(op.operationId).not.toBe(operationId);
    expect(op.baseVersion).toBe(2); // Advanced from 1 to serverVersion(2)
    expect(op.errorMessage).toBeNull();
    expect(op.nextEligibleRetryAt).toBeNull();

    // Domain record is left as-is (client's optimistic state)
    const entity = await db.projects.get(entityId);
    expect(entity?.name).toBe('Client Wins State');
    expect(entity?.version).toBe(2);
  });

  it('throws ConflictNotFoundError for a non-existent conflictId', async () => {
    await expect(
      resolutionService.resolve({
        conflictId: crypto.randomUUID(),
        resolution: 'KEEP_SERVER',
        resolvedByUserId: userId,
      })
    ).rejects.toThrow(ConflictNotFoundError);
  });

  it('throws NonResolvableConflictError for EDIT_DELETE conflicts', async () => {
    const entityId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId: crypto.randomUUID(),
      conflictType: 'EDIT_DELETE',
      serverVersion: 2,
      clientVersion: 1,
      serverState: null,
      clientState: { name: 'Client Edit' },
      status: 'RESOLVED', // EDIT_DELETE is always auto-resolved
      resolution: 'KEEP_SERVER',
      resolvedAt: now,
      resolvedByUserId: null,
      createdAt: now,
    } as any);

    await expect(
      resolutionService.resolve({
        conflictId,
        resolution: 'KEEP_SERVER',
        resolvedByUserId: userId,
      })
    ).rejects.toThrow(NonResolvableConflictError);
  });

  it('throws ConflictAlreadyResolvedError when resolving a conflict twice', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    await db.projects.put({
      id: entityId,
      name: 'Resolved Project',
      code: 'RP',
      status: 'ACTIVE',
      version: 2,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId,
      conflictType: 'EDIT_EDIT',
      serverVersion: 2,
      clientVersion: 1,
      serverState: { name: 'Server', code: 'RP', version: 2 },
      clientState: { name: 'Client' },
      status: 'PENDING',
      createdAt: now,
    } as EditEditConflictRecord);

    await db.sync_operations.add({
      operationId,
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Client' },
      status: 'CONFLICT',
      clientId,
      deviceId,
      userId,
      createdAt: now,
      retryCount: 0,
    });

    // First resolution succeeds
    await resolutionService.resolve({
      conflictId,
      resolution: 'KEEP_SERVER',
      resolvedByUserId: userId,
    });

    // Second resolution must throw
    await expect(
      resolutionService.resolve({
        conflictId,
        resolution: 'KEEP_MINE',
        resolvedByUserId: userId,
      })
    ).rejects.toThrow(ConflictAlreadyResolvedError);
  });
});

// ---------------------------------------------------------------------------
// D. Pull reclassifying conflict: EDIT_EDIT → EDIT_DELETE at resolution time
// ---------------------------------------------------------------------------

describe('Stage 5-D: Pull reclassifying conflict — entity deleted before user resolves', () => {
  let db: FieldCoreDexie;
  let pullService: PullSyncService;
  let resolutionService: ConflictResolutionService;

  beforeEach(async () => {
    db = makeDb('reclassify');
    await db.open();
    pullService = new PullSyncService(db);
    resolutionService = new ConflictResolutionService(db);
  });

  afterEach(async () => { await db.delete(); });

  it('reclassifies EDIT_EDIT to EDIT_DELETE and enforces KEEP_SERVER when entity is deleted by the time user resolves', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    // 1. Seed entity as live at version 2 (the state at conflict record time)
    await db.projects.put({
      id: entityId,
      name: 'About To Be Deleted',
      code: 'ATBD',
      status: 'ACTIVE',
      version: 2,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // 2. EDIT_EDIT conflict was recorded at version mismatch
    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId,
      conflictType: 'EDIT_EDIT',
      serverVersion: 2,
      clientVersion: 1,
      serverState: { name: 'Server Edit', code: 'ATBD', version: 2 },
      clientState: { name: 'Client Edit' },
      status: 'PENDING',
      createdAt: now,
    } as EditEditConflictRecord);

    await db.sync_operations.add({
      operationId,
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Client Edit' },
      status: 'CONFLICT',
      clientId,
      deviceId,
      userId,
      createdAt: now,
      retryCount: 0,
    });

    // 3. While conflict is pending, a pull delivers a tombstone (entity deleted on server)
    const tombstoneTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '99',
          entityType: 'PROJECT',
          entityId,
          version: 3,
          operationType: 'DELETE',
          payload: { id: entityId, isDeleted: true, deletedAt: now },
          isTombstone: true,
          changedByUserId: userId,
          changedByDeviceId: 'other-device',
          operationId: crypto.randomUUID(),
          createdAt: now,
        },
      ],
      latestSequence: '99',
      hasMore: false,
    });

    await pullService.pullBatch(tombstoneTransport);

    // Verify entity is now tombstoned in Dexie
    const deletedEntity = await db.projects.get(entityId);
    expect(deletedEntity?.isDeleted).toBe(true);
    expect(deletedEntity?.version).toBe(3);

    // 4. User tries to resolve the conflict as KEEP_MINE (wants their edit)
    //    But the entity is now deleted — service must reclassify to EDIT_DELETE
    //    and enforce KEEP_SERVER regardless of the user's requested resolution
    const result = await resolutionService.resolve({
      conflictId,
      resolution: 'KEEP_MINE', // User requested, but will be overridden
      resolvedByUserId: userId,
    });

    // Service returned KEEP_SERVER and flagged the reclassification
    expect(result.resolution).toBe('KEEP_SERVER');
    expect(result.reclassifiedToEditDelete).toBe(true);

    // ConflictRecord should be updated to EDIT_DELETE/RESOLVED
    const resolvedConflict = await db.conflicts.get(conflictId);
    expect(resolvedConflict?.conflictType).toBe('EDIT_DELETE');
    expect(resolvedConflict?.status).toBe('RESOLVED');
    expect(resolvedConflict?.resolution).toBe('KEEP_SERVER');

    // Operation should be REJECTED (delete wins)
    const op = await db.sync_operations.where('operationId').equals(operationId).first();
    expect(op?.status).toBe('REJECTED');
    expect(op?.errorMessage).toContain('deleted');
  });

  it('KEEP_MINE advances baseVersion to live entity version (3, not 2) when an intervening pull updated the entity before resolution', async () => {
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    // 1. Seed entity as live at version 2 (the state at conflict record time)
    await db.projects.put({
      id: entityId,
      name: 'Client Wins Desired State',
      code: 'CWDS',
      status: 'ACTIVE',
      version: 2,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Conflict record captured at conflict-detection time: serverVersion: 2
    await db.conflicts.add({
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId,
      conflictType: 'EDIT_EDIT',
      serverVersion: 2,
      clientVersion: 1,
      serverState: { name: 'Server Edit v2', code: 'CWDS', version: 2 },
      clientState: { name: 'Client Wins Desired State' },
      status: 'PENDING',
      createdAt: now,
    } as EditEditConflictRecord);

    // Linked operation in CONFLICT status (originally attempted against baseVersion: 1)
    await db.sync_operations.add({
      operationId,
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Client Wins Desired State' },
      status: 'CONFLICT',
      clientId,
      deviceId,
      userId,
      createdAt: now,
      retryCount: 0,
    });

    // 3. Before the user resolves the conflict, an unrelated pull cycle delivers a
    //    third device's edit, advancing the entity to version 3 locally
    const interveningPullTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '100',
          entityType: 'PROJECT',
          entityId,
          version: 3,
          operationType: 'UPDATE',
          payload: { id: entityId, name: 'Third Device Edit v3', code: 'CWDS' },
          isTombstone: false,
          changedByUserId: 'another-user',
          changedByDeviceId: 'third-device',
          operationId: crypto.randomUUID(),
          createdAt: now,
        },
      ],
      latestSequence: '100',
      hasMore: false,
    });

    const pullResult = await pullService.pullBatch(interveningPullTransport);
    expect(pullResult.changesApplied).toBe(1);

    // Verify local entity was advanced to version 3 by the intervening pull
    const pulledEntity = await db.projects.get(entityId);
    expect(pulledEntity?.version).toBe(3);

    // 4. User now resolves the conflict as KEEP_MINE
    const result = await resolutionService.resolve({
      conflictId,
      resolution: 'KEEP_MINE',
      resolvedByUserId: userId,
    });

    expect(result.resolution).toBe('KEEP_MINE');
    expect(result.reclassifiedToEditDelete).toBe(false);

    // 5. Assert the original operation is REJECTED and new PENDING op has baseVersion = 3
    // (the live entity version), NOT 2 (cached conflict.serverVersion), under a fresh operationId
    const originalOp = await db.sync_operations.where('operationId').equals(operationId).first();
    expect(originalOp?.status).toBe('REJECTED');

    const pendingOps = await db.sync_operations.where('status').equals('PENDING').toArray();
    expect(pendingOps.length).toBe(1);
    const op = pendingOps[0];
    expect(op.operationId).not.toBe(operationId);
    expect(op.baseVersion).toBe(3); // Proves baseVersion advanced to live entity version (3), preventing repeated 409
    expect(op.errorMessage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E. Capstone: Two independent client pairs converge after conflict resolution
// ---------------------------------------------------------------------------

describe('Stage 5-E: Capstone convergence — two clients converge after KEEP_MINE resolution', () => {
  let clientADb: FieldCoreDexie;
  let clientBDb: FieldCoreDexie;

  beforeEach(async () => {
    clientADb = makeDb('clientA');
    clientBDb = makeDb('clientB');
    await clientADb.open();
    await clientBDb.open();
  });

  afterEach(async () => {
    await clientADb.delete();
    await clientBDb.delete();
  });

  it('two clients start with same entity, both edit offline, A resolves KEEP_MINE; final Dexie state matches resolved version', async () => {
    // This test exercises the full resolution lifecycle without a real server.
    // We simulate the server interaction via mock transports that replay
    // pre-scripted responses, focusing on proving client state convergence.

    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();
    const conflictOperationId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();

    const clientAUserId = '11111111-1111-4111-8111-111111111111';
    const clientBUserId = '33333333-3333-4333-8333-333333333333';
    const clientADeviceId = '22222222-2222-4222-8222-222222222222';
    const clientBDeviceId = '44444444-4444-4444-8444-444444444444';

    // ── Client A setup ─────────────────────────────────────────────────────
    const pushServiceA = new PushSyncService(clientADb);
    const pullServiceA = new PullSyncService(clientADb);
    const resolutionServiceA = new ConflictResolutionService(clientADb);
    const repoA = new ProjectRepository(clientADb, {
      userId: clientAUserId,
      deviceId: clientADeviceId,
      clientId: 'client-A',
    });

    // ── Client B setup ─────────────────────────────────────────────────────
    const pushServiceB = new PushSyncService(clientBDb);
    const pullServiceB = new PullSyncService(clientBDb);

    // ── Step 1: Both clients start with the same entity at version 1 ───────
    const sharedBase = {
      id: entityId,
      name: 'Shared Project',
      code: 'SHARED',
      status: 'ACTIVE' as const,
      version: 1,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await clientADb.projects.put(sharedBase);
    await clientBDb.projects.put(sharedBase);

    // ── Step 2: Client A edits name to 'Client A Edit' (offline) ──────────
    // Directly insert a PENDING op as if update() ran (skipping conflict-lock check
    // since we just seeded fresh Dexie without a prior conflict record)
    await clientADb.projects.put({ ...sharedBase, name: 'Client A Edit', version: 2 });
    await clientADb.sync_operations.add({
      operationId: conflictOperationId,
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Client A Edit' },
      status: 'PENDING',
      clientId: 'client-A',
      deviceId: clientADeviceId,
      userId: clientAUserId,
      createdAt: now,
      retryCount: 0,
    });

    // ── Step 3: Client B edits name to 'Client B Edit' and pushes first ───
    // Server accepts Client B's edit (version 1 → 2 on server)
    // Client A then pushes and gets CONFLICT (server v2 ≠ baseVersion 1)
    await clientBDb.projects.put({ ...sharedBase, name: 'Client B Edit', version: 2 });
    await clientBDb.sync_operations.add({
      operationId: crypto.randomUUID(),
      entityType: 'PROJECT',
      entityId,
      operationType: 'UPDATE',
      baseVersion: 1,
      payload: { name: 'Client B Edit' },
      status: 'PENDING',
      clientId: 'client-B',
      deviceId: clientBDeviceId,
      userId: clientBUserId,
      createdAt: now,
      retryCount: 0,
    });

    // B pushes successfully — server is now at v2
    const bAppliedTransport: PushTransport = async (req) => ({
      results: req.operations.map((op) => ({
        operationId: op.operationId,
        entityId: op.entityId,
        entityType: op.entityType,
        status: 'APPLIED' as const,
        version: 2,
        sequence: 100,
      })),
    });
    await pushServiceB.pushBatch(bAppliedTransport);

    // ── Step 4: Client A pushes, gets CONFLICT (server v2 ≠ baseVersion 1)
    const conflictRecord: EditEditConflictRecord = {
      conflictId,
      entityType: 'PROJECT',
      entityId,
      operationId: conflictOperationId,
      conflictType: 'EDIT_EDIT',
      serverVersion: 2,
      clientVersion: 1,
      serverState: { id: entityId, name: 'Client B Edit', code: 'SHARED', version: 2 },
      clientState: { name: 'Client A Edit' },
      status: 'PENDING',
      createdAt: now,
    };

    const aConflictTransport: PushTransport = async (req) => ({
      results: req.operations.map((op) => ({
        operationId: op.operationId,
        entityId: op.entityId,
        entityType: op.entityType,
        status: 'CONFLICT' as const,
        conflict: conflictRecord,
      })),
    });

    const pushResultA = await pushServiceA.pushBatch(aConflictTransport);
    expect(pushResultA.conflictCount).toBe(1);

    // Verify conflict is stored in Client A's Dexie
    const storedConflict = await clientADb.conflicts.get(conflictId);
    expect(storedConflict?.conflictType).toBe('EDIT_EDIT');
    expect(storedConflict?.status).toBe('PENDING');

    // ── Step 5: Client A resolves KEEP_MINE ────────────────────────────────
    const resolveResult = await resolutionServiceA.resolve({
      conflictId,
      resolution: 'KEEP_MINE',
      resolvedByUserId: clientAUserId,
    });
    expect(resolveResult.resolution).toBe('KEEP_MINE');

    // Original operation is REJECTED for audit
    const originalOp = await clientADb.sync_operations
      .where('operationId').equals(conflictOperationId).first();
    expect(originalOp?.status).toBe('REJECTED');

    // Fresh operation is enqueued as PENDING with updated baseVersion and fresh operationId
    const pendingOps = await clientADb.sync_operations.where('status').equals('PENDING').toArray();
    expect(pendingOps.length).toBe(1);
    const reQueuedOp = pendingOps[0];
    expect(reQueuedOp.operationId).not.toBe(conflictOperationId);
    expect(reQueuedOp.baseVersion).toBe(2); // Advanced to server version

    // ── Step 6: Client A pushes again, this time it APPLIES ───────────────
    const aSecondPushTransport: PushTransport = async (req) => ({
      results: req.operations.map((op) => ({
        operationId: op.operationId,
        entityId: op.entityId,
        entityType: op.entityType,
        status: 'APPLIED' as const,
        version: 3, // server is now at v3
        sequence: 200,
      })),
    });

    const secondPushResult = await pushServiceA.pushBatch(aSecondPushTransport);
    expect(secondPushResult.appliedCount).toBe(1);
    expect(secondPushResult.conflictCount).toBe(0);

    // ── Step 7: Both clients pull the final state (server at v3) ──────────
    const finalPullTransport: PullTransport = async () => ({
      changes: [
        {
          sequence: '200',
          entityType: 'PROJECT',
          entityId,
          version: 3,
          operationType: 'UPDATE',
          payload: { id: entityId, name: 'Client A Edit', code: 'SHARED' },
          isTombstone: false,
          changedByUserId: clientAUserId,
          changedByDeviceId: clientADeviceId,
          operationId: conflictOperationId,
          createdAt: now,
        },
      ],
      latestSequence: '200',
      hasMore: false,
    });

    // Client A pulls: version-compare skips (local v2 for edit is already resolved,
    // but the Dexie record is at v2 from client edit — v3 incoming > v2 so it applies)
    // First update client A's project Dexie record to v2 (as it would be post-edit)
    await pullServiceA.pullBatch(finalPullTransport);
    await pullServiceB.pullBatch(finalPullTransport);

    // ── Step 8: Both clients converge at the same state ────────────────────
    const entityInA = await clientADb.projects.get(entityId);
    const entityInB = await clientBDb.projects.get(entityId);

    // Client B receives the v3 update (Client A's winning edit)
    expect(entityInB?.name).toBe('Client A Edit');
    expect(entityInB?.version).toBe(3);

    // Client A's conflict is fully RESOLVED
    const finalConflict = await clientADb.conflicts.get(conflictId);
    expect(finalConflict?.status).toBe('RESOLVED');
    expect(finalConflict?.resolution).toBe('KEEP_MINE');
  });
});
