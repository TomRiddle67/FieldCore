import { useState } from 'react';
import { useSites } from '../../hooks/useDomain';
import { useSyncContext } from '../../context/SyncContext';
import { useGpsCapture } from '../../hooks/useGpsCapture';
import type { Project, Site } from '@fieldcore/types';

interface SiteExplorerProps {
  project: Project;
  onSelectSite: (site: Site) => void;
  onBackToProjects: () => void;
}

export function SiteExplorer({ project, onSelectSite, onBackToProjects }: SiteExplorerProps) {
  const sites = useSites(project.id);
  const { siteRepo } = useSyncContext();
  const { isCapturing, gpsStatus, captureOnSave } = useGpsCapture();

  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaveBanner(null);
    setIsSubmitting(true);

    try {
      // LOCKED SPECIFICATION: GPS capture triggers strictly at the moment of save
      // Soft degradation: if GPS fails or times out, coords is null and save proceeds unblocked
      const gps = await captureOnSave();

      await siteRepo.create({
        projectId: project.id,
        name: name.trim(),
        code: code.trim().toUpperCase(),
        description: description.trim() || null,
        gps: gps ?? null,
      });

      if (!gps) {
        setSaveBanner('Site saved without GPS lock (offline / GPS unavailable)');
      }

      setName('');
      setCode('');
      setDescription('');
      setIsCreating(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to create site');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Delete site "${name}"?`)) {
      try {
        await siteRepo.delete(id);
      } catch (err: any) {
        alert(err?.message || 'Failed to delete site');
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
        <span className="breadcrumb-current">{project.name}</span>
      </div>

      <div className="section-header">
        <div>
          <h2>Sites in {project.name}</h2>
          <p className="drawer-subtitle">
            Field survey locations and drill pads.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setIsCreating(true)}
        >
          + New Site
        </button>
      </div>

      {saveBanner && (
        <div className="sync-error-banner" style={{ marginBottom: '1rem', backgroundColor: 'rgba(245, 158, 11, 0.1)', borderColor: '#f59e0b', color: '#fbbf24' }}>
          ℹ️ {saveBanner}
        </div>
      )}

      {sites.length === 0 ? (
        <div className="empty-state">
          <p>No sites recorded for this project yet.</p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '1rem' }}
            onClick={() => setIsCreating(true)}
          >
            Create First Site
          </button>
        </div>
      ) : (
        <div className="entity-grid">
          {sites.map((s) => (
            <div key={s.id} className="entity-card">
              <div className="card-header-line">
                <div>
                  <h3>{s.name}</h3>
                  <span className="code-pill">{s.code}</span>
                </div>
                <span className="badge badge-device">v{s.version}</span>
              </div>
              {s.description && <p className="card-desc">{s.description}</p>}

              <div className="card-meta-row">
                {s.gps ? (
                  <span className="badge badge-online" title="Captured GPS coordinates">
                    📍 {s.gps.latitude.toFixed(4)}, {s.gps.longitude.toFixed(4)} (±{Math.round(s.gps.accuracy ?? 0)}m)
                  </span>
                ) : (
                  <span className="badge badge-synced" title="No GPS coordinates recorded">
                    📍 No GPS Lock
                  </span>
                )}
              </div>

              <div className="card-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onSelectSite(s)}
                >
                  View Inspections →
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDelete(s.id, s.name)}
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
              <h3>Create Offline Site</h3>
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
                  <label htmlFor="s-name">Site Name *</label>
                  <input
                    id="s-name"
                    className="form-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    placeholder="e.g. Pad 104 Borehole"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="s-code">Code * (uppercase, alphanumeric)</label>
                  <input
                    id="s-code"
                    className="form-input"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    placeholder="e.g. PAD-104"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="s-desc">Description (Optional)</label>
                  <textarea
                    id="s-desc"
                    className="form-textarea"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                  />
                </div>

                <div className="gps-status-indicator">
                  <span>📍 GPS Capture:</span>
                  {isCapturing ? (
                    <span style={{ color: '#60a5fa' }}>Acquiring satellite lock...</span>
                  ) : gpsStatus === 'degraded' ? (
                    <span style={{ color: '#f59e0b' }}>Degraded / Offline fallback active</span>
                  ) : (
                    <span>Will capture location upon clicking Save</span>
                  )}
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
                  {isSubmitting ? 'Saving with GPS...' : 'Save Site'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
