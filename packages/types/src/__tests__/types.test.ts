import { describe, it, expect } from 'vitest';
import type {
  User,
  Device,
  Project,
  Site,
  Inspection,
  Measurement,
  SyncOperation,
  ServerChangeLog,
  ConflictRecord,
  SyncCursor,
  SyncAttempt,
} from '../index.js';

describe('TypeScript Type Contracts', () => {
  it('allows constructing valid domain entity type instances', () => {
    const user: User = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      email: 'user@fieldcore.io',
      name: 'Jane Doe',
      role: 'GEOLOGIST',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const project: Project = {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      name: 'Project Borehole',
      code: 'BH-2026',
      status: 'ACTIVE',
      version: 1,
      isDeleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(user.id).toBeDefined();
    expect(project.code).toBe('BH-2026');
  });

  it('allows constructing valid sync infrastructure type instances', () => {
    const op: SyncOperation = {
      operationId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
      entityType: 'PROJECT',
      entityId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      operationType: 'CREATE',
      baseVersion: 0,
      payload: { name: 'Project Borehole' },
      status: 'PENDING',
      clientId: 'client-1',
      deviceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
      userId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };

    expect(op.operationType).toBe('CREATE');
    expect(op.status).toBe('PENDING');
  });
});
