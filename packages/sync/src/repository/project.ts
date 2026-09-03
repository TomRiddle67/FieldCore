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

    return this.executeAtomicMutation('CREATE', entity, 0, {
      id: entity.id,
      name: entity.name,
      code: entity.code,
      description: entity.description,
      status: entity.status,
    });
  }

  /**
   * Updates an existing project and increments its local version.
   */
  async update(id: string, patch: UpdateProjectInput): Promise<Project> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Project with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const updatedEntity: Project = {
      ...existing,
      ...patch,
      version: existing.version + 1,
      updatedAt: now,
    };

    projectSchema.parse(updatedEntity);

    return this.executeAtomicMutation(
      'UPDATE',
      updatedEntity,
      existing.version,
      patch as Record<string, unknown>
    );
  }

  /**
   * Marks a project as deleted (soft delete tombstone).
   */
  async delete(id: string): Promise<Project> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Project with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const deletedEntity: Project = {
      ...existing,
      version: existing.version + 1,
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
    };

    return this.executeAtomicMutation(
      'DELETE',
      deletedEntity,
      existing.version,
      { id, isDeleted: true, deletedAt: now }
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
