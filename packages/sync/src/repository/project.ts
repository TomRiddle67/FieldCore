import type { FieldCoreDexie } from '../db/database.js';
import { BaseRepository, type RepositoryContext } from './base.js';
import type { Project, ProjectStatus } from '@fieldcore/types';
import { projectSchema } from '@fieldcore/validation';

export interface CreateProjectInput {
  id?: string;
  name: string;
  code: string;
  description?: string | null;
  status?: ProjectStatus;
}

export interface UpdateProjectInput {
  name?: string;
  code?: string;
  description?: string | null;
  status?: ProjectStatus;
}

export class ProjectRepository extends BaseRepository<Project> {
  constructor(db: FieldCoreDexie, context: RepositoryContext) {
    super(db, db.projects, 'PROJECT', context);
  }

  /**
   * Creates a new project offline with client-generated UUID and version = 1.
   */
  async create(input: CreateProjectInput): Promise<Project> {
    const id = input.id || crypto.randomUUID();

    return this.executeAtomicMutation(
      'CREATE',
      id,
      (_current) => {
        const now = new Date().toISOString();
        const entity: Project = {
          id,
          name: input.name,
          code: input.code,
          description: input.description ?? null,
          status: input.status ?? 'ACTIVE',
          version: 1,
          isDeleted: false,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        projectSchema.parse(entity);
        return { entity, baseVersion: null };
      },
      (entity) => ({
        id: entity.id,
        name: entity.name,
        code: entity.code,
        description: entity.description,
        status: entity.status,
      })
    );
  }

  /**
   * Updates an existing project — read happens inside the transaction.
   */
  async update(id: string, patch: UpdateProjectInput): Promise<Project> {
    return this.executeAtomicMutation(
      'UPDATE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Project with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const updated: Project = {
          ...current,
          ...patch,
          version: baseVersion + 1,
          updatedAt: new Date().toISOString(),
        };
        projectSchema.parse(updated);
        return { entity: updated, baseVersion };
      },
      () => patch as Record<string, unknown>
    );
  }

  /**
   * Marks a project as deleted (soft delete tombstone).
   */
  async delete(id: string): Promise<Project> {
    return this.executeAtomicMutation(
      'DELETE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Project with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const now = new Date().toISOString();
        const deleted: Project = {
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
   * Lists active projects.
   */
  async list(includeDeleted = false): Promise<Project[]> {
    if (includeDeleted) {
      return this.table.toArray();
    }
    return this.table.where('isDeleted').equals(0).toArray();
  }
}
