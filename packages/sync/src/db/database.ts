import { Dexie, type Table } from 'dexie';
import type {
  Project,
  Site,
  Inspection,
  Measurement,
  SyncOperation,
  ConflictRecord,
  SyncCursor,
} from '@fieldcore/types';

/**
 * FieldCore Dexie Database representing the local-first client storage on IndexedDB.
 */
export class FieldCoreDexie extends Dexie {
  projects!: Table<Project, string>;
  sites!: Table<Site, string>;
  inspections!: Table<Inspection, string>;
  measurements!: Table<Measurement, string>;
  sync_operations!: Table<SyncOperation, number>; // PK is auto-increment localSeq
  conflicts!: Table<ConflictRecord, string>;
  sync_cursors!: Table<SyncCursor, [string, string]>;

  constructor(databaseName = 'fieldcore_offline_db') {
    super(databaseName);

    this.version(1).stores({
      projects: 'id, code, status, version, isDeleted, createdAt, updatedAt',
      sites: 'id, projectId, code, version, isDeleted, createdAt, updatedAt',
      inspections: 'id, siteId, userId, deviceId, status, version, isDeleted, createdAt, updatedAt',
      measurements: 'id, inspectionId, metricType, recordedAt, version, isDeleted, createdAt, updatedAt',
      // localSeq is the canonical ordering key: auto-incremented integer, collision-free.
      // [status+localSeq] replaces [status+createdAt] — timestamps can collide; localSeq cannot.
      sync_operations: '++localSeq, operationId, [deviceId+status], [status+localSeq], entityId, entityType, status, createdAt',
      conflicts: 'conflictId, [entityType+entityId], [entityType+entityId+status], status, conflictType, createdAt',
      sync_cursors: '[deviceId+scope], deviceId, scope, lastServerSequence, lastSyncAt, updatedAt',
    });
  }
}
