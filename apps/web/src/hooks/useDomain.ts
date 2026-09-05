import { useLiveQuery } from 'dexie-react-hooks';
import { useSyncContext } from '../context/SyncContext';
import type { Project, Site, Inspection, Measurement } from '@fieldcore/types';

/**
 * Reactive hooks for domain entities.
 * STRICT ARCHITECTURAL RULE: Every query wraps a repository method.
 * Zero direct access to raw Dexie tables occurs here.
 */

export function useProjects(): Project[] {
  const { projectRepo } = useSyncContext();
  const projects = useLiveQuery(() => projectRepo.list(), [projectRepo]);
  return projects ?? [];
}

export function useProject(id: string | null | undefined): Project | null {
  const { projectRepo } = useSyncContext();
  const project = useLiveQuery(
    () => (id ? projectRepo.getById(id) : null),
    [projectRepo, id]
  );
  return project ?? null;
}

export function useSites(projectId: string | null | undefined): Site[] {
  const { siteRepo } = useSyncContext();
  const sites = useLiveQuery(
    () => (projectId ? siteRepo.listByProjectId(projectId) : []),
    [siteRepo, projectId]
  );
  return sites ?? [];
}

export function useSite(id: string | null | undefined): Site | null {
  const { siteRepo } = useSyncContext();
  const site = useLiveQuery(
    () => (id ? siteRepo.getById(id) : null),
    [siteRepo, id]
  );
  return site ?? null;
}

export function useInspections(siteId: string | null | undefined): Inspection[] {
  const { inspectionRepo } = useSyncContext();
  const inspections = useLiveQuery(
    () => (siteId ? inspectionRepo.listBySiteId(siteId) : []),
    [inspectionRepo, siteId]
  );
  return inspections ?? [];
}

export function useInspection(id: string | null | undefined): Inspection | null {
  const { inspectionRepo } = useSyncContext();
  const inspection = useLiveQuery(
    () => (id ? inspectionRepo.getById(id) : null),
    [inspectionRepo, id]
  );
  return inspection ?? null;
}

export function useMeasurements(inspectionId: string | null | undefined): Measurement[] {
  const { measurementRepo } = useSyncContext();
  const measurements = useLiveQuery(
    () => (inspectionId ? measurementRepo.listByInspectionId(inspectionId) : []),
    [measurementRepo, inspectionId]
  );
  return measurements ?? [];
}
