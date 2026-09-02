import { z } from 'zod';
import { gpsMetadataSchema } from './gps.js';

/**
 * Standard UUIDv4 schema for client-generated and server-generated identifiers.
 */
export const uuidSchema = z
  .string()
  .uuid({ message: 'Must be a valid UUIDv4' });

/**
 * User roles in Fieldcore.
 */
export const userRoleSchema = z.enum(['ADMIN', 'SUPERVISOR', 'GEOLOGIST', 'OPERATOR']);

/**
 * User validation schema.
 */
export const userSchema = z.object({
  id: uuidSchema,
  email: z.string().email({ message: 'Invalid email address' }),
  name: z.string().min(1, 'Name is required').max(255),
  role: userRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Device platform options.
 */
export const devicePlatformSchema = z.enum([
  'WEB',
  'DESKTOP',
  'MOBILE_IOS',
  'MOBILE_ANDROID',
]);

/**
 * Device validation schema.
 */
export const deviceSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  deviceIdentifier: z.string().min(1, 'Device identifier is required').max(255),
  name: z.string().min(1, 'Device name is required').max(255),
  platform: devicePlatformSchema,
  lastSeenAt: z.string().datetime(),
  lastRevalidatedAt: z.string().datetime(),
  offlineAuthWindowDays: z.number().int().min(1).default(7),
  isRevoked: z.boolean().default(false),
  revokedAt: z.string().datetime().nullable().optional(),
  revokedReason: z.string().max(500).nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Project status enum.
 */
export const projectStatusSchema = z.enum(['ACTIVE', 'ARCHIVED', 'COMPLETED']);

/**
 * Project domain schema.
 */
export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1, 'Project name is required').max(255),
  code: z
    .string()
    .min(1, 'Project code is required')
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/, 'Project code must contain only alphanumeric characters, underscores, and dashes'),
  description: z.string().max(2000).nullable().optional(),
  status: projectStatusSchema.default('ACTIVE'),
  version: z.number().int().min(1, 'Version must be at least 1').default(1),
  isDeleted: z.boolean().default(false),
  deletedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Site domain schema.
 */
export const siteSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  name: z.string().min(1, 'Site name is required').max(255),
  code: z
    .string()
    .min(1, 'Site code is required')
    .max(50)
    .regex(/^[A-Za-z0-9_-]+$/, 'Site code must contain only alphanumeric characters, underscores, and dashes'),
  gps: gpsMetadataSchema.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  version: z.number().int().min(1, 'Version must be at least 1').default(1),
  isDeleted: z.boolean().default(false),
  deletedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Inspection status enum.
 */
export const inspectionStatusSchema = z.enum([
  'DRAFT',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

/**
 * Inspection domain schema.
 */
export const inspectionSchema = z.object({
  id: uuidSchema,
  siteId: uuidSchema,
  userId: uuidSchema,
  deviceId: uuidSchema,
  title: z.string().min(1, 'Inspection title is required').max(255),
  status: inspectionStatusSchema.default('DRAFT'),
  scheduledDate: z.string().datetime().nullable().optional(),
  completedDate: z.string().datetime().nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  version: z.number().int().min(1, 'Version must be at least 1').default(1),
  isDeleted: z.boolean().default(false),
  deletedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Measurement metric types.
 */
export const measurementMetricTypeSchema = z.enum([
  'DENSITY',
  'MOISTURE',
  'TEMPERATURE',
  'PH',
  'CORE_RECOVERY',
  'RQD',
  'CUSTOM',
]);

/**
 * Measurement domain schema.
 */
export const measurementSchema = z.object({
  id: uuidSchema,
  inspectionId: uuidSchema,
  metricType: measurementMetricTypeSchema,
  numericValue: z.number().nullable().optional(),
  stringValue: z.string().max(1000).nullable().optional(),
  unit: z.string().max(50),
  gps: gpsMetadataSchema.nullable().optional(),
  recordedAt: z.string().datetime(),
  notes: z.string().max(5000).nullable().optional(),
  version: z.number().int().min(1, 'Version must be at least 1').default(1),
  isDeleted: z.boolean().default(false),
  deletedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Entity type schema for synchronizable models.
 */
export const entityTypeSchema = z.enum([
  'PROJECT',
  'SITE',
  'INSPECTION',
  'MEASUREMENT',
]);
