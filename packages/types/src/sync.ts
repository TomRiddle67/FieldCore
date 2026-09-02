import type { EntityType } from './domain.js';

/**
 * Mutation operation types.
 */
export type SyncOperationType = 'CREATE' | 'UPDATE' | 'DELETE';

/**
 * Coherent state model for local and sync queue operations.
 */
export type SyncStatus =
  | 'PENDING'
  | 'SYNCING'
  | 'SYNCED'
  | 'CONFLICT'
  | 'REJECTED'
  | 'REQUIRES_REVALIDATION'
  | 'DEVICE_REVOKED';

/**
 * Types of conflicts detected during optimistic concurrency checks.
 */
export type ConflictType = 'EDIT_EDIT' | 'EDIT_DELETE';

/**
 * Conflict resolution strategy options for v1 (whole-record).
 */
export type ConflictResolution = 'KEEP_SERVER' | 'KEEP_MINE';

/**
 * Contextual metadata when evaluating a state transition out of conditional states like CONFLICT.
 */
export interface SyncTransitionContext {
  conflictType?: ConflictType;
  conflictResolution?: ConflictResolution | null;
}

/**
 * Valid state transitions for SyncStatus state machine.
 */
export const ALLOWED_SYNC_STATUS_TRANSITIONS: Record<SyncStatus, readonly SyncStatus[]> = {
  PENDING: ['SYNCING', 'REQUIRES_REVALIDATION'],
  SYNCING: ['SYNCED', 'CONFLICT', 'REJECTED', 'REQUIRES_REVALIDATION', 'DEVICE_REVOKED', 'PENDING'],
  SYNCED: [], // Terminal for that operation instance
  CONFLICT: ['PENDING', 'REJECTED'], // Strictly conditioned on ConflictType and resolution (fail closed)
  REJECTED: ['PENDING'], // Optional manual intervention / correction resets to PENDING
  REQUIRES_REVALIDATION: ['PENDING', 'DEVICE_REVOKED'], // Revalidation success -> PENDING; failure -> DEVICE_REVOKED
  DEVICE_REVOKED: [], // Terminal state
} as const;

/**
 * Helper to validate sync status transitions with context-aware gating.
 * Fails closed on conditional states like CONFLICT if context is omitted.
 */
export function isValidSyncStatusTransition(
  from: SyncStatus,
  to: SyncStatus,
  context?: SyncTransitionContext
): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_SYNC_STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) return false;

  // Gating specifically for exiting CONFLICT (Fail Closed)
  if (from === 'CONFLICT') {
    if (!context?.conflictType) {
      // Cannot leave CONFLICT without knowing what kind of conflict was resolved
      return false;
    }
    if (context.conflictType === 'EDIT_DELETE') {
      // EDIT_DELETE conflicts strictly terminate at REJECTED (Delete wins; discarded edit cannot re-enter queue)
      return to === 'REJECTED';
    }
    if (context.conflictType === 'EDIT_EDIT') {
      if (context.conflictResolution === 'KEEP_MINE') return to === 'PENDING';
      if (context.conflictResolution === 'KEEP_SERVER') return to === 'REJECTED';
      // Resolution not yet set or invalid — fail closed
      return false;
    }
    return false; // Unknown conflictType — fail closed
  }

  return true;
}

/**
 * Derives the resulting SyncStatus for an operation after a conflict is resolved.
 */
export function resolveConflictOperationStatus(
  conflictType: ConflictType,
  resolution: ConflictResolution
): SyncStatus {
  if (conflictType === 'EDIT_DELETE') {
    // Non-user-resolvable: Delete strictly wins, operation terminates as REJECTED
    return 'REJECTED';
  }
  // EDIT_EDIT: KEEP_MINE re-queues to PENDING; KEEP_SERVER discards to REJECTED
  return resolution === 'KEEP_MINE' ? 'PENDING' : 'REJECTED';
}

/**
 * Client and server mutation unit of work.
 */
export interface SyncOperation<T = Record<string, unknown>> {
  operationId: string; // Globally unique mutation UUIDv4 (idempotency key)
  entityType: EntityType;
  entityId: string; // Target entity UUIDv4
  operationType: SyncOperationType;
  baseVersion: number; // The version the client based this mutation on
  payload: T; // Payload changes / snapshot
  status: SyncStatus;
  clientId: string;
  deviceId: string;
  userId: string;
  createdAt: string;
  attemptedAt?: string | null;
  retryCount: number;
  errorMessage?: string | null;
}

/**
 * Monotonic server change feed entry for pull replication.
 */
