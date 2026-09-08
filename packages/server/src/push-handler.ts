import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@fieldcore/database';
import {
  devices,
  projects,
  sites,
  inspections,
  measurements,
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

export interface ProcessPushOptions {
  db: Database;
  request: PushRequest;
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
 * Processes a batch push request with per-operation transaction isolation,
 * concurrency-safe idempotency via DB constraints, and conflict classification.
 */
export async function processPushRequest({
  db,
  request,
  onIdempotencyConstraintRace,
  skipFastPathForOperationIds,
}: ProcessPushOptions): Promise<PushResponse> {
  // 1. Device authentication & revalidation pre-check:
  // Checked once before per-operation loop gates the entire batch.
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, request.deviceId));

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
    if (op.operationId && !skipFastPathForOperationIds?.has(op.operationId)) {
      const [cached] = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.operationId, op.operationId));

      if (cached) {
        const cachedClientVersion = (cached.responsePayload as any)?.conflict?.clientVersion;
        const isResolvedConflictRetry =
          cached.status === 'CONFLICT' &&
          op.baseVersion !== undefined &&
          op.baseVersion !== cachedClientVersion;

        if (!isResolvedConflictRetry) {
          results.push(cached.responsePayload as unknown as PushOperationResult);
          continue;
        }
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

        // If this operation previously recorded a CONFLICT but is being retried
        // after client conflict resolution (e.g. KEEP_MINE with advanced baseVersion),
        // purge the old CONFLICT record so the newly resolved mutation can commit.
        if (op.operationId) {
          await tx
            .delete(idempotencyRecords)
            .where(
              and(
                eq(idempotencyRecords.operationId, op.operationId),
                eq(idempotencyRecords.status, 'CONFLICT')
              )
            );
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
          await tx.insert(table).values({
            ...op.payload,
            id: op.entityId,
            version: 1,
            isDeleted: false,
            createdAt: op.createdAt ?? nowIso,
            updatedAt: nowIso,
          });

          const [change] = await tx
            .insert(changeLog)
            .values({
              entityType: op.entityType,
              entityId: op.entityId,
              version: 1,
              operationType: 'CREATE',
              payload: op.payload,
              isTombstone: false,
              changedByUserId: op.userId,
              changedByDeviceId: op.deviceId,
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
          // Invariant: Non-user-resolvable -> Delete strictly wins, status RESOLVED, resolution KEEP_SERVER
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
          await tx
            .update(table)
            .set({
              ...op.payload,
              version: nextVersion,
              updatedAt: nowIso,
            })
            .where(eq(table.id, op.entityId));

          const [change] = await tx
            .insert(changeLog)
            .values({
              entityType: op.entityType,
              entityId: op.entityId,
              version: nextVersion,
              operationType: 'UPDATE',
              payload: op.payload,
              isTombstone: false,
              changedByUserId: op.userId,
              changedByDeviceId: op.deviceId,
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
            version: nextVersion,
            operationType: 'DELETE',
            payload: op.payload,
            isTombstone: true,
            changedByUserId: op.userId,
            changedByDeviceId: op.deviceId,
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
        // Signal to test instrumentation that this exact branch fired (not just that
        // the outcome looks correct). In production this callback is undefined.
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

      // Any other unexpected failure -> reject this operation independently
      results.push({
        operationId: op.operationId,
        entityId: op.entityId,
        entityType: op.entityType,
        status: 'REJECTED',
        error: err?.message ?? 'Operation transaction rejected',
      });
    }
  }

  return { results };
}
