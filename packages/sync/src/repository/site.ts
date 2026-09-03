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

    return this.executeAtomicMutation('CREATE', entity, null, {
      id: entity.id,
      projectId: entity.projectId,
      name: entity.name,
      code: entity.code,
      gps: entity.gps,
      description: entity.description,
    });
  }

  /**
   * Updates an existing site.
   */
  async update(id: string, patch: UpdateSiteInput): Promise<Site> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Site with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const baseVersion = existing.version;
    const updatedEntity: Site = {
      ...existing,
      ...patch,
      version: baseVersion + 1,
      updatedAt: now,
    };

    siteSchema.parse(updatedEntity);

    return this.executeAtomicMutation(
      'UPDATE',
      updatedEntity,
      baseVersion,
      patch as Record<string, unknown>
    );
  }

  /**
   * Marks a site as deleted.
   */
  async delete(id: string): Promise<Site> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Site with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const baseVersion = existing.version;
    const deletedEntity: Site = {
      ...existing,
      version: baseVersion + 1,
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
    };

    return this.executeAtomicMutation(
      'DELETE',
      deletedEntity,
      baseVersion,
      { id, isDeleted: true, deletedAt: now }
    );
  }

  /**
   * Lists sites by project ID.
   */
  async listByProjectId(projectId: string, includeDeleted = false): Promise<Site[]> {
    const records = await this.table.where('projectId').equals(projectId).toArray();
    if (includeDeleted) return records;
    return records.filter((r) => !r.isDeleted);
  }
}
