import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@fieldcore/database';
import {
  devices,
  projects,
  sites,
  inspections,
  measurements,
  projectMembers,
  changeLog,
  idempotencyRecords,
  conflicts,
} from '@fieldcore/database';
import type {
  PushRequest,
  PushResponse,
  PushOperationResult,
  EditEditConflictRecord,
  EditDeleteConflictRecord,
  EntityType,
  SyncOperation,
} from '@fieldcore/types';
import type { VerifiedAccessToken } from './auth/jwt.js';

export interface ProcessPushOptions {
  db: Database;
  request: PushRequest;
  /**
   * Verified authentication claims from Bearer token.
   * When present, claims are authoritative for user and device identity.
   */
  authContext?: VerifiedAccessToken;
  /**
   * Optional instrumentation callback fired when the idempotency_records PRIMARY KEY
   * constraint violation (Postgres error 23505) is caught during a concurrent duplicate
   * delivery race. Undefined in production; injected in tests to prove the catch branch
   * was actually executed, not just inferred from outcome invariants.
   */
  onIdempotencyConstraintRace?: () => void;
  /**
   * TEST-ONLY. Must never be wired to anything reachable from the Fastify route handler
   * (request body, headers, config flags, or any runtime-injected value). Exposing it to
   * real traffic would disable the fast-path deduplication for those operation IDs, causing
   * the exact 23505 constraint race this test suite exists to close to become exploitable
   * rather than merely simulatable.
   *
   * Bypasses the fast-path idempotency SELECT for nominated operation IDs so that both
   * sides of a Promise.all() pair enter the transaction path, where the PRIMARY KEY
   * constraint is the actual enforcer. Without this bypass, Node.js's single-threaded
   * event loop serializes the SELECT such that the second request is deduplicated before
   * either request opens a transaction — making the 23505 branch unreachable in-process.
   */
  skipFastPathForOperationIds?: Set<string>;
}

/**
 * Returns the corresponding Drizzle domain table for a given EntityType.
 */
function getDomainTable(entityType: EntityType) {
  switch (entityType) {
    case 'PROJECT':
      return projects;
    case 'SITE':
      return sites;
    case 'INSPECTION':
      return inspections;
    case 'MEASUREMENT':
      return measurements;
    default:
      throw new Error(`Unsupported entityType: ${entityType}`);
  }
}

/**
 * Resolves the target project ID for any entity operation.
 */
async function resolveProjectId(
  tx: any,
  op: SyncOperation,
  existing: any
): Promise<string | null> {
  if (op.entityType === 'PROJECT') {
    return op.entityId;
  }
  if (op.entityType === 'SITE') {
    return (existing?.projectId ?? (op.payload as any)?.projectId ?? null) as string | null;
  }
  if (op.entityType === 'INSPECTION') {
    const siteId = (existing?.siteId ?? (op.payload as any)?.siteId) as string | undefined;
    if (!siteId) return null;
    const [site] = await tx
      .select({ projectId: sites.projectId })
      .from(sites)
      .where(eq(sites.id, siteId));
    return site?.projectId ?? null;
  }
  if (op.entityType === 'MEASUREMENT') {
    const inspectionId = (existing?.inspectionId ?? (op.payload as any)?.inspectionId) as string | undefined;
    if (!inspectionId) return null;
    const [insp] = await tx
      .select({ siteId: inspections.siteId })
      .from(inspections)
      .where(eq(inspections.id, inspectionId));
    if (!insp?.siteId) return null;
    const [site] = await tx
      .select({ projectId: sites.projectId })
      .from(sites)
      .where(eq(sites.id, insp.siteId));
    return site?.projectId ?? null;
  }
  return null;
}

/**
 * Processes a batch push request with per-operation transaction isolation,
 * concurrency-safe idempotency via DB constraints, and conflict classification.
 */
