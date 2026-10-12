import { eq, gt, asc, and, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '@fieldcore/database';
import { devices, changeLog, syncCursors, projectMembers } from '@fieldcore/database';
import type { PullRequest, PullResponse, ServerChangeLog } from '@fieldcore/types';
import type { VerifiedAccessToken } from './auth/jwt.js';

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
  /**
   * Verified authentication claims from Bearer token.
   */
  authContext?: VerifiedAccessToken;
  now?: () => string; // Clock injector for testing
}

/**
 * Server pull replication handler.
 * Fetches monotonic change_log entries strictly ascending by sequence > afterSequence,
 * restricted to projects the authenticated user may access.
 * Fire-and-forget updates sync_cursors for server-side observability.
 */
export async function processPullRequest({
  db,
  request,
  authContext,
  now = () => new Date().toISOString(),
}: ProcessPullOptions): Promise<PullResponse> {
  const effectiveDeviceId = authContext?.deviceId ?? request.deviceId;
  const effectiveUserId = authContext?.sub;

  // 1. Device authentication & revocation check:
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, effectiveDeviceId));

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

  // 3. Project scoping & per-project cursor resolution:
  let authorizedProjectIds: string[] | null = null;
  const cursorScope = request.scope ?? 'default';
  const isProjectScoped = cursorScope !== 'default';
  const requestedProjectId = isProjectScoped
    ? (cursorScope.startsWith('project:') ? cursorScope.slice(8) : cursorScope)
    : null;

  if (effectiveUserId) {
    const userMemberships = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, effectiveUserId));

    authorizedProjectIds = userMemberships.map((m) => m.projectId);

    // If user belongs to 0 projects, return immediately with empty changes
    if (authorizedProjectIds.length === 0) {
      return {
        changes: [],
        latestSequence: String(request.afterSequence),
        hasMore: false,
        cursorExpired: false,
      };
    }

    // If a specific project scope is requested, verify user is an authorized member
    if (requestedProjectId && !authorizedProjectIds.includes(requestedProjectId)) {
      return {
        changes: [],
        latestSequence: String(request.afterSequence),
        hasMore: false,
        cursorExpired: false,
      };
    }
  }

  // 4. Query change_log strictly ascending afterSequence up to limit
  const limit = Math.min(Math.max(Number(request.limit ?? 100), 1), 500);
  const afterSeqBigInt = BigInt(request.afterSequence);

  let queryCondition;
  if (requestedProjectId) {
    // Project-specific cursor scope: strictly fetch changes for this project
    queryCondition = and(
      gt(changeLog.sequence, afterSeqBigInt),
      eq(changeLog.projectId, requestedProjectId),
      isNotNull(changeLog.projectId)
    );
  } else if (authorizedProjectIds) {
    // Default scope: fetch changes across all authorized projects (NULL is excluded by SQL inArray)
    queryCondition = and(
      gt(changeLog.sequence, afterSeqBigInt),
      inArray(changeLog.projectId, authorizedProjectIds)
    );
  } else {
    // Unauthenticated fallback: only reachable via direct processPullRequest() calls in unit tests
    // (the /sync/pull route always sets authContext via requireAuth preHandler).
    queryCondition = gt(changeLog.sequence, afterSeqBigInt);
  }

  const rows = await db
    .select()
    .from(changeLog)
    .where(queryCondition)
    .orderBy(asc(changeLog.sequence))
    .limit(limit);

  const changes: ServerChangeLog[] = rows.map((row) => ({
    sequence: String(row.sequence),
    entityType: row.entityType,
    entityId: row.entityId,
    projectId: row.projectId,
    version: row.version,
    operationType: row.operationType,
    payload: row.payload,
    isTombstone: row.isTombstone,
    changedByUserId: row.changedByUserId,
    changedByDeviceId: row.changedByDeviceId,
    operationId: row.operationId,
    createdAt: new Date(row.createdAt).toISOString(),
  }));

  const latestSequence =
    rows.length > 0
      ? String(rows[rows.length - 1].sequence)
      : String(request.afterSequence);

  const hasMore = rows.length === limit;

  // 5. Fire-and-forget sync_cursors update (observability aid, not correctness requirement)
  try {
    const currentIso = now();
    await db
      .insert(syncCursors)
      .values({
        deviceId: effectiveDeviceId,
        scope: cursorScope,
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

  // 6. Update device lastRevalidatedAt and lastSeenAt.
  // Policy: only renew lastRevalidatedAt when actual changes were delivered (non-empty pull).
  // An empty pull (cursor already current, no new changes) does not constitute a successful
  // authorized sync operation and must not extend the offline authentication window.
  try {
    const currentIso = now();
    const deviceUpdates: Record<string, unknown> = {
      lastSeenAt: currentIso,
      updatedAt: currentIso,
    };
    if (rows.length > 0) {
      deviceUpdates.lastRevalidatedAt = currentIso;
    }
    await db
      .update(devices)
      .set(deviceUpdates)
      .where(eq(devices.id, effectiveDeviceId));
  } catch (deviceUpdateErr) {
    console.error('Failed to update device revalidation timestamp:', deviceUpdateErr);
  }

  return {
    changes,
    latestSequence,
    hasMore,
    cursorExpired: false,
  };
}
