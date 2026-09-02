import { describe, it, expect } from 'vitest';
import {
  users,
  devices,
  projects,
  sites,
  inspections,
  measurements,
  changeLog,
  idempotencyRecords,
  conflicts,
  syncCursors,
  syncAttempts,
} from '../schema/index.js';

describe('Database Schema Table Definitions', () => {
  it('defines all required domain tables', () => {
    expect(users).toBeDefined();
    expect(devices).toBeDefined();
    expect(projects).toBeDefined();
    expect(sites).toBeDefined();
    expect(inspections).toBeDefined();
    expect(measurements).toBeDefined();
  });

  it('defines all required sync infrastructure tables', () => {
    expect(changeLog).toBeDefined();
    expect(idempotencyRecords).toBeDefined();
    expect(conflicts).toBeDefined();
    expect(syncCursors).toBeDefined();
    expect(syncAttempts).toBeDefined();
  });

  it('has sequence primary key on changeLog', () => {
    expect(changeLog.sequence).toBeDefined();
    expect(changeLog.sequence.name).toBe('sequence');
    expect(changeLog.isTombstone).toBeDefined();
    expect(changeLog.operationId).toBeDefined();
  });

  it('has operationId primary key on idempotencyRecords', () => {
    expect(idempotencyRecords.operationId).toBeDefined();
    expect(idempotencyRecords.appliedSequence).toBeDefined();
    expect(idempotencyRecords.responsePayload).toBeDefined();
  });

  it('has conflictType and serverState on conflicts table', () => {
    expect(conflicts.conflictId).toBeDefined();
    expect(conflicts.conflictType).toBeDefined();
    expect(conflicts.serverState).toBeDefined();
    expect(conflicts.clientState).toBeDefined();
    expect(conflicts.resolution).toBeDefined();
  });

  it('has version column with default 1 on synchronizable domain tables', () => {
    expect(projects.version).toBeDefined();
    expect(sites.version).toBeDefined();
    expect(inspections.version).toBeDefined();
    expect(measurements.version).toBeDefined();
  });

  it('has isDeleted soft delete column on synchronizable domain tables', () => {
    expect(projects.isDeleted).toBeDefined();
    expect(sites.isDeleted).toBeDefined();
    expect(inspections.isDeleted).toBeDefined();
    expect(measurements.isDeleted).toBeDefined();
  });
});
