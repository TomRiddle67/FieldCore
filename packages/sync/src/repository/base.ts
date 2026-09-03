import type { Table } from 'dexie';
import type { FieldCoreDexie } from '../db/database.js';
import type {
  EntityType,
  SyncOperation,
  SyncOperationType,
} from '@fieldcore/types';

/**
 * Error thrown when an update or delete is attempted on a record with an unresolved conflict.
 */
export class RecordConflictLockedError extends Error {
  constructor(
    public readonly entityType: EntityType,
    public readonly entityId: string,
    public readonly conflictId: string
  ) {
    super(
      `Cannot modify ${entityType} with ID ${entityId}: record is read-only locked due to unresolved conflict ${conflictId}.`
    );
    this.name = 'RecordConflictLockedError';
  }
}

/**
 * Base domain model constraint.
 */
export interface BaseDomainEntity {
  id: string;
  version: number;
  isDeleted: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Session context for local repository mutations.
 */
export interface RepositoryContext {
  userId: string;
  deviceId: string;
  clientId: string;
}

/**
 * Abstract Base Repository executing atomic mutations and conflict lock validation.
 */
export abstract class BaseRepository<T extends BaseDomainEntity> {
  constructor(
    protected readonly db: FieldCoreDexie,
    protected readonly table: Table<T, string>,
    public readonly entityType: EntityType,
    protected readonly context: RepositoryContext
  ) {}

  /**
   * Retrieves an entity by its ID (returns null if not found or if isDeleted is true by default).
   */
  async getById(id: string, includeDeleted = false): Promise<T | null> {
    const record = await this.table.get(id);
    if (!record) return null;
    if (record.isDeleted && !includeDeleted) return null;
    return record;
  }

  /**
   * Asserts that the record has no unresolved conflicts. Throws RecordConflictLockedError if locked.
   */
  protected async assertNotConflictLocked(entityId: string): Promise<void> {
    const pendingConflict = await this.db.conflicts
      .where('[entityType+entityId+status]')
      .equals([this.entityType, entityId, 'PENDING'])
      .first();

    if (pendingConflict) {
      throw new RecordConflictLockedError(
        this.entityType,
        entityId,
        pendingConflict.conflictId
      );
    }
  }

  /**
   * Atomically reads current state, applies the mutator, and enqueues the
   * SyncOperation — all inside one Dexie transaction. The mutator receives
   * the current row (or null for CREATE) and must return the new row plus
   * the baseVersion to record.
   *
   * This is the ONLY entry point repositories should use for CREATE/UPDATE/DELETE.
   * No repository should read this.table or compute a version outside this method.
   *
   * Why: Dexie serializes 'rw' transactions on the same table, so a second
   * call to update() that starts before this one commits will block and see
   * this write's result, not the stale pre-write state. Moving the read
   * inside the transaction closes the lost-update window that existed when
   * callers did `const existing = await this.table.get(id)` before calling
   * this method.
   */
  protected async executeAtomicMutation(
    operationType: SyncOperationType,
    entityId: string,
    mutate: (current: T | null) => { entity: T; baseVersion: number | null },
    buildPayload: (entity: T) => Record<string, unknown>
  ): Promise<T> {
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();

    return this.db.transaction(
      'rw',
      [this.table, this.db.sync_operations, this.db.conflicts],
      async () => {
        // 1. Enforce conflict-lock if modifying existing record
        if (operationType === 'UPDATE' || operationType === 'DELETE') {
          await this.assertNotConflictLocked(entityId);
        }

        // 2. Read happens INSIDE the transaction — serialized against concurrent writes
        const current = (await this.table.get(entityId)) ?? null;

        // 3. Mutator captures baseVersion from current state and builds new entity
        const { entity, baseVersion } = mutate(current);

        // 4. Build sync operation with captured baseVersion
        const syncOp: SyncOperation = {
          operationId,
          entityType: this.entityType,
          entityId: entity.id,
          operationType,
          baseVersion,
          payload: buildPayload(entity),
          status: 'PENDING',
          clientId: this.context.clientId,
          deviceId: this.context.deviceId,
          userId: this.context.userId,
          createdAt: now,
          retryCount: 0,
        };

        // 5. Write domain row, then enqueue operation (localSeq auto-assigned by Dexie)
        await this.table.put(entity);
        await this.db.sync_operations.add(syncOp);

        return entity;
      }
    );
  }
}
