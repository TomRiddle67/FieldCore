import { eq, gt, asc } from 'drizzle-orm';
import type { Database } from '@fieldcore/database';
import { devices, changeLog, syncCursors } from '@fieldcore/database';
import type { PullRequest, PullResponse, ServerChangeLog } from '@fieldcore/types';

export class DeviceRevokedError extends Error {
  readonly code = 'DEVICE_REVOKED';
  readonly statusCode = 403;

  constructor(message = 'Device is revoked') {
    super(message);
    this.name = 'DeviceRevokedError';
  }
}

export interface ProcessPullOptions {
  db: Database;
  request: PullRequest;
  now?: () => string; // Clock injector for testing
}

/**
 * Server pull replication handler.
 * Fetches monotonic change_log entries strictly ascending by sequence > afterSequence.
 * Fire-and-forget updates sync_cursors for server-side observability.
 */
export async function processPullRequest({
  db,
  request,
  now = () => new Date().toISOString(),
}: ProcessPullOptions): Promise<PullResponse> {
  // 1. Device authentication & revocation check:
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, request.deviceId));

  if (!device || device.isRevoked) {
    throw new DeviceRevokedError(
      device ? (device.revokedReason ?? 'Device is revoked') : 'Device not registered'
    );
  }

  // 2. Offline authentication window revalidation check:
  const lastRevalidated = new Date(device.lastRevalidatedAt).getTime();
  const windowMs = (device.offlineAuthWindowDays ?? 7) * 24 * 60 * 60 * 1000;
  const nowTime = new Date(now()).getTime();

  if (nowTime - lastRevalidated > windowMs) {
    return {
      changes: [],
      latestSequence: String(request.afterSequence),
      hasMore: false,
      cursorExpired: true,
    };
  }

  // 3. Query change_log strictly ascending afterSequence up to limit
  const limit = Math.min(Math.max(Number(request.limit ?? 100), 1), 500);
  const afterSeqBigInt = BigInt(request.afterSequence);

  const rows = await db
    .select()
    .from(changeLog)
    .where(gt(changeLog.sequence, afterSeqBigInt))
    .orderBy(asc(changeLog.sequence))
    .limit(limit);

  const changes: ServerChangeLog[] = rows.map((row) => ({
    sequence: String(row.sequence),
    entityType: row.entityType,
    entityId: row.entityId,
    version: row.version,
    operationType: row.operationType,
    payload: row.payload,
    isTombstone: row.isTombstone,
    changedByUserId: row.changedByUserId,
    changedByDeviceId: row.changedByDeviceId,
    operationId: row.operationId,
    createdAt: row.createdAt,
  }));

  const latestSequence =
    rows.length > 0
      ? String(rows[rows.length - 1].sequence)
      : String(request.afterSequence);

  const hasMore = rows.length === limit;

  // 4. Fire-and-forget sync_cursors update (observability aid, not correctness requirement)
  try {
    const currentIso = now();
    await db
      .insert(syncCursors)
      .values({
        deviceId: request.deviceId,
        scope: 'default',
        lastServerSequence: BigInt(latestSequence),
        lastSyncAt: currentIso,
        updatedAt: currentIso,
      })
      .onConflictDoUpdate({
        target: [syncCursors.deviceId, syncCursors.scope],
        set: {
          lastServerSequence: BigInt(latestSequence),
          lastSyncAt: currentIso,
          updatedAt: currentIso,
        },
      });
  } catch (cursorErr) {
    // Observability logging must never fail client response
    console.error('Failed to update sync_cursors:', cursorErr);
  }

  return {
    changes,
    latestSequence,
    hasMore,
    cursorExpired: false,
  };
}
