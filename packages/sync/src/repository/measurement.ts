import type { FieldCoreDexie } from '../db/database.js';
import { BaseRepository, type RepositoryContext } from './base.js';
import type { Measurement, MeasurementMetricType, GPSMetadata } from '@fieldcore/types';
import { measurementSchema } from '@fieldcore/validation';

export interface CreateMeasurementInput {
  id?: string;
  inspectionId: string;
  metricType: MeasurementMetricType;
  numericValue?: number | null;
  stringValue?: string | null;
  unit: string;
  gps?: GPSMetadata | null;
  recordedAt?: string;
  notes?: string | null;
}

export interface UpdateMeasurementInput {
  metricType?: MeasurementMetricType;
  numericValue?: number | null;
  stringValue?: string | null;
  unit?: string;
  gps?: GPSMetadata | null;
  recordedAt?: string;
  notes?: string | null;
}

export class MeasurementRepository extends BaseRepository<Measurement> {
  constructor(db: FieldCoreDexie, context: RepositoryContext) {
    super(db, db.measurements, 'MEASUREMENT', context);
  }

  /**
   * Creates a new measurement offline under an inspection.
   */
  async create(input: CreateMeasurementInput): Promise<Measurement> {
    const id = input.id || crypto.randomUUID();

    return this.executeAtomicMutation(
      'CREATE',
      id,
      (_current) => {
        const now = new Date().toISOString();
        const entity: Measurement = {
          id,
          inspectionId: input.inspectionId,
          metricType: input.metricType,
          numericValue: input.numericValue ?? null,
          stringValue: input.stringValue ?? null,
          unit: input.unit,
          gps: input.gps ?? null,
          recordedAt: input.recordedAt || now,
          notes: input.notes ?? null,
          version: 1,
          isDeleted: false,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        measurementSchema.parse(entity);
        return { entity, baseVersion: null };
      },
      (entity) => ({
        id: entity.id,
        inspectionId: entity.inspectionId,
        metricType: entity.metricType,
        numericValue: entity.numericValue,
        stringValue: entity.stringValue,
        unit: entity.unit,
        gps: entity.gps,
        recordedAt: entity.recordedAt,
        notes: entity.notes,
      })
    );
  }

  /**
   * Updates an existing measurement — read happens inside the transaction.
   */
  async update(id: string, patch: UpdateMeasurementInput): Promise<Measurement> {
    return this.executeAtomicMutation(
      'UPDATE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Measurement with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const updated: Measurement = {
          ...current,
          ...patch,
          version: baseVersion + 1,
          updatedAt: new Date().toISOString(),
        };
        measurementSchema.parse(updated);
        return { entity: updated, baseVersion };
      },
      () => patch as Record<string, unknown>
    );
  }

  /**
   * Marks a measurement as deleted.
   */
  async delete(id: string): Promise<Measurement> {
    return this.executeAtomicMutation(
      'DELETE',
      id,
      (current) => {
        if (!current || current.isDeleted) {
          throw new Error(`Measurement with ID ${id} not found.`);
        }
        const baseVersion = current.version;
        const now = new Date().toISOString();
        const deleted: Measurement = {
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
   * Lists measurements by inspection ID, ordered newest first (createdAt descending).
   */
  async listByInspectionId(inspectionId: string, includeDeleted = false): Promise<Measurement[]> {
    const records = await this.table.where('inspectionId').equals(inspectionId).toArray();
    const filtered = includeDeleted ? records : records.filter((r) => !r.isDeleted);
    return filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}
