import { useState } from 'react';
import { useSyncContext } from '../../context/SyncContext';
import { useRecentConflicts } from '../../hooks/useSyncState';
import type { ConflictRecord, EditEditConflictRecord } from '@fieldcore/types';

interface ConflictDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ConflictDrawer({ isOpen, onClose }: ConflictDrawerProps) {
  const { conflictResolutionService, context } = useSyncContext();
  const conflicts = useRecentConflicts();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionError, setResolutionError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleResolve = async (
    conflictId: string,
    resolution: 'KEEP_SERVER' | 'KEEP_MINE'
  ) => {
    setResolvingId(conflictId);
    setResolutionError(null);

    try {
      await conflictResolutionService.resolve({
        conflictId,
        resolution,
        resolvedByUserId: context.userId,
      });
    } catch (err: any) {
      setResolutionError(err?.message || 'Resolution failed');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        className="conflict-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <div>
            <h2 id="conflict-drawer-title">Conflict Resolution</h2>
            <p className="drawer-subtitle">
              Resolve conflicting concurrent edits deterministically.
            </p>
          </div>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {resolutionError && (
          <div className="drawer-error" role="alert">
            {resolutionError}
          </div>
        )}

        <div className="drawer-body">
          {conflicts.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">✓</span>
              <p>No active or recent conflicts. All entities are cleanly synchronized.</p>
            </div>
          ) : (
            <div className="conflict-list">
              {conflicts.map((conflict) => (
                <ConflictCard
                  key={conflict.conflictId}
                  conflict={conflict}
                  isResolving={resolvingId === conflict.conflictId}
                  onResolve={handleResolve}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function ConflictCard({
  conflict,
  isResolving,
  onResolve,
}: {
  conflict: ConflictRecord;
  isResolving: boolean;
  onResolve: (conflictId: string, resolution: 'KEEP_SERVER' | 'KEEP_MINE') => Promise<void>;
}) {
  const isPending = conflict.status === 'PENDING';
  const isEditDelete = conflict.conflictType === 'EDIT_DELETE';

  return (
    <div className={`conflict-card ${isPending ? 'card-pending' : 'card-resolved'}`}>
      <div className="card-top">
        <div className="card-meta">
          <span className="entity-badge">{conflict.entityType}</span>
          <span className="type-badge">{conflict.conflictType}</span>
          <span className="timestamp">
            {new Date(conflict.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <span className={`status-tag status-${conflict.status.toLowerCase()}`}>
          {conflict.status}
        </span>
      </div>

      {/* Case 1: EDIT_DELETE (Server deleted before client edit synced) */}
      {isEditDelete ? (
        <div className="edit-delete-notice">
          <div className="notice-icon">🗑️</div>
          <div className="notice-text">
            <strong>Server Deleted This Record</strong>
            <p>
              A peer deleted this {conflict.entityType.toLowerCase()} on the server before your
              local edit reached the server. Per system rules, delete wins automatically.
            </p>
            <p className="notice-sub">No action needed — the record is archived.</p>
          </div>
          {/* ZERO action buttons rendered to prevent NonResolvableConflictError */}
        </div>
      ) : (
        /* Case 2: EDIT_EDIT (Concurrent conflicting updates) */
        <>
          <div className="diff-grid">
            <div className="diff-col local-diff">
              <h4>Local Edit (Your Device)</h4>
              <pre>
                {JSON.stringify(
                  (conflict as EditEditConflictRecord).clientState ?? {},
                  null,
                  2
                )}
              </pre>
            </div>
            <div className="diff-col server-diff">
              <h4>Authoritative Server State (v{conflict.serverVersion})</h4>
              <pre>
                {JSON.stringify(
                  (conflict as EditEditConflictRecord).serverState ?? {},
                  null,
                  2
                )}
              </pre>
            </div>
          </div>

          {isPending ? (
            <div className="resolution-actions">
              <button
                type="button"
                className="btn btn-keep-server"
                disabled={isResolving}
                onClick={() => onResolve(conflict.conflictId, 'KEEP_SERVER')}
              >
                {isResolving ? 'Resolving...' : 'Keep Server (Discard My Edit)'}
              </button>
              <button
                type="button"
                className="btn btn-keep-mine"
                disabled={isResolving}
                onClick={() => onResolve(conflict.conflictId, 'KEEP_MINE')}
              >
                {isResolving ? 'Resolving...' : 'Keep Mine (Re-queue with Live v)'}
              </button>
            </div>
          ) : (
            <div className="resolved-summary">
              ✓ Resolved: <strong>{conflict.resolution}</strong> at{' '}
              {conflict.resolvedAt
                ? new Date(conflict.resolvedAt).toLocaleTimeString()
                : ''}
            </div>
          )}
        </>
      )}
    </div>
  );
}
