import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigserial,
  bigint,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { EntityType, SyncOperationType, SyncStatus, ConflictType } from '@fieldcore/types';

/**
 * Server change log feed.
 * Sequence provides the monotonic cursor for all pull synchronizations.
 */
export const changeLog = pgTable(
  'change_log',
  {
    sequence: bigserial('sequence', { mode: 'bigint' }).primaryKey(),
    entityType: varchar('entity_type', { length: 50 }).notNull().$type<EntityType>(),
    entityId: uuid('entity_id').notNull(),
    version: integer('version').notNull(),
    operationType: varchar('operation_type', { length: 50 }).notNull().$type<SyncOperationType>(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    isTombstone: boolean('is_tombstone').notNull().default(false),
    changedByUserId: uuid('changed_by_user_id').notNull(),
    changedByDeviceId: uuid('changed_by_device_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('change_log_sequence_idx').on(table.sequence),
    index('change_log_entity_idx').on(table.entityType, table.entityId),
    index('change_log_operation_id_idx').on(table.operationId),
  ]
);

/**
 * Server idempotency log for deduplicating client mutations and replaying responses.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    operationId: uuid('operation_id').primaryKey(),
    entityType: varchar('entity_type', { length: 50 }).notNull().$type<EntityType>(),
    entityId: uuid('entity_id').notNull(),
    appliedSequence: bigint('applied_sequence', { mode: 'bigint' }),
    status: varchar('status', { length: 50 }).notNull().$type<'APPLIED' | 'REJECTED' | 'CONFLICT'>(),
    responsePayload: jsonb('response_payload').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('idempotency_entity_idx').on(table.entityType, table.entityId),
  ]
);

/**
 * Conflict log storing divergent server/client states.
 * - EDIT_EDIT: User resolvable (KEEP_SERVER or KEEP_MINE).
 * - EDIT_DELETE: Non-user-resolvable (Delete strictly wins; resolution=KEEP_SERVER, status=RESOLVED, resolvedByUserId=null).
 */
export const conflicts = pgTable(
  'conflicts',
  {
    conflictId: uuid('conflict_id').primaryKey(),
    entityType: varchar('entity_type', { length: 50 }).notNull().$type<EntityType>(),
    entityId: uuid('entity_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    conflictType: varchar('conflict_type', { length: 50 }).notNull().$type<ConflictType>(),
    serverVersion: integer('server_version').notNull(),
    clientVersion: integer('client_version').notNull(),
    serverState: jsonb('server_state').$type<Record<string, unknown> | null>(),
    clientState: jsonb('client_state').notNull().$type<Record<string, unknown>>(),
    status: varchar('status', { length: 50 }).notNull().default('PENDING').$type<'PENDING' | 'RESOLVED'>(),
    resolution: varchar('resolution', { length: 50 }).$type<'KEEP_SERVER' | 'KEEP_MINE'>(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    resolvedByUserId: uuid('resolved_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('conflicts_entity_idx').on(table.entityType, table.entityId),
    index('conflicts_status_idx').on(table.status),
    index('conflicts_type_idx').on(table.conflictType),
    index('conflicts_entity_status_idx').on(table.entityType, table.entityId, table.status),
    check(
      'conflict_edit_delete_invariant_check',
      sql`conflict_type != 'EDIT_DELETE' OR (resolution = 'KEEP_SERVER' AND status = 'RESOLVED' AND resolved_by_user_id IS NULL)`
    ),
  ]
);

/**
 * Client sync cursor checkpoint on server.
 * Composite primary key on (deviceId, scope) enforces strict uniqueness per device scope.
 */
export const syncCursors = pgTable(
  'sync_cursors',
  {
    deviceId: uuid('device_id').notNull(),
    scope: varchar('scope', { length: 100 }).notNull().default('default'),
    lastServerSequence: bigint('last_server_sequence', { mode: 'bigint' }).notNull().default(sql`0`),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.scope] }),
  ]
);

/**
 * Sync audit attempts for observability.
 */
export const syncAttempts = pgTable(
  'sync_attempts',
  {
    attemptId: uuid('attempt_id').primaryKey(),
    deviceId: uuid('device_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
    status: varchar('status', { length: 50 }).notNull().$type<'IN_PROGRESS' | 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILED' | 'ABORTED'>(),
    operationsPushed: integer('operations_pushed').notNull().default(0),
    operationsApplied: integer('operations_applied').notNull().default(0),
    operationsRejected: integer('operations_rejected').notNull().default(0),
    conflictsEncountered: integer('conflicts_encountered').notNull().default(0),
    changesPulled: integer('changes_pulled').notNull().default(0),
    cursorBefore: bigint('cursor_before', { mode: 'bigint' }).notNull().default(sql`0`),
    cursorAfter: bigint('cursor_after', { mode: 'bigint' }).notNull().default(sql`0`),
    errorSummary: text('error_summary'),
  },
  (table) => [
    index('sync_attempts_device_idx').on(table.deviceId),
    index('sync_attempts_status_idx').on(table.status),
  ]
);
