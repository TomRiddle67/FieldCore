import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { PushSyncService, type PushTransport } from '../services/push-sync.js';
import { ProjectRepository } from '../repository/project.js';
import type { PushRequest, PushResponse, PushOperationResult } from '@fieldcore/types';

describe('PushSyncService (Client Sync Engine)', () => {
  let db: FieldCoreDexie;
  let pushService: PushSyncService;
  let projectRepo: ProjectRepository;

  const testUserId = '11111111-1111-4111-8111-111111111111';
  const testDeviceId = '22222222-2222-4222-8222-222222222222';
  const testClientId = 'client-1';

  beforeEach(async () => {
    db = new FieldCoreDexie(`test_push_db_${Date.now()}_${Math.random()}`);
    await db.open();
    pushService = new PushSyncService(db);
    projectRepo = new ProjectRepository(db, {
      userId: testUserId,
      deviceId: testDeviceId,
      clientId: testClientId,
    });
  });

  it('batches pending operations up to 25 in strictly ascending localSeq order', async () => {
    // Create 30 projects offline
    for (let i = 1; i <= 30; i++) {
      await projectRepo.create({
        name: `Project ${i}`,
        code: `PRJ-${i}`,
      });
    }

    let capturedRequest: PushRequest | null = null;
    const mockTransport: PushTransport = async (req) => {
      capturedRequest = req;
      return {
        results: req.operations.map((op) => ({
          operationId: op.operationId,
          entityId: op.entityId,
          entityType: op.entityType,
          status: 'APPLIED',
          version: 1,
          sequence: op.localSeq,
        })),
      };
    };

    const result = await pushService.pushBatch(mockTransport, { batchSize: 25 });
    expect(result.pushedCount).toBe(25);
    expect(result.appliedCount).toBe(25);
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.operations).toHaveLength(25);

    // Verify strictly ascending localSeq order: 1, 2, ..., 25
    for (let i = 0; i < capturedRequest!.operations.length; i++) {
      expect(capturedRequest!.operations[i].localSeq).toBe(i + 1);
    }

    // Remaining 5 operations should still be PENDING with localSeq 26..30
    const remaining = await db.sync_operations.where('status').equals('PENDING').toArray();
    expect(remaining).toHaveLength(5);
    expect(remaining[0].localSeq).toBe(26);
  });

  it('recovers dangling SYNCING operations on crash/restart by resetting them to PENDING', async () => {
    const project = await projectRepo.create({ name: 'Crash Test Project', code: 'CTP-1' });
    const [op] = await db.sync_operations.where('entityId').equals(project.id).toArray();

    // Simulate crash mid-flight: status was set to SYNCING before process died
    await db.sync_operations.where('operationId').equals(op.operationId).modify({
      status: 'SYNCING',
      attemptedAt: new Date().toISOString(),
    });

    // App restarts and runs recovery before initiating sync
    const recoveredCount = await pushService.recoverDanglingSyncingOperations();
    expect(recoveredCount).toBe(1);

    const [recoveredOp] = await db.sync_operations.where('operationId').equals(op.operationId).toArray();
    expect(recoveredOp.status).toBe('PENDING');
    expect(recoveredOp.errorMessage).toContain('Recovered from interrupted sync session');

    // Subsequent push succeeds normally
    const mockTransport: PushTransport = async (req) => ({
      results: [
        {
          operationId: req.operations[0].operationId,
          entityId: req.operations[0].entityId,
          entityType: req.operations[0].entityType,
          status: 'APPLIED',
          version: 1,
          sequence: 100,
        },
      ],
    });

    const pushRes = await pushService.pushBatch(mockTransport);
    expect(pushRes.appliedCount).toBe(1);

    const [syncedOp] = await db.sync_operations.where('operationId').equals(op.operationId).toArray();
    expect(syncedOp.status).toBe('SYNCED');
  });

  it('handles EDIT_DELETE conflict by auto-resolving to KEEP_SERVER and transitioning to REJECTED (never PENDING)', async () => {
    const project = await projectRepo.create({ name: 'Deleted On Server', code: 'DOS-1' });

    const mockTransport: PushTransport = async (req) => ({
      results: [
        {
          operationId: req.operations[0].operationId,
          entityId: req.operations[0].entityId,
          entityType: req.operations[0].entityType,
          status: 'CONFLICT',
          conflict: {
            conflictId: '33333333-3333-4333-8333-333333333333',
            entityType: 'PROJECT',
            entityId: req.operations[0].entityId,
            operationId: req.operations[0].operationId,
            conflictType: 'EDIT_DELETE',
            serverVersion: 2,
            clientVersion: 1,
            serverState: null,
            clientState: req.operations[0].payload,
            status: 'RESOLVED',
            resolution: 'KEEP_SERVER',
            resolvedAt: new Date().toISOString(),
            resolvedByUserId: null,
            createdAt: new Date().toISOString(),
          },
        },
      ],
    });

    const pushRes = await pushService.pushBatch(mockTransport);
    expect(pushRes.conflictCount).toBe(1);
    expect(pushRes.rejectedCount).toBe(1);

    // Invariant: local operation MUST transition to REJECTED, never PENDING
    const [op] = await db.sync_operations.toArray();
    expect(op.status).toBe('REJECTED');
    expect(op.errorMessage).toContain('Delete wins');

    // Local conflict record stored
    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictType).toBe('EDIT_DELETE');
    expect(conflicts[0].status).toBe('RESOLVED');
  });

  it('handles DEVICE_REVOKED by transitioning to terminal DEVICE_REVOKED and halting retries', async () => {
    await projectRepo.create({ name: 'Revoked Op', code: 'RO-1' });

    const mockTransport: PushTransport = async (req) => ({
      results: [
        {
          operationId: req.operations[0].operationId,
          entityId: req.operations[0].entityId,
          entityType: req.operations[0].entityType,
          status: 'DEVICE_REVOKED',
          error: 'This device was reported stolen and revoked by admin.',
        },
      ],
    });

    const pushRes = await pushService.pushBatch(mockTransport);
    expect(pushRes.deviceRevokedCount).toBe(1);

    const [op] = await db.sync_operations.toArray();
    expect(op.status).toBe('DEVICE_REVOKED');
    expect(op.errorMessage).toContain('stolen');
  });

  it('handles REQUIRES_REVALIDATION and resets to PENDING upon resolveRevalidationSuccess()', async () => {
    await projectRepo.create({ name: 'Expired Auth Op', code: 'EA-1' });

    const mockTransport: PushTransport = async (req) => ({
      results: [
        {
          operationId: req.operations[0].operationId,
          entityId: req.operations[0].entityId,
          entityType: req.operations[0].entityType,
          status: 'REQUIRES_REVALIDATION',
          error: 'Offline authentication window expired.',
        },
      ],
    });

    await pushService.pushBatch(mockTransport);

    const [heldOp] = await db.sync_operations.toArray();
    expect(heldOp.status).toBe('REQUIRES_REVALIDATION');

    // Online revalidation succeeds
    const unblockedCount = await pushService.resolveRevalidationSuccess(testDeviceId);
    expect(unblockedCount).toBe(1);

    const [unblockedOp] = await db.sync_operations.toArray();
    expect(unblockedOp.status).toBe('PENDING');
  });

  it('implements exponential backoff with jitter on transport errors and excludes backed-off operations until eligible', async () => {
    await projectRepo.create({ name: 'Backoff Op', code: 'BO-1' });

    let nowTime = 1000000;
    const nowFn = () => new Date(nowTime).toISOString();

    const failingTransport: PushTransport = async () => {
      throw new Error('Network timeout (ECONNREFUSED)');
    };

    // First failed attempt
    const res1 = await pushService.pushBatch(failingTransport, { now: nowFn });
    expect(res1.pushedCount).toBe(1);
    expect(res1.appliedCount).toBe(0);
    expect(res1.error).toContain('ECONNREFUSED');

    const [backedOffOp] = await db.sync_operations.toArray();
    expect(backedOffOp.status).toBe('PENDING');
    expect(backedOffOp.retryCount).toBe(1);
    expect(backedOffOp.nextEligibleRetryAt).toBeDefined();

    const retryAt = new Date(backedOffOp.nextEligibleRetryAt!).getTime();
    expect(retryAt).toBeGreaterThan(nowTime);

    // Second immediate push: operation should be filtered out by backoff
    const res2 = await pushService.pushBatch(failingTransport, { now: nowFn });
    expect(res2.pushedCount).toBe(0); // Excluded!

    // Advance simulated time past nextEligibleRetryAt
    nowTime = retryAt + 500;
    const res3 = await pushService.pushBatch(failingTransport, { now: nowFn });
    expect(res3.pushedCount).toBe(1); // Eligible again!

    const [retry2Op] = await db.sync_operations.toArray();
    expect(retry2Op.retryCount).toBe(2);
  });

  it('caps retries at 10 and surfaces for manual attention', async () => {
    await projectRepo.create({ name: 'Excessive Retries', code: 'ER-1' });
    const [op] = await db.sync_operations.toArray();

    // Set retryCount to 9
    await db.sync_operations.where('operationId').equals(op.operationId).modify({
      retryCount: 9,
    });

    const failingTransport: PushTransport = async () => {
      throw new Error('500 Server Failure');
    };

    await pushService.pushBatch(failingTransport);

    const [failedOp] = await db.sync_operations.toArray();
    expect(failedOp.retryCount).toBe(10);
    expect(failedOp.errorMessage).toContain('Manual attention required');
  });

  it('handles partial batch failure without losing already-acknowledged operations', async () => {
    const p1 = await projectRepo.create({ name: 'Op 1', code: 'OP-1' });
    const p2 = await projectRepo.create({ name: 'Op 2', code: 'OP-2' });
    const p3 = await projectRepo.create({ name: 'Op 3', code: 'OP-3' });

    const ops = await db.sync_operations.toArray();
    expect(ops).toHaveLength(3);

    // Transport simulates op 1 applied, op 2 conflict, op 3 unacknowledged (e.g. timeout mid-batch)
    const mockTransport: PushTransport = async () => ({
      results: [
        {
          operationId: ops[0].operationId,
          entityId: ops[0].entityId,
          entityType: ops[0].entityType,
          status: 'APPLIED',
          version: 1,
          sequence: 1,
        },
        {
          operationId: ops[1].operationId,
          entityId: ops[1].entityId,
          entityType: ops[1].entityType,
          status: 'CONFLICT',
          conflict: {
            conflictId: '44444444-4444-4444-8444-444444444444',
            entityType: 'PROJECT',
            entityId: ops[1].entityId,
            operationId: ops[1].operationId,
            conflictType: 'EDIT_EDIT',
            serverVersion: 2,
            clientVersion: 1,
            serverState: { name: 'Server P2' },
            clientState: ops[1].payload,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
          },
        },
        // ops[2] missing from results!
      ],
    });

    await pushService.pushBatch(mockTransport);

    const [op1State] = await db.sync_operations.where('operationId').equals(ops[0].operationId).toArray();
    const [op2State] = await db.sync_operations.where('operationId').equals(ops[1].operationId).toArray();
    const [op3State] = await db.sync_operations.where('operationId').equals(ops[2].operationId).toArray();

    expect(op1State.status).toBe('SYNCED'); // Acknowledged!
    expect(op2State.status).toBe('CONFLICT'); // Conflict recorded!
    expect(op3State.status).toBe('PENDING'); // Unacknowledged -> reset to PENDING for retry!
  });
});