export interface ServerChangeLog<T = Record<string, unknown>> {
  sequence: number | string; // Monotonically increasing BIGSERIAL
  entityType: EntityType;
  entityId: string;
  version: number;
  operationType: SyncOperationType;
  payload: T;
  isTombstone: boolean;
  changedByUserId: string;
  changedByDeviceId: string;
  operationId: string;
  createdAt: string;
}

/**
 * Server idempotency cache record for deduplicating mutations and replaying responses.
 */
export interface IdempotencyRecord<T = Record<string, unknown>> {
  operationId: string; // UUIDv4
  entityType: EntityType;
  entityId: string;
  appliedSequence: number | string;
  status: 'APPLIED' | 'REJECTED' | 'CONFLICT';
  responsePayload: T;
  createdAt: string;
}

/**
 * Conflict state lifecycle.
 */
export type ConflictStatus = 'PENDING' | 'RESOLVED';

/**
 * Base fields shared by all conflict records.
 */
interface BaseConflictRecord {
  conflictId: string; // UUIDv4
  entityType: EntityType;
  entityId: string;
  operationId: string;
  serverVersion: number;
  clientVersion: number;
  createdAt: string;
}

/**
 * Conflict representation for concurrent edits (EDIT_EDIT).
 * Requires explicit user resolution.
 */
export interface EditEditConflictRecord<
  TServer = Record<string, unknown>,
  TClient = Record<string, unknown>
> extends BaseConflictRecord {
  conflictType: 'EDIT_EDIT';
  serverState: TServer;
  clientState: TClient;
  status: ConflictStatus;
  resolution?: ConflictResolution | null;
  resolvedAt?: string | null;
  resolvedByUserId?: string | null;
}

/**
 * Conflict representation for client edit against deleted server record (EDIT_DELETE).
 * Non-user-resolvable: Delete strictly wins.
 * Automatically resolved at creation time with resolution = KEEP_SERVER.
 * Discarded client edit is retained in clientState for audit only.
 */
export interface EditDeleteConflictRecord<
  TClient = Record<string, unknown>
> extends BaseConflictRecord {
  conflictType: 'EDIT_DELETE';
  serverState: null; // Server state is deleted
  clientState: TClient; // Client edit preserved for audit only
  status: 'RESOLVED';
  resolution: 'KEEP_SERVER';
  resolvedAt: string;
  resolvedByUserId: null; // System-resolved, never a human decision
}

/**
 * Discriminated union of conflict records.
 */
export type ConflictRecord<
  TServer = Record<string, unknown>,
  TClient = Record<string, unknown>
> = EditEditConflictRecord<TServer, TClient> | EditDeleteConflictRecord<TClient>;

/**
 * Client sync cursor tracking progress along the server change sequence.
 */
export interface SyncCursor {
  deviceId: string;
  scope: string; // e.g. "default" or project-specific
  lastServerSequence: number | string;
  lastSyncAt: string;
  updatedAt: string;
}

/**
 * Status of a synchronization session.
 */
export type SyncAttemptStatus =
  | 'IN_PROGRESS'
  | 'SUCCESS'
  | 'PARTIAL_FAILURE'
  | 'FAILED'
  | 'ABORTED';

/**
 * Synchronization audit attempt record.
 */
export interface SyncAttempt {
  attemptId: string;
  deviceId: string;
  startedAt: string;
  completedAt?: string | null;
  status: SyncAttemptStatus;
  operationsPushed: number;
  operationsApplied: number;
  operationsRejected: number;
  conflictsEncountered: number;
  changesPulled: number;
  cursorBefore: number | string;
  cursorAfter: number | string;
  errorSummary?: string | null;
}

/**
 * Batch push synchronization request payload.
 */
export interface PushRequest {
  deviceId: string;
  operations: SyncOperation[];
}

/**
 * Single operation outcome in push response.
 */
export interface PushOperationResult {
  operationId: string;
  entityId: string;
  entityType: EntityType;
  status: 'APPLIED' | 'CONFLICT' | 'REJECTED' | 'REQUIRES_REVALIDATION' | 'DEVICE_REVOKED';
  version?: number;
  sequence?: number | string;
  conflict?: ConflictRecord;
  error?: string;
}

/**
 * Push synchronization response payload.
 */
export interface PushResponse {
  results: PushOperationResult[];
}

/**
 * Pull synchronization request parameters.
 */
export interface PullRequest {
  deviceId: string;
  afterSequence: number | string;
  limit?: number;
}

/**
 * Pull synchronization response payload.
 */
export interface PullResponse {
  changes: ServerChangeLog[];
  latestSequence: number | string;
  hasMore: boolean;
  cursorExpired?: boolean;
}
