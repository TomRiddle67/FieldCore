import type { FieldCoreDexie } from '../db/database.js';
import type {
  ConflictResolution,
  ConflictRecord,
  EditEditConflictRecord,
  EntityType,
} from '@fieldcore/types';

/**
 * Thrown when resolve() is called for a conflictId that does not exist in
 * the local conflicts table.
 */
export class ConflictNotFoundError extends Error {
  constructor(public readonly conflictId: string) {
    super(`ConflictResolutionService: conflict '${conflictId}' not found in local store.`);
    this.name = 'ConflictNotFoundError';
  }
}

/**
 * Thrown when resolve() is called for a conflict whose type is not EDIT_EDIT.
 * EDIT_DELETE conflicts are auto-resolved at creation time (Delete wins) and
 * are never surfaced to the user.
 */
export class NonResolvableConflictError extends Error {
  constructor(
    public readonly conflictId: string,
    public readonly conflictType: string
  ) {
    super(
      `ConflictResolutionService: conflict '${conflictId}' has type '${conflictType}' and is not user-resolvable. ` +
        `Only EDIT_EDIT conflicts may be resolved via this service.`
    );
    this.name = 'NonResolvableConflictError';
  }
}

/**
 * Thrown when resolve() is called for a conflict that is already RESOLVED.
 */
export class ConflictAlreadyResolvedError extends Error {
  constructor(public readonly conflictId: string) {
    super(`ConflictResolutionService: conflict '${conflictId}' is already resolved.`);
    this.name = 'ConflictAlreadyResolvedError';
  }
}

export interface ResolveOptions {
  /**
   * The conflictId (from ConflictRecord) to resolve.
   */
  conflictId: string;
  /**
   * Resolution strategy:
   *   KEEP_SERVER — overwrite local domain record with serverState, discard client edit (REJECTED)
   *   KEEP_MINE   — re-queue client edit as PENDING against current live server version
   */
  resolution: ConflictResolution;
  /**
   * The ID of the user performing the resolution.
   */
  resolvedByUserId: string;
  /**
   * Clock provider for deterministic testing. Defaults to () => new Date().toISOString().
   */
  now?: () => string;
}

export interface ResolveResult {
  conflictId: string;
  resolution: ConflictResolution;
  /**
   * Reclassified to EDIT_DELETE if the entity was found to be deleted on
   * the live domain record at resolution time.
   */
  reclassifiedToEditDelete?: boolean;
  /**
   * The fresh operationId minted for the re-queued operation under KEEP_MINE.
   */
  newOperationId?: string;
}

/**
 * Returns the corresponding Dexie domain table for an EntityType.
 * (Local mirror of PullSyncService#getTable — kept here to avoid cross-service coupling.)
 */
function getDomainTable(db: FieldCoreDexie, entityType: EntityType) {
  switch (entityType) {
    case 'PROJECT':
      return db.projects;
    case 'SITE':
      return db.sites;
    case 'INSPECTION':
      return db.inspections;
    case 'MEASUREMENT':
      return db.measurements;
    default:
      throw new Error(
        `ConflictResolutionService: unsupported entityType '${entityType}'.`
      );
  }
}

/**
 * Client-side Conflict Resolution Service.
 *
 * Resolves EDIT_EDIT conflicts via two strategies:
 *
 *   KEEP_SERVER:
 *     - Overwrites the local domain record with conflict.serverState (no extra round-trip).
 *     - Transitions the linked sync_operation from CONFLICT → REJECTED.
 *     - Marks the ConflictRecord as RESOLVED.
 *
 *   KEEP_MINE:
 *     - Re-queues the linked sync_operation from CONFLICT → PENDING (next pushBatch will retry).
 *     - Updates the operation's baseVersion to the current live serverVersion so the server
 *       does NOT produce a second conflict for the same stale-version mismatch.
 *     - Local domain record is left as-is (client's optimistic state is already in Dexie).
 *     - Marks the ConflictRecord as RESOLVED.
 *
 * Pull reclassification:
 *     - If, at resolution time, the local entity is found to be deleted (isDeleted === true),
 *       the conflict is reclassified to EDIT_DELETE semantics: KEEP_SERVER is enforced
 *       regardless of the chosen resolution, and the operation transitions to REJECTED.
 *       The ConflictRecord conflictType is updated to 'EDIT_DELETE' and resolution to 'KEEP_SERVER'.
 *
 * All writes happen inside one Dexie 'rw' transaction.
 */
export class ConflictResolutionService {
  constructor(private readonly db: FieldCoreDexie) {}

