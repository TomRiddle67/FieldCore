import { useState } from 'react';
import { useInspections } from '../../hooks/useDomain';
import { useSyncContext } from '../../context/SyncContext';
import type { Project, Site, Inspection, InspectionStatus } from '@fieldcore/types';

interface InspectionExplorerProps {
  project: Project;
  site: Site;
  onSelectInspection: (inspection: Inspection) => void;
  onBackToSites: () => void;
  onBackToProjects: () => void;
}

export function InspectionExplorer({
  project,
  site,
  onSelectInspection,
  onBackToSites,
  onBackToProjects,
}: InspectionExplorerProps) {
  const inspections = useInspections(site.id);
  const { inspectionRepo } = useSyncContext();

  const [isCreating, setIsCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await inspectionRepo.create({
        siteId: site.id,
        title: title.trim(),
        notes: notes.trim() || null,
        status: 'DRAFT',
      });
      setTitle('');
      setNotes('');
      setIsCreating(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to create inspection');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAdvanceStatus = async (inspection: Inspection) => {
    let nextStatus: InspectionStatus = 'IN_PROGRESS';
    if (inspection.status === 'IN_PROGRESS') {
      nextStatus = 'COMPLETED';
    } else if (inspection.status === 'COMPLETED') {
      return; // Already terminal
    }

    try {
      await inspectionRepo.update(inspection.id, {
        status: nextStatus,
        completedDate: nextStatus === 'COMPLETED' ? new Date().toISOString() : null,
      });
    } catch (err: any) {
      alert(err?.message || 'Failed to update inspection status');
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (confirm(`Delete inspection "${title}"?`)) {
      try {
        await inspectionRepo.delete(id);
      } catch (err: any) {
        alert(err?.message || 'Failed to delete inspection');
      }
    }
  };

  return (
    <div className="domain-section">
      <div className="hierarchy-nav">
        <button type="button" className="breadcrumb-btn" onClick={onBackToProjects}>
          Projects
        </button>
        <span className="breadcrumb-separator">/</span>
        <button type="button" className="breadcrumb-btn" onClick={onBackToSites}>
          {project.name}
        </button>
        <span className="breadcrumb-separator">/</span>
        <span className="breadcrumb-current">{site.name}</span>
      </div>

      <div className="section-header">
        <div>
          <h2>Inspections at {site.name}</h2>
          <p className="drawer-subtitle">
            Lifecycle workflows: DRAFT → IN_PROGRESS → COMPLETED.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setIsCreating(true)}
        >
          + New Inspection
        </button>
      </div>

      {inspections.length === 0 ? (
        <div className="empty-state">
          <p>No inspections recorded for this site yet.</p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '1rem' }}
            onClick={() => setIsCreating(true)}
          >
            Create First Inspection
          </button>
        </div>
      ) : (
        <div className="entity-grid">
          {inspections.map((i) => (
            <div key={i.id} className="entity-card">
              <div className="card-header-line">
                <div>
                  <h3>{i.title}</h3>
                  <span
                    className={`badge ${
                      i.status === 'COMPLETED'
                        ? 'badge-online'
                        : i.status === 'IN_PROGRESS'
                        ? 'badge-device'
                        : 'badge-synced'
                    }`}
                  >
                    {i.status}
                  </span>
                </div>
                <span className="badge badge-device">v{i.version}</span>
              </div>
              {i.notes && <p className="card-desc">{i.notes}</p>}

              <div className="card-meta-row">
                <span>Created: {new Date(i.createdAt).toLocaleDateString()}</span>
                {i.completedDate && (
                  <span>Completed: {new Date(i.completedDate).toLocaleDateString()}</span>
                )}
              </div>

              <div className="card-actions">
                {i.status !== 'COMPLETED' && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleAdvanceStatus(i)}
                    title="Advance lifecycle state"
                  >
                    {i.status === 'DRAFT' ? 'Start Inspection →' : 'Complete Inspection ✓'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onSelectInspection(i)}
                >
                  Measurements →
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDelete(i.id, i.title)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {isCreating && (
        <div className="modal-overlay" onClick={() => setIsCreating(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create Offline Inspection</h3>
              <button
                type="button"
                className="btn-close"
                onClick={() => setIsCreating(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                {error && <div className="form-error">{error}</div>}
                <div className="form-group">
                  <label htmlFor="i-title">Inspection Title *</label>
                  <input
                    id="i-title"
                    className="form-input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    placeholder="e.g. Daily Structural & Water Log"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="i-notes">Notes / Scope (Optional)</label>
                  <textarea
                    id="i-notes"
                    className="form-textarea"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreating(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Creating...' : 'Save Inspection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
