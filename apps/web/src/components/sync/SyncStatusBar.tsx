import { useSyncContext } from '../../context/SyncContext';
import { usePendingCount, useActiveConflicts, useLastSyncAt } from '../../hooks/useSyncState';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';

interface SyncStatusBarProps {
  onOpenConflictDrawer: () => void;
}

export function SyncStatusBar({ onOpenConflictDrawer }: SyncStatusBarProps) {
  const { isSyncing, syncNow, lastSyncError, deviceProfile } = useSyncContext();
  const isOnline = useNetworkStatus();
  const pendingCount = usePendingCount();
  const activeConflicts = useActiveConflicts();
  const lastSyncAt = useLastSyncAt();

  const formattedLastSync = lastSyncAt
    ? new Date(lastSyncAt).toLocaleTimeString()
    : 'Never';

  return (
    <div className="sync-status-bar">
      <div className="status-group">
        {/* Network Connection Badge */}
        <span
          className={`badge connection-badge ${isOnline ? 'badge-online' : 'badge-offline'}`}
          title={isOnline ? 'Online' : 'Offline - local mutations will queue in Dexie'}
        >
          <span className="dot" />
          {isOnline ? 'Online' : 'Offline'}
        </span>

        {/* Device Profile Indicator (useful for dual-client testing) */}
        {deviceProfile !== 'default' && (
          <span className="badge badge-device">Device: {deviceProfile}</span>
        )}

        {/* Pending Operations Badge */}
        <span
          className={`badge ${pendingCount > 0 ? 'badge-pending' : 'badge-synced'}`}
          title={`${pendingCount} local mutation(s) queued`}
        >
          {pendingCount > 0 ? `${pendingCount} Pending` : 'All Synced'}
        </span>

        {/* Unresolved Conflicts Warning Badge */}
        {activeConflicts.length > 0 && (
          <button
            type="button"
            className="badge badge-conflict-btn"
            onClick={onOpenConflictDrawer}
            title="Click to resolve conflicts"
          >
            ⚠️ {activeConflicts.length} Conflict{activeConflicts.length > 1 ? 's' : ''}
          </button>
        )}
      </div>

      <div className="actions-group">
        <span className="last-sync-text">Last Sync: {formattedLastSync}</span>

        {/* Sync Now Button with In-Flight Concurrency Guard */}
        <button
          type="button"
          className="btn btn-sync"
          disabled={isSyncing}
          onClick={syncNow}
          title={isSyncing ? 'Synchronization in progress' : 'Push local mutations and pull remote changes'}
        >
          {isSyncing ? (
            <>
              <span className="spinner" />
              <span>Syncing...</span>
            </>
          ) : (
            <span>Sync Now</span>
          )}
        </button>
      </div>

      {lastSyncError && (
        <div className="sync-error-banner" role="alert">
          <span>⚠️ {lastSyncError}</span>
        </div>
      )}
    </div>
  );
}
