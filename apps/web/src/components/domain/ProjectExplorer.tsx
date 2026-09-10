import { useState } from 'react';
import { useProjects } from '../../hooks/useDomain';
import { useSyncContext } from '../../context/SyncContext';
import type { Project } from '@fieldcore/types';

interface ProjectExplorerProps {
  onSelectProject: (project: Project) => void;
}

export function ProjectExplorer({ onSelectProject }: ProjectExplorerProps) {
  const projects = useProjects();
  const { projectRepo } = useSyncContext();
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const filteredProjects = projects.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q);
  });

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await projectRepo.update(editingProject.id, {
        name: editName.trim(),
        description: editDescription.trim() || null,
      });
      setEditingProject(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to update project');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await projectRepo.create({
        name: name.trim(),
        code: code.trim().toUpperCase(),
        description: description.trim() || null,
      });
      setName('');
      setCode('');
      setDescription('');
      setIsCreating(false);
    } catch (err: any) {
      setError(err?.message || 'Failed to create project');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Delete project "${name}"? This queues a soft delete tombstone.`)) {
      try {
        await projectRepo.delete(id);
      } catch (err: any) {
        alert(err?.message || 'Failed to delete project');
      }
    }
  };

  return (
    <div className="domain-section">
      <div className="section-header">
        <div>
          <h2>Projects</h2>
          <p className="drawer-subtitle">
            Offline operational workspaces for field operations.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setIsCreating(true)}
        >
          + New Project
        </button>
      </div>

      {projects.length > 0 && (
        <div style={{ marginBottom: '1.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="search"
            placeholder="Search projects by name or code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: '0.5rem 0.85rem',
              borderRadius: '6px',
              border: '1px solid #374151',
              backgroundColor: '#1f2937',
              color: '#f3f4f6',
              fontSize: '0.875rem',
              width: '100%',
              maxWidth: '360px',
            }}
          />
          {search && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setSearch('')}
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }}
            >
              Clear
            </button>
          )}
          <span style={{ fontSize: '0.8125rem', color: '#9ca3af' }}>
            Showing {filteredProjects.length} of {projects.length} projects (newest first)
          </span>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty-state">
          <p>No active projects found offline.</p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '1rem' }}
            onClick={() => setIsCreating(true)}
          >
            Create First Project
          </button>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="empty-state">
          <p>No projects match "{search}".</p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: '1rem' }}
            onClick={() => setSearch('')}
          >
            Clear Search
          </button>
        </div>
      ) : (
        <div className="entity-grid">
          {filteredProjects.map((p) => (
            <div key={p.id} className="entity-card">
              <div className="card-header-line">
                <div>
                  <h3>{p.name}</h3>
                  <span className="code-pill">{p.code}</span>
                </div>
                <span className="badge badge-device">v{p.version}</span>
              </div>
              {p.description && <p className="card-desc">{p.description}</p>}
              <div className="card-meta-row">
                <span>Updated: {new Date(p.updatedAt).toLocaleDateString()}</span>
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setEditingProject(p);
                    setEditName(p.name);
                    setEditDescription(p.description || '');
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onSelectProject(p)}
                >
                  View Sites →
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDelete(p.id, p.name)}
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
              <h3>Create Offline Project</h3>
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
                  <label htmlFor="p-name">Project Name *</label>
                  <input
                    id="p-name"
                    className="form-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    placeholder="e.g. Copper Creek Exploration"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="p-code">Code * (uppercase, alphanumeric)</label>
                  <input
                    id="p-code"
                    className="form-input"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    placeholder="e.g. CCE-01"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="p-desc">Description (Optional)</label>
                  <textarea
                    id="p-desc"
                    className="form-textarea"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
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
                  {isSubmitting ? 'Creating...' : 'Save Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingProject && (
        <div className="modal-overlay" onClick={() => setEditingProject(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit Project</h3>
              <button
                type="button"
                className="btn-close"
                onClick={() => setEditingProject(null)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleUpdate}>
              <div className="modal-body">
                {error && <div className="form-error">{error}</div>}
                <div className="form-group">
                  <label htmlFor="edit-p-name">Project Name *</label>
                  <input
                    id="edit-p-name"
                    className="form-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="edit-p-desc">Description (Optional)</label>
                  <textarea
                    id="edit-p-desc"
                    className="form-textarea"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditingProject(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Updating...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
