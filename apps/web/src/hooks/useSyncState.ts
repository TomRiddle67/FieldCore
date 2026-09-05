import { useLiveQuery } from 'dexie-react-hooks';
import { useSyncContext } from '../context/SyncContext';
import type { ConflictRecord, SyncOperation } from '@fieldcore/types';

/**
 * Reactive hooks for sync status and conflicts.
 * Uses SyncStatusService methods wrapped in useLiveQuery.
 */

export function usePendingCount(): number {
  const { syncStatusService, context } = useSyncContext();
  const count = useLiveQuery(
    () => syncStatusService.getPendingCount(context.deviceId),
    [syncStatusService, context.deviceId]
  );
  return count ?? 0;
}

export function usePendingOperations(): SyncOperation[] {
  const { syncStatusService, context } = useSyncContext();
  const ops = useLiveQuery(
    () => syncStatusService.getPendingOperations(context.deviceId),
    [syncStatusService, context.deviceId]
  );
  return ops ?? [];
}

export function useActiveConflicts(): ConflictRecord[] {
  const { syncStatusService } = useSyncContext();
  const conflicts = useLiveQuery(
    () => syncStatusService.getConflicts(),
    [syncStatusService]
  );
  return conflicts ?? [];
}

export function useRecentConflicts(): ConflictRecord[] {
  const { syncStatusService } = useSyncContext();
  const conflicts = useLiveQuery(
    () => syncStatusService.getRecentConflicts(),
    [syncStatusService]
  );
  return conflicts ?? [];
}

export function useLastSyncAt(): string | null {
  const { syncStatusService, context } = useSyncContext();
  const lastSync = useLiveQuery(
    () => syncStatusService.getLastSyncAt(context.deviceId),
    [syncStatusService, context.deviceId]
  );
  return lastSync ?? null;
}
