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
   * Atomically writes the domain record and enqueues an associated SyncOperation in a single Dexie transaction.
   *
   * Invariant on instruction order (enforced, not just documented):
   *  1. Assert conflict-lock for UPDATE/DELETE
   *  2. Capture `baseVersion` from the entity's current version BEFORE any increment
   *  3. Construct the SyncOperation with that captured baseVersion (null for CREATE)
   *  4. Write entity with version already incremented
   *  5. Enqueue SyncOperation
   * Both writes are inside one Dexie 'rw' transaction — atomicity guaranteed.
   */
  protected async executeAtomicMutation(
    operationType: SyncOperationType,
    entity: T,
    baseVersion: number | null,
    mutationPayload: Record<string, unknown>
  ): Promise<T> {
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Step 2: Capture baseVersion BEFORE constructing the entity write (caller is responsible
    // for providing baseVersion = null for CREATE, pre-increment version for UPDATE/DELETE).
    const syncOp: SyncOperation = {
      operationId,
      entityType: this.entityType,
      entityId: entity.id,
      operationType,
      baseVersion, // null for CREATE; entity.version - 1 (captured before increment) for UPDATE/DELETE
      payload: mutationPayload,
      status: 'PENDING',
      clientId: this.context.clientId,
      deviceId: this.context.deviceId,
      userId: this.context.userId,
      createdAt: now,
      retryCount: 0,
    };

    await this.db.transaction(
      'rw',
      [this.table, this.db.sync_operations, this.db.conflicts],
      async () => {
        // Step 1: Enforce conflict-lock if modifying existing record
        if (operationType === 'UPDATE' || operationType === 'DELETE') {
          await this.assertNotConflictLocked(entity.id);
        }

        // Step 4+5: Write domain row (entity already carries incremented version), then queue entry
        await this.table.put(entity);
        await this.db.sync_operations.add(syncOp);
      }
    );

    return entity;
  }
}
