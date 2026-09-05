import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, gt } from 'drizzle-orm';
import {
  createDatabaseClient,
  users,
  devices,
  projects,
  changeLog,
  syncCursors,
} from '@fieldcore/database';
import { createServer } from '../server.js';
import { processPullRequest, DeviceRevokedError } from '../pull-handler.js';
import type { PullRequest } from '@fieldcore/types';

describe('Server Pull Replication Engine', () => {
  const dbUrl = 'postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore';
  const { db, client } = createDatabaseClient(dbUrl);
  const app = createServer({ db });

  const testUserId = randomUUID();
  const testDeviceId = randomUUID();
  const revokedDeviceId = randomUUID();
  const expiredDeviceId = randomUUID();

  beforeAll(async () => {
    await db.insert(users).values({
      id: testUserId,
      email: `pull-user-${randomUUID()}@fieldcore.io`,
      name: 'Pull Sync Engineer',
      role: 'GEOLOGIST',
    });

    await db.insert(devices).values([
      {
        id: testDeviceId,
        userId: testUserId,
        deviceIdentifier: `dev-${randomUUID()}`,
        name: 'Field Toughbook Pull',
        platform: 'DESKTOP',
        isRevoked: false,
        lastRevalidatedAt: new Date().toISOString(),
        offlineAuthWindowDays: 7,
      },
      {
        id: revokedDeviceId,
        userId: testUserId,
        deviceIdentifier: `revoked-${randomUUID()}`,
        name: 'Compromised Device Pull',
        platform: 'DESKTOP',
        isRevoked: true,
        revokedReason: 'Device reported stolen',
        lastRevalidatedAt: new Date().toISOString(),
      },
      {
        id: expiredDeviceId,
        userId: testUserId,
        deviceIdentifier: `expired-${randomUUID()}`,
        name: 'Expired Auth Device Pull',
        platform: 'DESKTOP',
        isRevoked: false,
        lastRevalidatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        offlineAuthWindowDays: 7,
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it('returns empty changes and hasMore: false when afterSequence is at or beyond latest', async () => {
    // Get max current sequence in changeLog
    const latestRows = await db
      .select({ sequence: changeLog.sequence })
      .from(changeLog)
      .orderBy(gt(changeLog.sequence, 0n))
      .limit(1);

    const highSeq = '9999999999';
    const req: PullRequest = {
      deviceId: testDeviceId,
      afterSequence: highSeq,
      limit: 10,
    };

    const res = await processPullRequest({ db, request: req });
    expect(res.changes).toHaveLength(0);
    expect(res.hasMore).toBe(false);
    expect(res.latestSequence).toBe(highSeq);
    expect(res.cursorExpired).toBe(false);
  });

  it('returns rows strictly ascending by sequence with correct latestSequence and hasMore', async () => {
    // Insert 5 known change_log rows
    const nowIso = new Date().toISOString();
    const insertedSeqList: string[] = [];

    for (let i = 1; i <= 5; i++) {
      const [row] = await db
        .insert(changeLog)
        .values({
          entityType: 'PROJECT',
          entityId: randomUUID(),
          version: i,
          operationType: 'CREATE',
          payload: { name: `Batch Project ${i}` },
          isTombstone: false,
          changedByUserId: testUserId,
          changedByDeviceId: testDeviceId,
          operationId: randomUUID(),
          createdAt: nowIso,
        })
        .returning({ sequence: changeLog.sequence });
      insertedSeqList.push(String(row.sequence));
    }

    const startSeq = BigInt(insertedSeqList[0]) - 1n;

    // Pull with limit = 3
    const resPage1 = await processPullRequest({
      db,
      request: {
        deviceId: testDeviceId,
        afterSequence: String(startSeq),
        limit: 3,
      },
    });

    expect(resPage1.changes).toHaveLength(3);
    expect(resPage1.hasMore).toBe(true);
    expect(resPage1.cursorExpired).toBe(false);

    // Assert strictly ascending sequence
    for (let i = 0; i < resPage1.changes.length - 1; i++) {
      const current = BigInt(resPage1.changes[i].sequence);
      const next = BigInt(resPage1.changes[i + 1].sequence);
      expect(next).toBeGreaterThan(current);
    }

    // latestSequence equals the highest sequence in returned changes
    expect(resPage1.latestSequence).toBe(resPage1.changes[2].sequence);

    // Pull next page with limit = 3
    const resPage2 = await processPullRequest({
      db,
      request: {
        deviceId: testDeviceId,
        afterSequence: resPage1.latestSequence,
        limit: 3,
      },
    });

    expect(resPage2.changes.length).toBeGreaterThanOrEqual(2);
    expect(BigInt(resPage2.changes[0].sequence)).toBeGreaterThan(BigInt(resPage1.latestSequence));
  });

  it('updates sync_cursors on server with latest sequence and scope default', async () => {
    const seq = '777888';
    await processPullRequest({
      db,
      request: {
        deviceId: testDeviceId,
        afterSequence: seq,
        limit: 10,
      },
    });

    const [cursor] = await db
      .select()
      .from(syncCursors)
      .where(eq(syncCursors.deviceId, testDeviceId));

    expect(cursor).toBeDefined();
    expect(cursor.scope).toBe('default');
    expect(cursor.lastServerSequence).toBeDefined();
  });

  it('rejects revoked device with DEVICE_REVOKED error and HTTP 403 on route', async () => {
    // 1. Direct handler throws DeviceRevokedError
    await expect(
      processPullRequest({
        db,
        request: {
          deviceId: revokedDeviceId,
          afterSequence: '0',
        },
      })
    ).rejects.toThrow(DeviceRevokedError);

    // 2. HTTP route returns 403
    const response = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${revokedDeviceId}&afterSequence=0`,
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('DEVICE_REVOKED');
  });

  it('returns HTTP 200 with cursorExpired: true when offline window has expired', async () => {
    // Direct handler returns cursorExpired: true, empty changes
    const res = await processPullRequest({
      db,
      request: {
        deviceId: expiredDeviceId,
        afterSequence: '42',
      },
    });

    expect(res.cursorExpired).toBe(true);
    expect(res.changes).toHaveLength(0);
    expect(res.latestSequence).toBe('42');
    expect(res.hasMore).toBe(false);

    // Via HTTP route
    const response = await app.inject({
      method: 'GET',
      url: `/sync/pull?deviceId=${expiredDeviceId}&afterSequence=42`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.cursorExpired).toBe(true);
    expect(body.changes).toHaveLength(0);
  });

  it('never sets cursorExpired: true on valid active device responses in v1', async () => {
    const res = await processPullRequest({
      db,
      request: {
        deviceId: testDeviceId,
        afterSequence: '0',
        limit: 5,
      },
    });

    expect(res.cursorExpired).toBe(false);
  });
});
