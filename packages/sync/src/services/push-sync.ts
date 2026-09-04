import type { FieldCoreDexie } from '../db/database.js';
import type {
  PushRequest,
  PushResponse,
  PushOperationResult,
  ConflictRecord,
  SyncOperation,
} from '@fieldcore/types';

/**
 * Transport adapter function signature for push sync.
 * Keeps @fieldcore/sync with ZERO HTTP dependencies.
 */
export type PushTransport = (request: PushRequest) => Promise<PushResponse>;

export interface PushBatchOptions {
  batchSize?: number; // Maximum batch size, default and max capped at 25
  deviceId?: string;
  now?: () => string; // Clock provider for deterministic testing
}

export interface PushBatchResult {
  pushedCount: number;
  appliedCount: number;
  conflictCount: number;
  rejectedCount: number;
  deviceRevokedCount: number;
  requiresRevalidationCount: number;
  error?: string;
}

/**
 * Client Push Synchronization Service.
 * Manages atomic batching, localSeq ordering, offline-crash recovery,
 * exponential backoff, and conflict lifecycle transitions.
 */
export class PushSyncService {
  constructor(private readonly db: FieldCoreDexie) {}

  /**
   * Recovers operations stuck in SYNCING state from a previous crash or network interruption.
   * Any operation found with status 'SYNCING' is treated as "outcome unknown" and safely
   * reset to 'PENDING'.
   * Server-side idempotency makes resending 100% safe without duplicate side effects.
   */
  async recoverDanglingSyncingOperations(deviceId?: string): Promise<number> {
    return this.db.transaction('rw', this.db.sync_operations, async () => {
      let query = this.db.sync_operations.where('status').equals('SYNCING');
      if (deviceId) {
        query = query.filter((op) => op.deviceId === deviceId);
      }
      const dangling = await query.toArray();
      for (const op of dangling) {
        await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
          status: 'PENDING',
          errorMessage: 'Recovered from interrupted sync session',
        });
      }
      return dangling.length;
    });
  }

  /**
   * Queries pending operations eligible for push:
   * - status === 'PENDING'
   * - nextEligibleRetryAt IS NULL OR nextEligibleRetryAt <= now
   * - ordered strictly by localSeq ASC
   * - capped at batchSize (default 25, maximum 25)
   */
  async getEligiblePendingOperations(
    batchSize = 25,
    deviceId?: string,
    nowIso?: string
  ): Promise<SyncOperation[]> {
    const effectiveNow = nowIso ?? new Date().toISOString();
    let query = this.db.sync_operations.where('status').equals('PENDING');
    if (deviceId) {
      query = this.db.sync_operations.where('[deviceId+status]').equals([deviceId, 'PENDING']);
    }
    const pending = await query.toArray();
    const eligible = pending.filter(
      (op) => !op.nextEligibleRetryAt || op.nextEligibleRetryAt <= effectiveNow
    );
    eligible.sort((a, b) => (a.localSeq ?? 0) - (b.localSeq ?? 0));
    return eligible.slice(0, Math.min(batchSize, 25));
  }

  /**
   * Dispatches a single batch of up to 25 pending operations in localSeq order.
   */
  async pushBatch(
    transport: PushTransport,
    options: PushBatchOptions = {}
  ): Promise<PushBatchResult> {
    const { batchSize = 25, deviceId, now = () => new Date().toISOString() } = options;
    const currentIso = now();

    // 1. Fetch eligible operations
    const batch = await this.getEligiblePendingOperations(batchSize, deviceId, currentIso);

    if (batch.length === 0) {
      return {
        pushedCount: 0,
        appliedCount: 0,
        conflictCount: 0,
        rejectedCount: 0,
        deviceRevokedCount: 0,
        requiresRevalidationCount: 0,
      };
    }

    const targetDeviceId = deviceId ?? batch[0].deviceId;

    // 2. Atomically transition batch to SYNCING
    await this.db.transaction('rw', this.db.sync_operations, async () => {
      for (const op of batch) {
        await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
          status: 'SYNCING',
          attemptedAt: currentIso,
        });
      }
    });

    const pushReq: PushRequest = {
      deviceId: targetDeviceId,
      operations: batch,
    };

    let response: PushResponse;
    try {
      response = await transport(pushReq);
    } catch (transportError: any) {
      // 3. Transport failure (network down, abort, timeout):
      // Apply jittered exponential backoff and reset unacknowledged operations to PENDING.
      await this.db.transaction('rw', this.db.sync_operations, async () => {
        for (const op of batch) {
          const nextRetry = (op.retryCount ?? 0) + 1;
          if (nextRetry >= 10) {
            // Surfaced for manual attention: leave in PENDING with alert message and long backoff
            await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
              status: 'PENDING',
              retryCount: nextRetry,
              errorMessage: `Push failed after ${nextRetry} attempts. Manual attention required: ${transportError?.message ?? 'Network error'}`,
              nextEligibleRetryAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
          } else {
            // Exponential backoff with jitter capped at 30s
            const baseDelay = Math.min(30000, Math.pow(2, nextRetry) * 1000);
            const jitter = Math.floor(Math.random() * 1000);
            const delay = Math.min(30000, baseDelay + jitter);
            const nextRetryAt = new Date(Date.now() + delay).toISOString();

            await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
              status: 'PENDING',
              retryCount: nextRetry,
              nextEligibleRetryAt: nextRetryAt,
              errorMessage: transportError?.message ?? 'Transport failed',
            });
          }
        }
      });

      return {
        pushedCount: batch.length,
        appliedCount: 0,
        conflictCount: 0,
        rejectedCount: 0,
        deviceRevokedCount: 0,
        requiresRevalidationCount: 0,
        error: transportError?.message ?? 'Transport error',
      };
    }

    // 4. Process per-operation outcomes inside Dexie transaction
    let appliedCount = 0;
    let conflictCount = 0;
    let rejectedCount = 0;
    let deviceRevokedCount = 0;
    let requiresRevalidationCount = 0;

    const resultMap = new Map<string, PushOperationResult>();
    for (const r of response.results) {
      resultMap.set(r.operationId, r);
    }

    await this.db.transaction('rw', [this.db.sync_operations, this.db.conflicts], async () => {
      for (const op of batch) {
        const res = resultMap.get(op.operationId);

        if (!res) {
          // Unacknowledged in partial response -> reset to PENDING for retry
          await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
            status: 'PENDING',
            errorMessage: 'Unacknowledged in batch response',
          });
          continue;
        }

        switch (res.status) {
          case 'APPLIED': {
            appliedCount++;
            await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
              status: 'SYNCED',
              errorMessage: null,
              nextEligibleRetryAt: null,
            });
            break;
          }

          case 'CONFLICT': {
            conflictCount++;
            if (res.conflict) {
              await this.db.conflicts.put(res.conflict);

              if (res.conflict.conflictType === 'EDIT_DELETE') {
                // Invariant: EDIT_DELETE is non-user-resolvable (Delete strictly wins).
                // Auto-resolved to KEEP_SERVER; operation transitions CONFLICT -> REJECTED, NEVER -> PENDING
                rejectedCount++;
                await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
                  status: 'REJECTED',
                  errorMessage: 'Server entity was deleted before client edit synced (Delete wins).',
                });
                break;
              }
            }

            // EDIT_EDIT conflict: remains in CONFLICT awaiting user resolution
            await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
              status: 'CONFLICT',
              errorMessage: 'Conflicting concurrent edit detected on server.',
            });
            break;
          }

          case 'DEVICE_REVOKED': {
            deviceRevokedCount++;
            // Terminal state: client halts retrying and surfaces unsynced work
            await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
              status: 'DEVICE_REVOKED',
              errorMessage: res.error ?? 'Device has been revoked. Unsynced work cannot sync.',
            });
            break;
          }

          case 'REQUIRES_REVALIDATION': {
            requiresRevalidationCount++;
            // Holds in queue until device revalidates online
            await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
              status: 'REQUIRES_REVALIDATION',
              errorMessage: res.error ?? 'Device authentication window expired. Revalidation required.',
            });
            break;
          }

          case 'REJECTED': {
            rejectedCount++;
            await this.db.sync_operations.where('operationId').equals(op.operationId).modify({
              status: 'REJECTED',
              errorMessage: res.error ?? 'Operation was rejected by server.',
            });
            break;
          }
        }
      }
    });

    return {
      pushedCount: batch.length,
      appliedCount,
      conflictCount,
      rejectedCount,
      deviceRevokedCount,
      requiresRevalidationCount,
    };
  }

  /**
   * Called upon successful online device revalidation.
   * Transitions held operations from REQUIRES_REVALIDATION back to PENDING.
   */
  async resolveRevalidationSuccess(deviceId: string): Promise<number> {
    return this.db.transaction('rw', this.db.sync_operations, async () => {
      const ops = await this.db.sync_operations
        .where('[deviceId+status]')
        .equals([deviceId, 'REQUIRES_REVALIDATION'])
        .toArray();

      for (const op of ops) {
        if (op.localSeq !== undefined) {
          await this.db.sync_operations.update(op.localSeq, {
            status: 'PENDING',
            errorMessage: null,
            nextEligibleRetryAt: null,
          });
        }
      }
      return ops.length;
    });
  }
}
