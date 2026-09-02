import { describe, it, expect } from 'vitest';
import {
  projectSchema,
  siteSchema,
  inspectionSchema,
  measurementSchema,
  userSchema,
  deviceSchema,
} from '../domain.js';

describe('Domain Model Schemas', () => {
  const validUUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const now = new Date().toISOString();

  describe('User Schema', () => {
    it('validates a valid user object', () => {
      const user = {
        id: validUUID,
        email: 'geologist@fieldcore.io',
        name: 'Sarah Connor',
        role: 'GEOLOGIST',
        createdAt: now,
        updatedAt: now,
      };
      const result = userSchema.safeParse(user);
      expect(result.success).toBe(true);
    });

    it('rejects invalid email and non-UUID id', () => {
      const invalidUser = {
        id: '123-not-uuid',
        email: 'invalid-email',
        name: '',
        role: 'INVALID_ROLE',
        createdAt: 'invalid-date',
        updatedAt: 'invalid-date',
      };
      const result = userSchema.safeParse(invalidUser);
      expect(result.success).toBe(false);
    });
  });

  describe('Device Schema', () => {
    it('validates a valid device with default isRevoked = false and offlineAuthWindowDays = 7', () => {
      const device = {
        id: validUUID,
        userId: validUUID,
        deviceIdentifier: 'iPad-Field-01',
        name: 'Field iPad Pro',
        platform: 'MOBILE_IOS',
        lastSeenAt: now,
        lastRevalidatedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const result = deviceSchema.safeParse(device);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isRevoked).toBe(false);
        expect(result.data.offlineAuthWindowDays).toBe(7);
      }
    });
  });

  describe('Project Schema', () => {
    it('validates valid project with default version 1', () => {
      const project = {
        id: validUUID,
        name: 'Northern Ridge Survey',
        code: 'NR-2026',
        description: 'Exploration drilling for lithium deposit',
        createdAt: now,
        updatedAt: now,
      };
      const result = projectSchema.safeParse(project);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe(1);
        expect(result.data.status).toBe('ACTIVE');
        expect(result.data.isDeleted).toBe(false);
      }
    });

    it('rejects project with invalid code containing spaces or special chars', () => {
      const project = {
        id: validUUID,
        name: 'Northern Ridge',
        code: 'NR 2026 !@#',
        createdAt: now,
        updatedAt: now,
      };
      const result = projectSchema.safeParse(project);
      expect(result.success).toBe(false);
    });

    it('rejects non-UUID identifier', () => {
      const project = {
        id: 'local_id_123',
        name: 'Northern Ridge',
        code: 'NR-2026',
        createdAt: now,
        updatedAt: now,
      };
      const result = projectSchema.safeParse(project);
      expect(result.success).toBe(false);
    });
  });

  describe('Site Schema', () => {
    it('validates site with GPS coordinates', () => {
      const site = {
        id: validUUID,
        projectId: validUUID,
        name: 'Drill Hole DH-001',
        code: 'DH-001',
        gps: {
          latitude: -23.5505,
          longitude: 133.3456,
          altitude: 450.2,
          accuracy: 1.5,
          timestamp: now,
        },
        createdAt: now,
        updatedAt: now,
      };
      const result = siteSchema.safeParse(site);
      expect(result.success).toBe(true);
    });
  });

  describe('Inspection & Measurement Schemas', () => {
    it('validates inspection hierarchy and lifecycle', () => {
      const inspection = {
        id: validUUID,
        siteId: validUUID,
        userId: validUUID,
        deviceId: validUUID,
        title: 'Core logging section 0-50m',
        status: 'IN_PROGRESS',
        scheduledDate: now,
        notes: 'Encountered high fractured zone at 25m',
        createdAt: now,
        updatedAt: now,
      };
      const result = inspectionSchema.safeParse(inspection);
      expect(result.success).toBe(true);
    });

    it('validates measurement with numeric metric', () => {
      const measurement = {
        id: validUUID,
        inspectionId: validUUID,
        metricType: 'RQD',
        numericValue: 87.5,
        unit: '%',
        recordedAt: now,
        notes: 'Rock Quality Designation',
        createdAt: now,
        updatedAt: now,
      };
      const result = measurementSchema.safeParse(measurement);
      expect(result.success).toBe(true);
    });
  });
});
