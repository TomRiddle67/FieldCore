import { useState } from 'react';
import { SyncProvider } from './context/SyncContext';
import { SyncStatusBar } from './components/sync/SyncStatusBar';
import { ConflictDrawer } from './components/sync/ConflictDrawer';
import { ProjectExplorer } from './components/domain/ProjectExplorer';
import { SiteExplorer } from './components/domain/SiteExplorer';
import { InspectionExplorer } from './components/domain/InspectionExplorer';
import { MeasurementExplorer } from './components/domain/MeasurementExplorer';
import type { Project, Site, Inspection } from '@fieldcore/types';

export function App() {
  const [isConflictDrawerOpen, setIsConflictDrawerOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSite, setSelectedSite] = useState<Site | null>(null);
  const [selectedInspection, setSelectedInspection] = useState<Inspection | null>(null);

  return (
    <SyncProvider>
      <div className="app-shell">
        <header className="app-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h1>FieldCore</h1>
            <span className="status-pill">Offline-First Engine</span>
          </div>
        </header>

        {/* Top Supervisor Sync Status Bar */}
        <SyncStatusBar
          onOpenConflictDrawer={() => setIsConflictDrawerOpen(true)}
        />

        {/* Main Content Area: Hierarchical Domain Navigation */}
        <main className="app-content">
          {selectedInspection && selectedSite && selectedProject ? (
            <MeasurementExplorer
              project={selectedProject}
              site={selectedSite}
              inspection={selectedInspection}
              onBackToInspections={() => setSelectedInspection(null)}
              onBackToSites={() => {
                setSelectedInspection(null);
                setSelectedSite(null);
              }}
              onBackToProjects={() => {
                setSelectedInspection(null);
                setSelectedSite(null);
                setSelectedProject(null);
              }}
            />
          ) : selectedSite && selectedProject ? (
            <InspectionExplorer
              project={selectedProject}
              site={selectedSite}
              onSelectInspection={(inspection) => setSelectedInspection(inspection)}
              onBackToSites={() => setSelectedSite(null)}
              onBackToProjects={() => {
                setSelectedSite(null);
                setSelectedProject(null);
              }}
            />
          ) : selectedProject ? (
            <SiteExplorer
              project={selectedProject}
              onSelectSite={(site) => setSelectedSite(site)}
              onBackToProjects={() => setSelectedProject(null)}
            />
          ) : (
            <ProjectExplorer
              onSelectProject={(project) => setSelectedProject(project)}
            />
          )}
        </main>

        {/* Slide-out Conflict Resolution Drawer */}
        <ConflictDrawer
          isOpen={isConflictDrawerOpen}
          onClose={() => setIsConflictDrawerOpen(false)}
        />
      </div>
    </SyncProvider>
  );
}
