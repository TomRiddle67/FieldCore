import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import { SiteRepository } from '../repository/site.js';
import { InspectionRepository } from '../repository/inspection.js';
import { MeasurementRepository } from '../repository/measurement.js';
import type { RepositoryContext } from '../repository/base.js';

describe('Domain Repositories CRUD Workflows', () => {
  let db: FieldCoreDexie;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  beforeEach(() => {
    db = new FieldCoreDexie(`test_db_repos_${Date.now()}`);
  });

  afterEach(async () => {
    await db.delete();
  });

  it('completes offline hierarchy creation: Project -> Site -> Inspection -> Measurement', async () => {
    const projectRepo = new ProjectRepository(db, context);
    const siteRepo = new SiteRepository(db, context);
    const inspectionRepo = new InspectionRepository(db, context);
    const measurementRepo = new MeasurementRepository(db, context);

    // 1. Create Project
    const project = await projectRepo.create({
      name: 'Southern Basin Drilling',
      code: 'SB-2026',
    });
    expect(project.version).toBe(1);
    expect(project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // 2. Create Site referencing offline Project ID
    const site = await siteRepo.create({
      projectId: project.id,
      name: 'Pit 04 South',
      code: 'P04-S',
      gps: {
        latitude: -28.1234,
        longitude: 120.5678,
        timestamp: new Date().toISOString(),
      },
    });
    expect(site.projectId).toBe(project.id);
    expect(site.version).toBe(1);

    // 3. Create Inspection referencing offline Site ID
    const inspection = await inspectionRepo.create({
      siteId: site.id,
      title: 'Geotechnical Borehole Log',
      status: 'IN_PROGRESS',
    });
    expect(inspection.siteId).toBe(site.id);
    expect(inspection.version).toBe(1);

    // 4. Create Measurement referencing offline Inspection ID
    const measurement = await measurementRepo.create({
      inspectionId: inspection.id,
      metricType: 'CORE_RECOVERY',
      numericValue: 94.2,
      unit: '%',
    });
    expect(measurement.inspectionId).toBe(inspection.id);
    expect(measurement.version).toBe(1);

    // Verify 4 CREATE operations were queued
    const ops = await db.sync_operations.toArray();
    expect(ops).toHaveLength(4);
    expect(ops.every((op) => op.operationType === 'CREATE' && op.baseVersion === 0)).toBe(true);
  });

  it('increments version on UPDATE and sets baseVersion to previous version', async () => {
    const projectRepo = new ProjectRepository(db, context);

    const created = await projectRepo.create({
      name: 'Northern Ridge Survey',
      code: 'NR-2026',
    });

    const updated = await projectRepo.update(created.id, {
      name: 'Northern Ridge Survey Phase 2',
      status: 'ACTIVE',
    });

    expect(updated.version).toBe(2);

    const ops = await db.sync_operations.where('entityId').equals(created.id).toArray();
    expect(ops).toHaveLength(2);

    const updateOp = ops.find((o) => o.operationType === 'UPDATE');
    expect(updateOp).toBeDefined();
    expect(updateOp?.baseVersion).toBe(1);
  });

  it('marks record as soft deleted and queues DELETE mutation with baseVersion', async () => {
    const siteRepo = new SiteRepository(db, context);

    const site = await siteRepo.create({
      projectId: crypto.randomUUID(),
      name: 'Borehole BH-09',
      code: 'BH-09',
    });

    const deleted = await siteRepo.delete(site.id);
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.deletedAt).toBeDefined();
    expect(deleted.version).toBe(2);

    // By default getById returns null for deleted
    const fetched = await siteRepo.getById(site.id);
    expect(fetched).toBeNull();

    // getById(..., true) includes deleted
    const fetchedDeleted = await siteRepo.getById(site.id, true);
    expect(fetchedDeleted?.isDeleted).toBe(true);

    const ops = await db.sync_operations.where('entityId').equals(site.id).toArray();
    const deleteOp = ops.find((o) => o.operationType === 'DELETE');
    expect(deleteOp).toBeDefined();
    expect(deleteOp?.baseVersion).toBe(1);
  });
});
