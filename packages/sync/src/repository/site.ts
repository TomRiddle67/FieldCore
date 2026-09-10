import type { FieldCoreDexie } from '../db/database.js';
import { BaseRepository, type RepositoryContext } from './base.js';
import type { Site, GPSMetadata } from '@fieldcore/types';
import { siteSchema } from '@fieldcore/validation';

export interface CreateSiteInput {
  id?: string;
  projectId: string;
  name: string;
  code: string;
  gps?: GPSMetadata | null;
  description?: string | null;
}

export interface UpdateSiteInput {
  name?: string;
  code?: string;
  gps?: GPSMetadata | null;
  description?: string | null;
}

export class SiteRepository extends BaseRepository<Site> {
  constructor(db: FieldCoreDexie, context: RepositoryContext) {
    super(db, db.sites, 'SITE', context);
  }

  /**
   * Creates a new site offline under a project.
   */
  async create(input: CreateSiteInput): Promise<Site> {
    const id = input.id || crypto.randomUUID();

    return this.executeAtomicMutation(
      'CREATE',
      id,
      (_current) => {
        const now = new Date().toISOString();
        const entity: Site = {
          id,
          projectId: input.projectId,
          name: input.name,
          code: input.code,
          gps: input.gps ?? null,
          description: input.description ?? null,
          version: 1,
          isDeleted: false,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        siteSchema.parse(entity);
        return { entity, baseVersion: null };
      },
      (entity) => ({
        id: entity.id,
        projectId: entity.projectId,
        name: entity.name,
        code: entity.code,
        gps: entity.gps,
        description: entity.description,
      })
    );
  }

  /**
   * Updates an existing site — read happens inside the transaction.
   */
  async update(id: string, patch: UpdateSiteInput): Promise<Site> {
    return this.executeAtomicMutation(
      'UPDATE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Site with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const updated: Site = {
          ...current,
          ...patch,
          version: baseVersion + 1,
          updatedAt: new Date().toISOString(),
        };
        siteSchema.parse(updated);
        return { entity: updated, baseVersion };
      },
      () => patch as Record<string, unknown>
    );
  }

  /**
   * Marks a site as deleted.
   */
  async delete(id: string): Promise<Site> {
    return this.executeAtomicMutation(
      'DELETE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Site with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const now = new Date().toISOString();
        const deleted: Site = {
          ...current,
          version: baseVersion + 1,
          isDeleted: true,
          deletedAt: now,
          updatedAt: now,
        };
        return { entity: deleted, baseVersion };
      },
      (entity) => ({ id: entity.id, isDeleted: true, deletedAt: entity.deletedAt })
    );
  }

  /**
   * Lists sites by project ID, ordered newest first (createdAt descending).
   */
  async listByProjectId(projectId: string, includeDeleted = false): Promise<Site[]> {
    const records = await this.table.where('projectId').equals(projectId).toArray();
    const filtered = includeDeleted ? records : records.filter((r) => !r.isDeleted);
    return filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}
