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

    return this.executeAtomicMutation(
      'CREATE',
      id,
      (_current) => {
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
        return { entity, baseVersion: null };
      },
      (entity) => ({
        id: entity.id,
        siteId: entity.siteId,
        userId: entity.userId,
        deviceId: entity.deviceId,
        title: entity.title,
        status: entity.status,
        scheduledDate: entity.scheduledDate,
        completedDate: entity.completedDate,
        notes: entity.notes,
      })
    );
  }

  /**
   * Updates an existing inspection — read happens inside the transaction.
   */
  async update(id: string, patch: UpdateInspectionInput): Promise<Inspection> {
    return this.executeAtomicMutation(
      'UPDATE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Inspection with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const updated: Inspection = {
          ...current,
          ...patch,
          version: baseVersion + 1,
          updatedAt: new Date().toISOString(),
        };
        inspectionSchema.parse(updated);
        return { entity: updated, baseVersion };
      },
      () => patch as Record<string, unknown>
    );
  }

  /**
   * Marks an inspection as deleted.
   */
  async delete(id: string): Promise<Inspection> {
    return this.executeAtomicMutation(
      'DELETE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Inspection with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const now = new Date().toISOString();
        const deleted: Inspection = {
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
   * Lists inspections by site ID.
   */
  async listBySiteId(siteId: string, includeDeleted = false): Promise<Inspection[]> {
    const records = await this.table.where('siteId').equals(siteId).toArray();
    if (includeDeleted) return records;
    return records.filter((r) => !r.isDeleted);
  }
}
