import { z } from 'zod';
import { entityTypeSchema, uuidSchema } from './domain.js';
import {
  isValidSyncStatusTransition,
  resolveConflictOperationStatus,
} from '@fieldcore/types';

/**
 * Mutation types for synchronization operations.
 */
export const syncOperationTypeSchema = z.enum(['CREATE', 'UPDATE', 'DELETE']);

/**
 * Coherent state machine statuses for sync operations.
 */
export const syncStatusSchema = z.enum([
  'PENDING',
  'SYNCING',
  'SYNCED',
  'CONFLICT',
  'REJECTED',
  'REQUIRES_REVALIDATION',
  'DEVICE_REVOKED',
]);

/**
 * Conflict classification types.
 */
export const conflictTypeSchema = z.enum(['EDIT_EDIT', 'EDIT_DELETE']);

/**
 * Whole-record conflict resolution choices for v1.
 */
export const conflictResolutionSchema = z.enum(['KEEP_SERVER', 'KEEP_MINE']);

/**
 * Conflict status schema.
 */
export const conflictStatusSchema = z.enum(['PENDING', 'RESOLVED']);

/**
 * Validates a status transition in the sync state machine with optional conflict context.
 */
export const syncStatusTransitionSchema = z
  .object({
    from: syncStatusSchema,
    to: syncStatusSchema,
    conflictType: conflictTypeSchema.optional(),
    conflictResolution: conflictResolutionSchema.nullable().optional(),
  })
  .refine(
    ({ from, to, conflictType, conflictResolution }) =>
      isValidSyncStatusTransition(from, to, {
        conflictType,
        conflictResolution,
      }),
    {
      message: 'Invalid state machine transition for SyncStatus',
    }
  );

/**
 * Sync operation validation schema.
 */
export const syncOperationSchema = z.object({
  operationId: uuidSchema,
  entityType: entityTypeSchema,
  entityId: uuidSchema,
  operationType: syncOperationTypeSchema,
  baseVersion: z.number().int().min(0),
  payload: z.record(z.unknown()),
  status: syncStatusSchema.default('PENDING'),
  clientId: z.string().min(1),
  deviceId: uuidSchema,
  userId: uuidSchema,
  createdAt: z.string().datetime(),
  attemptedAt: z.string().datetime().nullable().optional(),
  retryCount: z.number().int().min(0).default(0),
  errorMessage: z.string().nullable().optional(),
});

/**
 * Base schema for conflict records.
 */
const baseConflictSchema = {
  conflictId: uuidSchema,
  entityType: entityTypeSchema,
  entityId: uuidSchema,
  operationId: uuidSchema,
  serverVersion: z.number().int().min(0),
  clientVersion: z.number().int().min(0),
  createdAt: z.string().datetime(),
};

/**
 * EDIT_EDIT conflict schema: Concurrent edit on live record.
 * Requires user decision (KEEP_SERVER or KEEP_MINE).
 */
export const editEditConflictRecordSchema = z.object({
  ...baseConflictSchema,
  conflictType: z.literal('EDIT_EDIT'),
  serverState: z.record(z.unknown()),
  clientState: z.record(z.unknown()),
  status: conflictStatusSchema.default('PENDING'),
  resolution: conflictResolutionSchema.nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
  resolvedByUserId: uuidSchema.nullable().optional(),
});

/**
 * EDIT_DELETE conflict schema: Client edited record that was deleted on server.
 * Non-user-resolvable: Delete strictly wins.
 * Auto-resolved at creation time with resolution = KEEP_SERVER.
 * Discarded client edit is stored in clientState for audit only.
 */
export const editDeleteConflictRecordSchema = z.object({
  ...baseConflictSchema,
  conflictType: z.literal('EDIT_DELETE'),
  serverState: z.null().optional().default(null),
  clientState: z.record(z.unknown()),
  status: z.literal('RESOLVED'),
  resolution: z.literal('KEEP_SERVER'),
  resolvedAt: z.string().datetime(),
  resolvedByUserId: z.null().optional().default(null),
});

/**
 * Discriminated union of conflict records keyed on `conflictType`.
 */
export const conflictRecordSchema = z.discriminatedUnion('conflictType', [
  editEditConflictRecordSchema,
  editDeleteConflictRecordSchema,
]);

/**
 * Sync cursor tracking schema.
 */
export const syncCursorSchema = z.object({
  deviceId: uuidSchema,
  scope: z.string().min(1).default('default'),
  lastServerSequence: z.union([z.number().int().min(0), z.string()]),
  lastSyncAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Sync attempt status enum.
 */
export const syncAttemptStatusSchema = z.enum([
  'IN_PROGRESS',
  'SUCCESS',
  'PARTIAL_FAILURE',
  'FAILED',
  'ABORTED',
]);

/**
 * Sync attempt audit schema.
 */
export const syncAttemptSchema = z.object({
  attemptId: uuidSchema,
  deviceId: uuidSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  status: syncAttemptStatusSchema,
  operationsPushed: z.number().int().min(0),
  operationsApplied: z.number().int().min(0),
  operationsRejected: z.number().int().min(0),
  conflictsEncountered: z.number().int().min(0),
  changesPulled: z.number().int().min(0),
  cursorBefore: z.union([z.number().int().min(0), z.string()]),
  cursorAfter: z.union([z.number().int().min(0), z.string()]),
  errorSummary: z.string().nullable().optional(),
});

/**
 * Push request payload schema.
 */
export const pushRequestSchema = z.object({
  deviceId: uuidSchema,
  operations: z.array(syncOperationSchema).min(1),
});

/**
 * Pull request query schema.
 */
export const pullRequestSchema = z.object({
  deviceId: uuidSchema,
  afterSequence: z.union([
    z.number().int().min(0),
    z.string().regex(/^\d+$/, 'afterSequence must be a non-negative integer string'),
  ]),
  limit: z.number().int().min(1).max(500).default(100),
});