export async function processPushRequest({
  db,
  request,
  authContext,
  onIdempotencyConstraintRace,
  skipFastPathForOperationIds,
}: ProcessPushOptions): Promise<PushResponse> {
  // Use server-authoritative identity from JWT claims if available; fall back to request body for backwards compatibility
  const effectiveDeviceId = authContext?.deviceId ?? request.deviceId;
  const effectiveUserId = authContext?.sub ?? request.operations[0]?.userId;

  // 1. Device authentication & revalidation pre-check:
  // Checked once before per-operation loop gates the entire batch.
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, effectiveDeviceId));

  if (!device || device.isRevoked) {
    return {
      results: request.operations.map((op) => ({
        operationId: op.operationId,
        entityId: op.entityId,
        entityType: op.entityType,
        status: 'DEVICE_REVOKED' as const,
        error: device ? (device.revokedReason ?? 'Device is revoked') : 'Device not registered',
      })),
    };
  }

  const lastRevalidated = new Date(device.lastRevalidatedAt).getTime();
  const windowMs = (device.offlineAuthWindowDays ?? 7) * 24 * 60 * 60 * 1000;
  if (Date.now() - lastRevalidated > windowMs) {
    return {
      results: request.operations.map((op) => ({
        operationId: op.operationId,
        entityId: op.entityId,
        entityType: op.entityType,
        status: 'REQUIRES_REVALIDATION' as const,
        error: 'Device offline authentication window expired. Revalidation required.',
      })),
    };
  }

  const results: PushOperationResult[] = [];

  // 2. Per-operation evaluation: Each operation runs independently.
  for (const op of request.operations) {
    // Fast-path: query idempotency_records to avoid opening transactions for committed retries.
    // Bypassed for nominated IDs in tests to force the transaction-level 23505 race path.
    const skipFastPath = skipFastPathForOperationIds?.has(op.operationId) ?? false;
    if (!skipFastPath) {
      const [cached] = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.operationId, op.operationId));

      if (cached) {
        results.push(cached.responsePayload as unknown as PushOperationResult);
        continue;
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        const table = getDomainTable(op.entityType);

        // Lock existing row inside transaction
        const [existing] = await tx
          .select()
          .from(table)
          .where(eq(table.id, op.entityId))
          .for('update');

        const nowIso = new Date().toISOString();

        // Project membership authorization check
        const projectId = await resolveProjectId(tx, op, existing);
        const isNewProjectCreate = op.entityType === 'PROJECT' && op.operationType === 'CREATE' && !existing;
        let isAuthorized = false;

        if (isNewProjectCreate) {
          isAuthorized = true;
        } else if (projectId && effectiveUserId) {
          const [membership] = await tx
            .select({ id: projectMembers.id })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, projectId),
                eq(projectMembers.userId, effectiveUserId)
              )
            )
            .limit(1);
          isAuthorized = Boolean(membership);
        } else if (!effectiveUserId) {
          isAuthorized = true;
        }

        if (!isAuthorized) {
          const unauthorizedResult: PushOperationResult = {
            operationId: op.operationId,
            entityId: op.entityId,
            entityType: op.entityType,
            status: 'UNAUTHORIZED',
            error: `User is not authorized for project ${projectId ?? 'unknown'}`,
          };
          return unauthorizedResult;
        }

        // Branch A: CREATE operation
        if (op.operationType === 'CREATE') {
          if (existing) {
            // CREATE collision on entityId: treat as EDIT_EDIT conflict
            const conflictRecord: EditEditConflictRecord = {
              conflictId: randomUUID(),
              entityType: op.entityType,
              entityId: op.entityId,
              operationId: op.operationId,
              conflictType: 'EDIT_EDIT',
              serverVersion: existing.version,
              clientVersion: 0,
              serverState: existing as Record<string, unknown>,
              clientState: op.payload,
              status: 'PENDING',
              createdAt: nowIso,
            };

            await tx.insert(conflicts).values({
              conflictId: conflictRecord.conflictId,
              entityType: conflictRecord.entityType,
              entityId: conflictRecord.entityId,
              operationId: conflictRecord.operationId,
              conflictType: 'EDIT_EDIT',
              serverVersion: conflictRecord.serverVersion,
              clientVersion: conflictRecord.clientVersion,
              serverState: conflictRecord.serverState,
              clientState: conflictRecord.clientState,
              status: 'PENDING',
              createdAt: nowIso,
            });

            const conflictResult: PushOperationResult = {
              operationId: op.operationId,
              entityId: op.entityId,
              entityType: op.entityType,
              status: 'CONFLICT',
              conflict: conflictRecord,
            };

            await tx.insert(idempotencyRecords).values({
              operationId: op.operationId,
              entityType: op.entityType,
              entityId: op.entityId,
              status: 'CONFLICT',
              responsePayload: conflictResult as unknown as Record<string, unknown>,
              createdAt: nowIso,
            });

            return conflictResult;
          }

          // Apply CREATE
          const insertPayload: Record<string, unknown> = {
            ...op.payload,
            id: op.entityId,
            version: 1,
            isDeleted: false,
            createdAt: op.createdAt ?? nowIso,
            updatedAt: nowIso,
          };

          if (op.entityType === 'INSPECTION') {
            if (effectiveUserId) insertPayload['userId'] = effectiveUserId;
            insertPayload['deviceId'] = effectiveDeviceId;
          }

          await tx.insert(table).values(insertPayload as any);

          // If new project was created, auto-enroll creator in project_members
          if (isNewProjectCreate && effectiveUserId) {
            await tx.insert(projectMembers).values({
              id: randomUUID(),
              projectId: op.entityId,
              userId: effectiveUserId,
              role: 'OWNER',
              createdAt: nowIso,
            });
          }

          const [change] = await tx
            .insert(changeLog)
            .values({
              entityType: op.entityType,
              entityId: op.entityId,
              projectId: projectId ?? null,
              version: 1,
              operationType: 'CREATE',
              payload: op.payload,
              isTombstone: false,
              changedByUserId: effectiveUserId ?? op.userId,
              changedByDeviceId: effectiveDeviceId,
              operationId: op.operationId,
              createdAt: nowIso,
            })
            .returning({ sequence: changeLog.sequence });

          const sequenceNum = Number(change.sequence);

          const appliedResult: PushOperationResult = {
            operationId: op.operationId,
            entityId: op.entityId,
            entityType: op.entityType,
            status: 'APPLIED',
            version: 1,
            sequence: sequenceNum,
          };

          await tx.insert(idempotencyRecords).values({
            operationId: op.operationId,
            entityType: op.entityType,
            entityId: op.entityId,
            appliedSequence: BigInt(change.sequence),
            status: 'APPLIED',
            responsePayload: appliedResult as unknown as Record<string, unknown>,
            createdAt: nowIso,
          });

          return appliedResult;
        }

        // Branch B: UPDATE or DELETE operations
        if (!existing || existing.isDeleted) {
          // Record deleted or missing -> EDIT_DELETE conflict
          const conflictRecord: EditDeleteConflictRecord = {
            conflictId: randomUUID(),
            entityType: op.entityType,
            entityId: op.entityId,
            operationId: op.operationId,
            conflictType: 'EDIT_DELETE',
            serverVersion: existing ? existing.version : 0,
            clientVersion: op.baseVersion ?? 0,
            serverState: null,
            clientState: op.payload,
            status: 'RESOLVED',
            resolution: 'KEEP_SERVER',
            resolvedAt: nowIso,
            resolvedByUserId: null,
            createdAt: nowIso,
          };

          await tx.insert(conflicts).values({
            conflictId: conflictRecord.conflictId,
            entityType: conflictRecord.entityType,
            entityId: conflictRecord.entityId,
            operationId: conflictRecord.operationId,
            conflictType: 'EDIT_DELETE',
            serverVersion: conflictRecord.serverVersion,
            clientVersion: conflictRecord.clientVersion,
            serverState: null,
            clientState: conflictRecord.clientState,
            status: 'RESOLVED',
            resolution: 'KEEP_SERVER',
            resolvedAt: nowIso,
            resolvedByUserId: null,
            createdAt: nowIso,
          });

          const conflictResult: PushOperationResult = {
            operationId: op.operationId,
            entityId: op.entityId,
            entityType: op.entityType,
            status: 'CONFLICT',
            conflict: conflictRecord,
          };

          await tx.insert(idempotencyRecords).values({
            operationId: op.operationId,
            entityType: op.entityType,
            entityId: op.entityId,
            status: 'CONFLICT',
            responsePayload: conflictResult as unknown as Record<string, unknown>,
            createdAt: nowIso,
          });

          return conflictResult;
        }

        if (existing.version !== op.baseVersion) {
          // Version mismatch -> EDIT_EDIT conflict
          const conflictRecord: EditEditConflictRecord = {
            conflictId: randomUUID(),
            entityType: op.entityType,
            entityId: op.entityId,
            operationId: op.operationId,
            conflictType: 'EDIT_EDIT',
            serverVersion: existing.version,
            clientVersion: op.baseVersion ?? 0,
            serverState: existing as Record<string, unknown>,
            clientState: op.payload,
            status: 'PENDING',
            createdAt: nowIso,
          };

          await tx.insert(conflicts).values({
            conflictId: conflictRecord.conflictId,
            entityType: conflictRecord.entityType,
            entityId: conflictRecord.entityId,
            operationId: conflictRecord.operationId,
            conflictType: 'EDIT_EDIT',
            serverVersion: conflictRecord.serverVersion,
            clientVersion: conflictRecord.clientVersion,
            serverState: conflictRecord.serverState,
            clientState: conflictRecord.clientState,
            status: 'PENDING',
            createdAt: nowIso,
          });

          const conflictResult: PushOperationResult = {
            operationId: op.operationId,
            entityId: op.entityId,
            entityType: op.entityType,
            status: 'CONFLICT',
            conflict: conflictRecord,
          };

          await tx.insert(idempotencyRecords).values({
            operationId: op.operationId,
            entityType: op.entityType,
            entityId: op.entityId,
            status: 'CONFLICT',
            responsePayload: conflictResult as unknown as Record<string, unknown>,
            createdAt: nowIso,
          });

          return conflictResult;
        }

        // Version matches -> Apply mutation
        const nextVersion = existing.version + 1;

        if (op.operationType === 'UPDATE') {
          const updatePayload: Record<string, unknown> = {
            ...op.payload,
            version: nextVersion,
            updatedAt: nowIso,
          };

          if (op.entityType === 'INSPECTION') {
            if (effectiveUserId) updatePayload['userId'] = effectiveUserId;
            updatePayload['deviceId'] = effectiveDeviceId;
          }

          await tx
            .update(table)
            .set(updatePayload)
            .where(eq(table.id, op.entityId));

          const [change] = await tx
            .insert(changeLog)
            .values({
              entityType: op.entityType,
              entityId: op.entityId,
              projectId: projectId ?? null,
              version: nextVersion,
              operationType: 'UPDATE',
              payload: op.payload,
              isTombstone: false,
              changedByUserId: effectiveUserId ?? op.userId,
              changedByDeviceId: effectiveDeviceId,
              operationId: op.operationId,
              createdAt: nowIso,
            })
            .returning({ sequence: changeLog.sequence });

          const sequenceNum = Number(change.sequence);

          const appliedResult: PushOperationResult = {
            operationId: op.operationId,
            entityId: op.entityId,
            entityType: op.entityType,
            status: 'APPLIED',
            version: nextVersion,
            sequence: sequenceNum,
          };

          await tx.insert(idempotencyRecords).values({
            operationId: op.operationId,
            entityType: op.entityType,
            entityId: op.entityId,
            appliedSequence: BigInt(change.sequence),
            status: 'APPLIED',
            responsePayload: appliedResult as unknown as Record<string, unknown>,
            createdAt: nowIso,
          });

          return appliedResult;
        }

        // op.operationType === 'DELETE'
        await tx
          .update(table)
          .set({
            isDeleted: true,
            deletedAt: nowIso,
            version: nextVersion,
            updatedAt: nowIso,
          })
          .where(eq(table.id, op.entityId));

        const [change] = await tx
          .insert(changeLog)
          .values({
            entityType: op.entityType,
            entityId: op.entityId,
            projectId: projectId ?? null,
            version: nextVersion,
            operationType: 'DELETE',
            payload: op.payload,
            isTombstone: true,
            changedByUserId: effectiveUserId ?? op.userId,
            changedByDeviceId: effectiveDeviceId,
            operationId: op.operationId,
            createdAt: nowIso,
          })
          .returning({ sequence: changeLog.sequence });

        const sequenceNum = Number(change.sequence);

        const appliedResult: PushOperationResult = {
          operationId: op.operationId,
          entityId: op.entityId,
          entityType: op.entityType,
          status: 'APPLIED',
          version: nextVersion,
          sequence: sequenceNum,
        };

        await tx.insert(idempotencyRecords).values({
          operationId: op.operationId,
          entityType: op.entityType,
          entityId: op.entityId,
          appliedSequence: BigInt(change.sequence),
          status: 'APPLIED',
          responsePayload: appliedResult as unknown as Record<string, unknown>,
          createdAt: nowIso,
        });

        return appliedResult;
      });

      results.push(result);
    } catch (err: any) {
      // Catch Postgres unique violation (23505) on idempotency_records (concurrent race condition)
      const isUniqueViolation =
        err?.code === '23505' ||
        String(err?.message).includes('23505') ||
        String(err?.message).includes('idempotency_records_pkey') ||
        String(err?.detail).includes('already exists');

      if (isUniqueViolation) {
        onIdempotencyConstraintRace?.();

        const [committed] = await db
          .select()
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.operationId, op.operationId));

        if (committed) {
          results.push(committed.responsePayload as unknown as PushOperationResult);
          continue;
        }
      }

      results.push({
        operationId: op.operationId,
        entityId: op.entityId,
        entityType: op.entityType,
        status: 'REJECTED',
        error: err?.message ?? 'Operation transaction rejected',
      });
    }
  }

  // 3. Update device lastRevalidatedAt and lastSeenAt on successful active batch
  // Only successful requests that satisfy security policy can update lastRevalidatedAt.
  const nowIso = new Date().toISOString();
  const hasSuccessfulAuthorizedOp = results.some(
    (r) => r.status === 'APPLIED' || r.status === 'CONFLICT'
  );

  const deviceUpdates: Record<string, unknown> = {
    lastSeenAt: nowIso,
    updatedAt: nowIso,
  };

  if (hasSuccessfulAuthorizedOp) {
    deviceUpdates.lastRevalidatedAt = nowIso;
  }

  await db
    .update(devices)
    .set(deviceUpdates)
    .where(eq(devices.id, effectiveDeviceId));

  return { results };
}
