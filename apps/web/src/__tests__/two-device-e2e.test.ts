import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
  FieldCoreDexie,
  ProjectRepository,
  ConflictResolutionService,
  PushSyncService,
  PullSyncService,
  type PushTransport,
  type PullTransport,
} from '@fieldcore/sync';

describe('Stage 6 Two-Device Convergence & Conflict Resolution E2E (Live Server)', () => {
  const DEVICE_A_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const DEVICE_B_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const BASE_URL = 'http://localhost:3000';

  const makePushTransport = (): PushTransport => async (batch) => {
    const res = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    return res.json();
  };

  const makePullTransport = (): PullTransport => async (req) => {
    const params = new URLSearchParams({
      deviceId: req.deviceId,
      afterSequence: String(req.afterSequence),
      limit: String(req.limit),
    });
    const res = await fetch(`${BASE_URL}/sync/pull?${params.toString()}`);
    return res.json();
  };

  it('proves two devices converge to v3 after 409 conflict and KEEP_MINE resolution', async () => {
    // 1. Initialize Device A
    const dbA = new FieldCoreDexie(`fieldcore_test_A_${Date.now()}`);
    const contextA = { userId: USER_ID, deviceId: DEVICE_A_ID, clientId: 'client-a' };
    const repoA = new ProjectRepository(dbA, contextA);
    const pushA = new PushSyncService(dbA);
    const pullA = new PullSyncService(dbA);
    const resolverA = new ConflictResolutionService(dbA);

    // 2. Initialize Device B
    const dbB = new FieldCoreDexie(`fieldcore_test_B_${Date.now()}`);
    const contextB = { userId: USER_ID, deviceId: DEVICE_B_ID, clientId: 'client-b' };
    const repoB = new ProjectRepository(dbB, contextB);
    const pushB = new PushSyncService(dbB);
    const pullB = new PullSyncService(dbB);

    const pushTransport = makePushTransport();
    const pullTransport = makePullTransport();

    // Step 1: Device A creates project "Sync Anchor Project"
    const projectCode = `SAP-${Date.now().toString().slice(-4)}`;
    const createdProject = await repoA.create({
      name: 'Sync Anchor Project',
      code: projectCode,
    });
    expect(createdProject.version).toBe(1);

    // Step 2: Device A pushes to server
    const pushResultA1 = await pushA.pushBatch(pushTransport, { deviceId: contextA.deviceId });
    expect(pushResultA1.pushedCount).toBe(1);
    expect(pushResultA1.conflictCount).toBe(0);

    // Step 3: Device B pulls from server
    const pullResultB1 = await pullB.pullAll(pullTransport, { deviceId: contextB.deviceId });
    expect(pullResultB1.totalApplied).toBeGreaterThanOrEqual(1);
    const projectOnB = await repoB.getById(createdProject.id);
    expect(projectOnB).not.toBeNull();
    expect(projectOnB?.name).toBe('Sync Anchor Project');
    expect(projectOnB?.version).toBe(1);

    // Step 4: Device B edits to "Device B Wins" and pushes (advancing server to v2)
    const updatedOnB = await repoB.update(createdProject.id, {
      name: 'Device B Wins',
    });
    expect(updatedOnB.name).toBe('Device B Wins');
    const pushResultB1 = await pushB.pushBatch(pushTransport, { deviceId: contextB.deviceId });
    expect(pushResultB1.pushedCount).toBe(1);
    expect(pushResultB1.conflictCount).toBe(0);

    // Step 5: Device A (offline/concurrent) edits to "Device A Local Edit" (baseVersion: 1)
    const updatedOnA = await repoA.update(createdProject.id, {
      name: 'Device A Local Edit',
    });
    expect(updatedOnA.name).toBe('Device A Local Edit');

    // Step 6: Device A pushes -> encounters 409 Conflict because server is at v2
    const pushResultA2 = await pushA.pushBatch(pushTransport, { deviceId: contextA.deviceId });
    expect(pushResultA2.conflictCount).toBe(1);

    // Verify conflict drawer state on Device A
    const conflictsOnA = await dbA.conflicts.toArray();
    expect(conflictsOnA.length).toBe(1);
    const conflict = conflictsOnA[0];
    expect(conflict.entityId).toBe(createdProject.id);
    expect(conflict.serverVersion).toBe(2);
    expect((conflict.serverState as any).name).toBe('Device B Wins');
    expect(conflict.status).toBe('PENDING');

    // Step 7: Device A user inspects diff in Conflict Drawer and clicks [Keep Mine]
    const resolveResult = await resolverA.resolve({
      conflictId: conflict.conflictId,
      resolution: 'KEEP_MINE',
      resolvedByUserId: USER_ID,
    });
    expect(resolveResult.resolution).toBe('KEEP_MINE');

    // Verify conflict is marked RESOLVED and new operation is queued with baseVersion: 2
    const resolvedConflict = await dbA.conflicts.get(conflict.conflictId);
    expect(resolvedConflict?.status).toBe('RESOLVED');
    expect(resolvedConflict?.resolution).toBe('KEEP_MINE');

    // Verify original conflicting operation is marked REJECTED (terminal, for audit)
    const origOpOnA = await dbA.sync_operations.where('operationId').equals(conflict.operationId).first();
    expect(origOpOnA?.status).toBe('REJECTED');

    // Fresh operation is enqueued as PENDING with fresh operationId, fresh localSeq, and baseVersion: 2
    const pendingOpsOnA = await dbA.sync_operations.where('status').equals('PENDING').toArray();
    expect(pendingOpsOnA.length).toBe(1);
    expect(pendingOpsOnA[0].operationId).not.toBe(conflict.operationId);
    expect(pendingOpsOnA[0].baseVersion).toBe(2);

    // Step 8: Device A syncs again -> push succeeds at v3
    const pushResultA3 = await pushA.pushBatch(pushTransport, { deviceId: contextA.deviceId });
    expect(pushResultA3.pushedCount).toBe(1);
    expect(pushResultA3.conflictCount).toBe(0);

    // Step 9: Device A and Device B pull from server -> pulls v3
    const pullResultA = await pullA.pullAll(pullTransport, { deviceId: contextA.deviceId });
    expect(pullResultA.totalApplied).toBeGreaterThanOrEqual(1);

    const pullResultB2 = await pullB.pullAll(pullTransport, { deviceId: contextB.deviceId });
    expect(pullResultB2.totalApplied).toBeGreaterThanOrEqual(1);

    const liveOnA = await repoA.getById(createdProject.id);
    const liveOnB = await repoB.getById(createdProject.id);

    expect(liveOnA?.name).toBe('Device A Local Edit');
    expect(liveOnA?.version).toBe(3);

    expect(liveOnB?.name).toBe('Device A Local Edit');
    expect(liveOnB?.version).toBe(3);

    // Invariant: Both devices have fully converged to "Mine" at v3!
    expect(liveOnA?.name).toEqual(liveOnB?.name);
    expect(liveOnA?.version).toEqual(liveOnB?.version);
  });
});
