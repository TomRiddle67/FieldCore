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

    return this.executeAtomicMutation('CREATE', entity, null, {
      id: entity.id,
      inspectionId: entity.inspectionId,
      metricType: entity.metricType,
      numericValue: entity.numericValue,
      stringValue: entity.stringValue,
      unit: entity.unit,
      gps: entity.gps,
      recordedAt: entity.recordedAt,
      notes: entity.notes,
    });
  }

  /**
   * Updates an existing measurement.
   */
  async update(id: string, patch: UpdateMeasurementInput): Promise<Measurement> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Measurement with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const baseVersion = existing.version;
    const updatedEntity: Measurement = {
      ...existing,
      ...patch,
      version: baseVersion + 1,
      updatedAt: now,
    };

    measurementSchema.parse(updatedEntity);

    return this.executeAtomicMutation(
      'UPDATE',
      updatedEntity,
      baseVersion,
      patch as Record<string, unknown>
    );
  }

  /**
   * Marks a measurement as deleted.
   */
  async delete(id: string): Promise<Measurement> {
    const existing = await this.table.get(id);
    if (!existing || existing.isDeleted) {
      throw new Error(`Measurement with ID ${id} not found.`);
    }

    const now = new Date().toISOString();
    const baseVersion = existing.version;
    const deletedEntity: Measurement = {
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
   * Lists measurements by inspection ID.
   */
  async listByInspectionId(inspectionId: string, includeDeleted = false): Promise<Measurement[]> {
    const records = await this.table.where('inspectionId').equals(inspectionId).toArray();
    if (includeDeleted) return records;
    return records.filter((r) => !r.isDeleted);
  }
}