  /**
   * Resolves an EDIT_EDIT conflict by the given strategy.
   * All side effects are committed atomically in a single Dexie transaction.
   */
  async resolve(options: ResolveOptions): Promise<ResolveResult> {
    const { conflictId, resolution, resolvedByUserId, now = () => new Date().toISOString() } =
      options;

    const nowIso = now();

    return this.db.transaction(
      'rw',
      [
        this.db.conflicts,
        this.db.sync_operations,
        this.db.projects,
        this.db.sites,
        this.db.inspections,
        this.db.measurements,
      ],
      async (): Promise<ResolveResult> => {
        // 1. Load and validate the conflict record
        const conflict = await this.db.conflicts.get(conflictId);

        if (!conflict) {
          throw new ConflictNotFoundError(conflictId);
        }

        if (conflict.conflictType !== 'EDIT_EDIT') {
          throw new NonResolvableConflictError(conflictId, conflict.conflictType);
        }

        if (conflict.status === 'RESOLVED') {
          throw new ConflictAlreadyResolvedError(conflictId);
        }

        const editEditConflict = conflict as EditEditConflictRecord;

        // 2. Check live entity state — pull may have updated it since the conflict was recorded
        const table = getDomainTable(this.db, conflict.entityType);
        const liveEntity: any = await table.get(conflict.entityId);

        // Reclassification: if the entity is now deleted, KEEP_SERVER is the only valid outcome
        const isDeleted = liveEntity?.isDeleted === true;

        const effectiveResolution: ConflictResolution = isDeleted ? 'KEEP_SERVER' : resolution;
        let reclassifiedToEditDelete = false;

        if (isDeleted) {
          reclassifiedToEditDelete = true;
          // Update the conflict record to reflect the reclassification
          await this.db.conflicts.update(conflictId, {
            conflictType: 'EDIT_DELETE' as any,
            status: 'RESOLVED',
            resolution: 'KEEP_SERVER',
            resolvedAt: nowIso,
            resolvedByUserId,
          });
        } else {
          // Mark conflict as resolved with the chosen resolution
          await this.db.conflicts.update(conflictId, {
            status: 'RESOLVED',
            resolution: effectiveResolution,
            resolvedAt: nowIso,
            resolvedByUserId,
          });
        }

        // 3. Find the linked sync_operation (must be in CONFLICT status)
        const linkedOp = await this.db.sync_operations
          .where('operationId')
          .equals(conflict.operationId)
          .first();

        let newOperationId: string | undefined;

        if (effectiveResolution === 'KEEP_SERVER') {
          // 3a. KEEP_SERVER: overwrite local domain record with serverState, reject the operation.
          // serverState already reflects the authoritative server snapshot captured at conflict time.
          if (liveEntity && editEditConflict.serverState && !isDeleted) {
            const serverState = editEditConflict.serverState as any;
            await table.put({
              ...liveEntity,
              ...serverState,
              id: conflict.entityId,
              version: conflict.serverVersion,
            });
          }

          if (linkedOp) {
            await this.db.sync_operations
              .where('operationId')
              .equals(conflict.operationId)
              .modify({
                status: 'REJECTED',
                errorMessage: isDeleted
                  ? 'Reclassified EDIT_DELETE: server entity was deleted. Delete wins.'
                  : 'Resolved KEEP_SERVER: client edit discarded in favour of server state.',
              });
          }
        } else {
          // 3b. KEEP_MINE:
          // Invariant (Stage 5 Lock): The re-queued mutation gets a fresh operationId
          // and fresh localSeq on KEEP_MINE — it is a new mutation attempt, not a replay.
          // The original conflicting operation stays REJECTED (terminal, for audit).
          const updatedBaseVersion = liveEntity?.version != null
            ? Math.max(liveEntity.version, conflict.serverVersion)
            : conflict.serverVersion;

          if (linkedOp) {
            await this.db.sync_operations
              .where('operationId')
              .equals(conflict.operationId)
              .modify({
                status: 'REJECTED',
                errorMessage: 'Superseded by KEEP_MINE re-queued operation.',
              });

            newOperationId = crypto.randomUUID();
            const freshOp = {
              operationId: newOperationId,
              entityType: linkedOp.entityType,
              entityId: linkedOp.entityId,
              operationType: linkedOp.operationType,
              baseVersion: updatedBaseVersion,
              payload: linkedOp.payload,
              status: 'PENDING' as const,
              clientId: linkedOp.clientId,
              deviceId: linkedOp.deviceId,
              userId: linkedOp.userId,
              createdAt: nowIso,
              retryCount: 0,
              errorMessage: null,
              nextEligibleRetryAt: null,
            };

            await this.db.sync_operations.add(freshOp);
          }
          // Local domain record remains as-is: the optimistic state in Dexie is what the user wants kept.
        }

        return {
          conflictId,
          resolution: effectiveResolution,
          reclassifiedToEditDelete,
          newOperationId,
        };
      }
    );
  }

  /**
   * Returns all unresolved (PENDING) EDIT_EDIT conflicts for a given entity.
   */
  async getPendingConflicts(entityId: string, entityType: EntityType): Promise<ConflictRecord[]> {
    return this.db.conflicts
      .where('[entityType+entityId+status]')
      .equals([entityType, entityId, 'PENDING'])
      .toArray();
  }

  /**
   * Returns all local conflict records, ordered by createdAt ascending.
   */
  async listAll(): Promise<ConflictRecord[]> {
    return this.db.conflicts.orderBy('createdAt').toArray();
  }
}
