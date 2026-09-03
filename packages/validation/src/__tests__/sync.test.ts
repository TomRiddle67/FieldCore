import { describe, it, expect } from 'vitest';
import {
  syncOperationSchema,
  conflictRecordSchema,
  pullRequestSchema,
  pushRequestSchema,
  syncStatusTransitionSchema,
} from '../sync.js';
import {
  isValidSyncStatusTransition,
  resolveConflictOperationStatus,
} from '@fieldcore/types';

describe('Sync Model & Protocol Schemas', () => {
  const validUUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const now = new Date().toISOString();

  describe('SyncOperation Schema', () => {
    it('validates a CREATE sync operation with baseVersion: null and optional localSeq', () => {
      const op = {
        operationId: validUUID,
        localSeq: 1,
        entityType: 'PROJECT',
        entityId: validUUID,
        operationType: 'CREATE',
        baseVersion: null,
        payload: {
          name: 'Project Alpha',
          code: 'ALPHA-1',
        },
        status: 'PENDING',
        clientId: 'client-device-1',
        deviceId: validUUID,
        userId: validUUID,
        createdAt: now,
        retryCount: 0,
      };
      const result = syncOperationSchema.safeParse(op);
      expect(result.success).toBe(true);
    });

    it('REJECTS CREATE sync operation with baseVersion = 0 (Must be null)', () => {
      const op = {
        operationId: validUUID,
        entityType: 'PROJECT',
        entityId: validUUID,
        operationType: 'CREATE',
        baseVersion: 0,
        payload: { name: 'Project Alpha' },
        status: 'PENDING',
        clientId: 'client-device-1',
        deviceId: validUUID,
        userId: validUUID,
        createdAt: now,
      };
      const result = syncOperationSchema.safeParse(op);
      expect(result.success).toBe(false);
    });

    it('validates an UPDATE sync operation with positive integer baseVersion', () => {
      const op = {
        operationId: validUUID,
        localSeq: 2,
        entityType: 'MEASUREMENT',
        entityId: validUUID,
        operationType: 'UPDATE',
        baseVersion: 3,
        payload: { numericValue: 42.0 },
        status: 'REQUIRES_REVALIDATION',
        clientId: 'client-device-1',
        deviceId: validUUID,
        userId: validUUID,
        createdAt: now,
      };
      const result = syncOperationSchema.safeParse(op);
      expect(result.success).toBe(true);
    });

    it('REJECTS UPDATE sync operation with baseVersion = null (Must have baseVersion >= 1)', () => {
      const op = {
        operationId: validUUID,
        entityType: 'MEASUREMENT',
        entityId: validUUID,
        operationType: 'UPDATE',
        baseVersion: null,
        payload: { numericValue: 42.0 },
        status: 'PENDING',
        clientId: 'client-device-1',
        deviceId: validUUID,
        userId: validUUID,
        createdAt: now,
      };
      const result = syncOperationSchema.safeParse(op);
      expect(result.success).toBe(false);
    });
  });

  describe('Sync Status Transitions & Conflict-Type Gating (Fail-Closed)', () => {
    it('allows REQUIRES_REVALIDATION -> PENDING (revalidation succeeds)', () => {
      expect(isValidSyncStatusTransition('REQUIRES_REVALIDATION', 'PENDING')).toBe(true);
      const result = syncStatusTransitionSchema.safeParse({
        from: 'REQUIRES_REVALIDATION',
        to: 'PENDING',
      });
      expect(result.success).toBe(true);
    });

    it('allows REQUIRES_REVALIDATION -> DEVICE_REVOKED (revalidation fails, device revoked)', () => {
      expect(isValidSyncStatusTransition('REQUIRES_REVALIDATION', 'DEVICE_REVOKED')).toBe(true);
      const result = syncStatusTransitionSchema.safeParse({
        from: 'REQUIRES_REVALIDATION',
        to: 'DEVICE_REVOKED',
      });
      expect(result.success).toBe(true);
    });

    it('rejects direct REQUIRES_REVALIDATION -> SYNCED transition', () => {
      expect(isValidSyncStatusTransition('REQUIRES_REVALIDATION', 'SYNCED')).toBe(false);
      const result = syncStatusTransitionSchema.safeParse({
        from: 'REQUIRES_REVALIDATION',
        to: 'SYNCED',
      });
      expect(result.success).toBe(false);
    });

    it('rejects transitions out of terminal DEVICE_REVOKED state', () => {
      expect(isValidSyncStatusTransition('DEVICE_REVOKED', 'SYNCING')).toBe(false);
      expect(isValidSyncStatusTransition('DEVICE_REVOKED', 'PENDING')).toBe(false);
      const result = syncStatusTransitionSchema.safeParse({
        from: 'DEVICE_REVOKED',
        to: 'SYNCING',
      });
      expect(result.success).toBe(false);
    });

    it('FAILS CLOSED: strictly rejects CONFLICT -> PENDING and CONFLICT -> REJECTED when context is omitted', () => {
      expect(isValidSyncStatusTransition('CONFLICT', 'PENDING')).toBe(false);
      expect(isValidSyncStatusTransition('CONFLICT', 'PENDING', {})).toBe(false);
      expect(isValidSyncStatusTransition('CONFLICT', 'REJECTED')).toBe(false);
      expect(isValidSyncStatusTransition('CONFLICT', 'REJECTED', {})).toBe(false);

      const result = syncStatusTransitionSchema.safeParse({
        from: 'CONFLICT',
        to: 'PENDING',
      });
      expect(result.success).toBe(false);
    });

    it('FAILS CLOSED: rejects CONFLICT -> PENDING for EDIT_EDIT if resolution is not yet specified', () => {
      expect(
        isValidSyncStatusTransition('CONFLICT', 'PENDING', {
          conflictType: 'EDIT_EDIT',
        })
      ).toBe(false);
    });

    it('allows EDIT_EDIT conflict with KEEP_MINE to transition CONFLICT -> PENDING (re-queue with new baseVersion)', () => {
      expect(
        isValidSyncStatusTransition('CONFLICT', 'PENDING', {
          conflictType: 'EDIT_EDIT',
          conflictResolution: 'KEEP_MINE',
        })
      ).toBe(true);

      const result = syncStatusTransitionSchema.safeParse({
        from: 'CONFLICT',
        to: 'PENDING',
        conflictType: 'EDIT_EDIT',
        conflictResolution: 'KEEP_MINE',
      });
      expect(result.success).toBe(true);
      expect(resolveConflictOperationStatus('EDIT_EDIT', 'KEEP_MINE')).toBe('PENDING');
    });

    it('allows EDIT_EDIT conflict with KEEP_SERVER to transition CONFLICT -> REJECTED (discard local edit)', () => {
      expect(
        isValidSyncStatusTransition('CONFLICT', 'REJECTED', {
          conflictType: 'EDIT_EDIT',
          conflictResolution: 'KEEP_SERVER',
        })
      ).toBe(true);

      const result = syncStatusTransitionSchema.safeParse({
        from: 'CONFLICT',
        to: 'REJECTED',
        conflictType: 'EDIT_EDIT',
        conflictResolution: 'KEEP_SERVER',
      });
      expect(result.success).toBe(true);
      expect(resolveConflictOperationStatus('EDIT_EDIT', 'KEEP_SERVER')).toBe('REJECTED');
    });

    it('STRICTLY ALLOWS EDIT_DELETE conflict to transition CONFLICT -> REJECTED only', () => {
      expect(
        isValidSyncStatusTransition('CONFLICT', 'REJECTED', {
          conflictType: 'EDIT_DELETE',
          conflictResolution: 'KEEP_SERVER',
        })
      ).toBe(true);

      const result = syncStatusTransitionSchema.safeParse({
        from: 'CONFLICT',
        to: 'REJECTED',
        conflictType: 'EDIT_DELETE',
        conflictResolution: 'KEEP_SERVER',
      });
      expect(result.success).toBe(true);
      expect(resolveConflictOperationStatus('EDIT_DELETE', 'KEEP_SERVER')).toBe('REJECTED');
    });

    it('STRICTLY REJECTS EDIT_DELETE conflict attempting CONFLICT -> PENDING (Prevents resurrection bug)', () => {
      expect(
        isValidSyncStatusTransition('CONFLICT', 'PENDING', {
          conflictType: 'EDIT_DELETE',
          conflictResolution: 'KEEP_SERVER',
        })
      ).toBe(false);

      const result = syncStatusTransitionSchema.safeParse({
        from: 'CONFLICT',
        to: 'PENDING',
        conflictType: 'EDIT_DELETE',
        conflictResolution: 'KEEP_SERVER',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ConflictRecord Schema & Edit-vs-Delete Invariant', () => {
    it('validates EDIT_EDIT conflict record with pending state for user decision', () => {
      const conflict = {
        conflictId: validUUID,
        entityType: 'SITE',
        entityId: validUUID,
        operationId: validUUID,
        conflictType: 'EDIT_EDIT',
        serverVersion: 3,
        clientVersion: 2,
        serverState: { name: 'Site North (Server)', code: 'SN-01', version: 3 },
        clientState: { name: 'Site North (Client Edit)', code: 'SN-01', version: 2 },
        status: 'PENDING',
        createdAt: now,
      };
      const result = conflictRecordSchema.safeParse(conflict);
      expect(result.success).toBe(true);
    });

    it('validates EDIT_EDIT resolved with KEEP_MINE or KEEP_SERVER by a user', () => {
      const resolvedConflict = {
        conflictId: validUUID,
        entityType: 'SITE',
        entityId: validUUID,
        operationId: validUUID,
        conflictType: 'EDIT_EDIT',
        serverVersion: 3,
        clientVersion: 2,
        serverState: { name: 'Site North (Server)', version: 3 },
        clientState: { name: 'Site North (Client Edit)', version: 2 },
        status: 'RESOLVED',
        resolution: 'KEEP_MINE',
        resolvedAt: now,
        resolvedByUserId: validUUID,
        createdAt: now,
      };
      const result = conflictRecordSchema.safeParse(resolvedConflict);
      expect(result.success).toBe(true);
    });

    it('validates auto-resolved EDIT_DELETE conflict with KEEP_SERVER and null resolvedByUserId', () => {
      const deleteConflict = {
        conflictId: validUUID,
        entityType: 'SITE',
        entityId: validUUID,
        operationId: validUUID,
        conflictType: 'EDIT_DELETE',
        serverVersion: 3,
        clientVersion: 2,
        serverState: null,
        clientState: { name: 'Site North (Attempted Edit)', code: 'SN-01', version: 2 },
        status: 'RESOLVED',
        resolution: 'KEEP_SERVER',
        resolvedAt: now,
        resolvedByUserId: null,
        createdAt: now,
      };
      const result = conflictRecordSchema.safeParse(deleteConflict);
      expect(result.success).toBe(true);
    });

    it('REJECTS EDIT_DELETE conflict attempting KEEP_MINE (Delete strictly wins)', () => {
      const illegalConflict = {
        conflictId: validUUID,
        entityType: 'SITE',
        entityId: validUUID,
        operationId: validUUID,
        conflictType: 'EDIT_DELETE',
        serverVersion: 3,
        clientVersion: 2,
        serverState: null,
        clientState: { name: 'Site North' },
        status: 'RESOLVED',
        resolution: 'KEEP_MINE', // ILLEGAL for EDIT_DELETE
        resolvedAt: now,
        createdAt: now,
      };
      const result = conflictRecordSchema.safeParse(illegalConflict);
      expect(result.success).toBe(false);
    });

    it('REJECTS EDIT_DELETE conflict with PENDING status (Must be auto-resolved)', () => {
      const illegalConflict = {
        conflictId: validUUID,
        entityType: 'SITE',
        entityId: validUUID,
        operationId: validUUID,
        conflictType: 'EDIT_DELETE',
        serverVersion: 3,
        clientVersion: 2,
        serverState: null,
        clientState: { name: 'Site North' },
        status: 'PENDING', // ILLEGAL for EDIT_DELETE
        resolution: 'KEEP_SERVER',
        resolvedAt: now,
        createdAt: now,
      };
      const result = conflictRecordSchema.safeParse(illegalConflict);
      expect(result.success).toBe(false);
    });

    it('REJECTS EDIT_DELETE conflict with human resolvedByUserId (Must be system-resolved)', () => {
      const illegalConflict = {
        conflictId: validUUID,
        entityType: 'SITE',
        entityId: validUUID,
        operationId: validUUID,
        conflictType: 'EDIT_DELETE',
        serverVersion: 3,
        clientVersion: 2,
        serverState: null,
        clientState: { name: 'Site North' },
        status: 'RESOLVED',
        resolution: 'KEEP_SERVER',
        resolvedAt: now,
        resolvedByUserId: validUUID, // ILLEGAL: system-resolved, not human
        createdAt: now,
      };
      const result = conflictRecordSchema.safeParse(illegalConflict);
      expect(result.success).toBe(false);
    });
  });

  describe('Push & Pull Request Schemas', () => {
    it('validates push request with operations batch', () => {
      const pushReq = {
        deviceId: validUUID,
        operations: [
          {
            operationId: validUUID,
            entityType: 'PROJECT',
            entityId: validUUID,
            operationType: 'CREATE',
            baseVersion: null,
            payload: { name: 'New Project', code: 'NP-1' },
            status: 'PENDING',
            clientId: 'client-1',
            deviceId: validUUID,
            userId: validUUID,
            createdAt: now,
          },
        ],
      };
      const result = pushRequestSchema.safeParse(pushReq);
      expect(result.success).toBe(true);
    });

    it('validates pull request with sequence cursor', () => {
      const pullReq = {
        deviceId: validUUID,
        afterSequence: 1024,
        limit: 50,
      };
      const result = pullRequestSchema.safeParse(pullReq);
      expect(result.success).toBe(true);
    });
  });
});
