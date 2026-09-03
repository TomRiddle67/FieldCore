import type { FieldCoreDexie } from '../db/database.js';
import { BaseRepository, type RepositoryContext } from './base.js';
import type { Inspection, InspectionStatus } from '@fieldcore/types';
import { inspectionSchema } from '@fieldcore/validation';

export interface CreateInspectionInput {
  id?: string;
  siteId: string;
  userId?: string;
  deviceId?: string;
  title: string;
  status?: InspectionStatus;
  scheduledDate?: string | null;
  completedDate?: string | null;
  notes?: string | null;
}

export interface UpdateInspectionInput {
  title?: string;
  status?: InspectionStatus;
  scheduledDate?: string | null;
  completedDate?: string | null;
  notes?: string | null;
}

export class InspectionRepository extends BaseRepository<Inspection> {
  constructor(db: FieldCoreDexie, context: RepositoryContext) {
    super(db, db.inspections, 'INSPECTION', context);
  }

  /**
   * Creates a new inspection offline under a site.
   */
  async create(input: CreateInspectionInput): Promise<Inspection> {
    const id = input.id || crypto.randomUUID();
    const now = new Date().toISOString();

    const entity: Inspection = {
      id,
      siteId: input.siteId,
      userId: input.userId || this.context.userId,
      deviceId: input.deviceId || this.context.deviceId,
      title: input.title,
      status: input.status ?? 'DRAFT',
      scheduledDate: input.scheduledDate ?? null,
      completedDate: input.completedDate ?? null,
      notes: input.notes ?? null,
      version: 1,
      isDeleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    inspectionSchema.parse(entity);

    return this.executeAtomicMutation('CREATE', entity, null, {
      id: entity.id,
      siteId: entity.siteId,
      userId: entity.userId,
      deviceId: entity.deviceId,
      title: entity.title,
      status: entity.status,
      scheduledDate: entity.scheduledDate,
      completedDate: entity.completedDate,
      notes: entity.notes,
    });
  }

  /**
   * Updates an existing inspection.
   */
  async update(id: string, patch: UpdateInspectionInput): Promise<Inspection> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Inspection with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const baseVersion = existing.version;
    const updatedEntity: Inspection = {
      ...existing,
      ...patch,
      version: baseVersion + 1,
      updatedAt: now,
    };

    inspectionSchema.parse(updatedEntity);

    return this.executeAtomicMutation(
      'UPDATE',
      updatedEntity,
      baseVersion,
      patch as Record<string, unknown>
    );
  }

  /**
   * Marks an inspection as deleted.
   */
  async delete(id: string): Promise<Inspection> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Inspection with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const baseVersion = existing.version;
    const deletedEntity: Inspection = {
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
   * Lists inspections by site ID.
   */
  async listBySiteId(siteId: string, includeDeleted = false): Promise<Inspection[]> {
    const records = await this.table.where('siteId').equals(siteId).toArray();
    if (includeDeleted) return records;
    return records.filter((r) => !r.isDeleted);
  }
}
