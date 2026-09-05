import type { FieldCoreDexie } from '../db/database.js';
import type { ConflictRecord, EntityType, SyncOperation } from '@fieldcore/types';

/**
 * Service exposing sync queue, conflict, and cursor status.
 * Reads solely from local sync metadata tables without touching domain tables.
 */
export class SyncStatusService {
  constructor(private readonly db: FieldCoreDexie) {}

  /**
   * Returns the count of pending mutations in the local sync queue for a device.
   */
  async getPendingCount(deviceId?: string): Promise<number> {
    if (deviceId) {
      return this.db.sync_operations
        .where('[deviceId+status]')
        .equals([deviceId, 'PENDING'])
        .count();
    }
    return this.db.sync_operations.where('status').equals('PENDING').count();
  }

  /**
   * Returns all pending operations for a device, ordered by creation time.
   */
  async getPendingOperations(deviceId?: string): Promise<SyncOperation[]> {
    if (deviceId) {
      // Order by monotonic localSeq — collision-free, unlike createdAt
      return this.db.sync_operations
        .where('[deviceId+status]')
        .equals([deviceId, 'PENDING'])
        .sortBy('localSeq');
    }
    // No deviceId filter: fetch all PENDING and sort by localSeq in JS
    const ops = await this.db.sync_operations.where('status').equals('PENDING').toArray();
    return ops.sort((a, b) => (a.localSeq ?? 0) - (b.localSeq ?? 0));
  }

  /**
   * Returns unresolved (PENDING) conflicts locally cached.
   */
  async getConflicts(entityType?: EntityType): Promise<ConflictRecord[]> {
    if (entityType) {
      return this.db.conflicts
        .where('status')
        .equals('PENDING')
        .filter((c) => c.entityType === entityType)
        .toArray();
    }
    return this.db.conflicts.where('status').equals('PENDING').toArray();
  }

  /**
   * Returns recent conflicts including both PENDING and recently RESOLVED records (e.g. EDIT_DELETE notices).
   */
  async getRecentConflicts(limit = 20): Promise<ConflictRecord[]> {
    const all = await this.db.conflicts.toArray();
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /**
   * Returns the timestamp of the last successful sync checkpoint for a given device and scope.
   */
  async getLastSyncAt(deviceId: string, scope = 'default'): Promise<string | null> {
    const cursor = await this.db.sync_cursors.get([deviceId, scope]);
    return cursor ? cursor.lastSyncAt : null;
  }

  /**
   * Returns the last recorded server sequence cursor for a device.
   */
  async getLastServerSequence(deviceId: string, scope = 'default'): Promise<number | string> {
    const cursor = await this.db.sync_cursors.get([deviceId, scope]);
    return cursor ? cursor.lastServerSequence : 0;
  }
}
