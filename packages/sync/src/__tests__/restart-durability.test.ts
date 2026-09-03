import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { FieldCoreDexie } from '../db/database.js';
import { ProjectRepository } from '../repository/project.js';
import { SiteRepository } from '../repository/site.js';
import { InspectionRepository } from '../repository/inspection.js';
import { MeasurementRepository } from '../repository/measurement.js';
import type { RepositoryContext } from '../repository/base.js';

describe('Restart-Persistence Durability (Simulated App Restart)', () => {
  const dbName = `test_db_restart_${Date.now()}`;
  const context: RepositoryContext = {
    userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    clientId: 'client-offline-01',
  };

  afterEach(async () => {
    const cleanupDb = new FieldCoreDexie(dbName);
    await cleanupDb.delete();
  });

  it('preserves all domain entities, versions, and queued sync operations across database close and reopen', async () => {
    // 1. Session 1: Open database and perform offline CRUD
    let session1Db: FieldCoreDexie | null = new FieldCoreDexie(dbName);
    const pRepo = new ProjectRepository(session1Db, context);
    const sRepo = new SiteRepository(session1Db, context);
    const iRepo = new InspectionRepository(session1Db, context);
    const mRepo = new MeasurementRepository(session1Db, context);

    const project = await pRepo.create({ name: 'Durability Gold Mine', code: 'DGM-01' });
    const site = await sRepo.create({ projectId: project.id, name: 'Durability Pit', code: 'DP-01' });
    const inspection = await iRepo.create({ siteId: site.id, title: 'Durability Check' });
    const measurement = await mRepo.create({
      inspectionId: inspection.id,
      metricType: 'DENSITY',
      numericValue: 2.75,
      unit: 'g/cm³',
    });

    // Update project
    await pRepo.update(project.id, { description: 'Updated before restart' });

    // Verify Session 1 counts before close
    expect(await session1Db.projects.count()).toBe(1);
    expect(await session1Db.sites.count()).toBe(1);
    expect(await session1Db.inspections.count()).toBe(1);
    expect(await session1Db.measurements.count()).toBe(1);
    expect(await session1Db.sync_operations.count()).toBe(5); // 4 creates + 1 update

    // 2. Simulate complete application restart / browser reload
    session1Db.close();
    session1Db = null;

    // 3. Session 2: Instantiate new Dexie instance on the same database name
    const session2Db = new FieldCoreDexie(dbName);
    const session2ProjectRepo = new ProjectRepository(session2Db, context);
    const session2MeasurementRepo = new MeasurementRepository(session2Db, context);

    // Verify domain entities survived
    const restoredProject = await session2ProjectRepo.getById(project.id);
    expect(restoredProject).toBeDefined();
    expect(restoredProject?.name).toBe('Durability Gold Mine');
    expect(restoredProject?.description).toBe('Updated before restart');
    expect(restoredProject?.version).toBe(2);

    const restoredMeasurement = await session2MeasurementRepo.getById(measurement.id);
    expect(restoredMeasurement).toBeDefined();
    expect(restoredMeasurement?.numericValue).toBe(2.75);
    expect(restoredMeasurement?.version).toBe(1);

    // Verify all 5 queued sync operations survived with uncorrupted payloads
    const queuedOps = await session2Db.sync_operations.toArray();
    expect(queuedOps).toHaveLength(5);

    const createOps = queuedOps.filter((o) => o.operationType === 'CREATE');
    expect(createOps).toHaveLength(4);
    // CREATE operations always carry null baseVersion — never 0
    expect(createOps.every((o) => o.baseVersion === null)).toBe(true);

    const updateOps = queuedOps.filter((o) => o.operationType === 'UPDATE');
    expect(updateOps).toHaveLength(1);
    expect(updateOps[0].entityId).toBe(project.id);
    expect(updateOps[0].baseVersion).toBe(1);

    session2Db.close();
  });
});
