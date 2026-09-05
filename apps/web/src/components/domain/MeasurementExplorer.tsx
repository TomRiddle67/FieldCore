import { useState } from 'react';
import { useMeasurements } from '../../hooks/useDomain';
import { useSyncContext } from '../../context/SyncContext';
import { useGpsCapture } from '../../hooks/useGpsCapture';
import type { Project, Site, Inspection, MeasurementMetricType } from '@fieldcore/types';

interface MeasurementExplorerProps {
  project: Project;
  site: Site;
  inspection: Inspection;
  onBackToInspections: () => void;
  onBackToSites: () => void;
  onBackToProjects: () => void;
}

export function MeasurementExplorer({
  project,
  site,
  inspection,
  onBackToInspections,
  onBackToSites,
  onBackToProjects,
}: MeasurementExplorerProps) {
  const measurements = useMeasurements(inspection.id);
  const { measurementRepo } = useSyncContext();
  const { isCapturing, gpsStatus, captureOnSave } = useGpsCapture();

  const [isCreating, setIsCreating] = useState(false);
  const [metricType, setMetricType] = useState<MeasurementMetricType>('TEMPERATURE');
  const [numericValue, setNumericValue] = useState('');
  const [unit, setUnit] = useState('degC');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaveBanner(null);

    const val = parseFloat(numericValue);
    if (isNaN(val)) {
      setError('Please enter a valid numeric measurement value');
      return;
    }

    setIsSubmitting(true);

    try {
      // LOCKED SPECIFICATION: GPS capture triggers strictly at the moment of save
      // Soft degradation: resolves to null if timeout or permission denied
      const gps = await captureOnSave();

      await measurementRepo.create({
        inspectionId: inspection.id,
        metricType,
        numericValue: val,
        unit: unit.trim(),
        notes: notes.trim() || null,
        gps: gps ?? null,
      });

      if (!gps) {
        setSaveBanner('Measurement saved without GPS lock (offline / GPS unavailable)');
      }

      setNumericValue('');
      setNotes('');
      setIsCreating(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to save measurement');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, metricType: string) => {
    if (confirm(`Delete ${metricType} measurement?`)) {
      try {
        await measurementRepo.delete(id);
      } catch (err: any) {
        alert(err?.message || 'Failed to delete measurement');
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
        <button type="button" className="breadcrumb-btn" onClick={onBackToInspections}>
          {site.name}
        </button>
        <span className="breadcrumb-separator">/</span>
        <span className="breadcrumb-current">{inspection.title}</span>
      </div>

      <div className="section-header">
        <div>
          <h2>Measurements for {inspection.title}</h2>
          <p className="drawer-subtitle">
            Numeric sensor and field observation log with on-save GPS capture.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setIsCreating(true)}
        >
          + Record Measurement
        </button>
      </div>

      {saveBanner && (
        <div className="sync-error-banner" style={{ marginBottom: '1rem', backgroundColor: 'rgba(245, 158, 11, 0.1)', borderColor: '#f59e0b', color: '#fbbf24' }}>
          ℹ️ {saveBanner}
        </div>
      )}

      {measurements.length === 0 ? (
        <div className="empty-state">
          <p>No measurements recorded for this inspection yet.</p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '1rem' }}
            onClick={() => setIsCreating(true)}
          >
            Record First Measurement
          </button>
        </div>
      ) : (
        <div className="entity-grid">
          {measurements.map((m) => (
            <div key={m.id} className="entity-card">
              <div className="card-header-line">
                <div>
                  <h3>{m.metricType}</h3>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#60a5fa', margin: '0.25rem 0' }}>
                    {m.numericValue} <span style={{ fontSize: '1rem', color: '#94a3b8' }}>{m.unit}</span>
                  </div>
                </div>
                <span className="badge badge-device">v{m.version}</span>
              </div>
              {m.notes && <p className="card-desc">{m.notes}</p>}

              <div className="card-meta-row">
                {m.gps ? (
                  <span className="badge badge-online" title="Captured GPS coordinates">
                    📍 {m.gps.latitude.toFixed(4)}, {m.gps.longitude.toFixed(4)} (±{Math.round(m.gps.accuracy ?? 0)}m)
                  </span>
                ) : (
                  <span className="badge badge-synced">📍 No GPS Lock</span>
                )}
                <span>{new Date(m.recordedAt).toLocaleTimeString()}</span>
              </div>

              <div className="card-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDelete(m.id, m.metricType)}
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
              <h3>Record Field Measurement</h3>
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
                  <label htmlFor="m-type">Metric Type *</label>
                  <select
                    id="m-type"
                    className="form-select"
                    value={metricType}
                    onChange={(e) => {
                      const selected = e.target.value as MeasurementMetricType;
                      setMetricType(selected);
                      if (selected === 'TEMPERATURE') setUnit('degC');
                      else if (selected === 'PH') setUnit('pH');
                      else if (selected === 'MOISTURE') setUnit('%');
                      else if (selected === 'DENSITY') setUnit('g/cm3');
                      else if (selected === 'CORE_RECOVERY') setUnit('%');
                      else if (selected === 'RQD') setUnit('%');
                    }}
                  >
                    <option value="TEMPERATURE">Temperature (degC)</option>
                    <option value="PH">pH Level (pH)</option>
                    <option value="MOISTURE">Moisture (%)</option>
                    <option value="DENSITY">Density (g/cm3)</option>
                    <option value="CORE_RECOVERY">Core Recovery (%)</option>
                    <option value="RQD">Rock Quality Designation (%)</option>
                    <option value="CUSTOM">Custom</option>
                  </select>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
                  <div className="form-group">
                    <label htmlFor="m-val">Numeric Value *</label>
                    <input
                      id="m-val"
                      type="number"
                      step="any"
                      className="form-input"
                      value={numericValue}
                      onChange={(e) => setNumericValue(e.target.value)}
                      required
                      placeholder="e.g. 24.8"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="m-unit">Unit *</label>
                    <input
                      id="m-unit"
                      className="form-input"
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                      required
                      placeholder="e.g. degC"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="m-notes">Observation Notes (Optional)</label>
                  <textarea
                    id="m-notes"
                    className="form-textarea"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
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
                  {isSubmitting ? 'Saving with GPS...' : 'Save Measurement'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
