import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  doublePrecision,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import type { GPSMetadata } from '@fieldcore/types';

/**
 * Users table
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  role: varchar('role', { length: 50 }).notNull(), // 'ADMIN' | 'SUPERVISOR' | 'GEOLOGIST' | 'OPERATOR'
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/**
 * Devices table
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceIdentifier: varchar('device_identifier', { length: 255 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    platform: varchar('platform', { length: 50 }).notNull(), // 'WEB' | 'DESKTOP' | 'MOBILE_IOS' | 'MOBILE_ANDROID'
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    lastRevalidatedAt: timestamp('last_revalidated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    offlineAuthWindowDays: integer('offline_auth_window_days').notNull().default(7),
    isRevoked: boolean('is_revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('devices_user_id_idx').on(table.userId),
    index('devices_is_revoked_idx').on(table.isRevoked),
  ]
);

/**
 * Projects table
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    description: text('description'),
    status: varchar('status', { length: 50 }).notNull().default('ACTIVE'), // 'ACTIVE' | 'ARCHIVED' | 'COMPLETED'
    version: integer('version').notNull().default(1),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('projects_code_idx').on(table.code),
    index('projects_is_deleted_idx').on(table.isDeleted),
  ]
);

/**
 * Sites table
 */
export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 50 }).notNull(),
    gps: jsonb('gps').$type<GPSMetadata | null>(),
    description: text('description'),
    version: integer('version').notNull().default(1),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('sites_project_id_idx').on(table.projectId),
    index('sites_is_deleted_idx').on(table.isDeleted),
  ]
);

/**
 * Inspections table
 */
export const inspections = pgTable(
  'inspections',
  {
    id: uuid('id').primaryKey(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 50 }).notNull().default('DRAFT'), // 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
    scheduledDate: timestamp('scheduled_date', { withTimezone: true, mode: 'string' }),
    completedDate: timestamp('completed_date', { withTimezone: true, mode: 'string' }),
    notes: text('notes'),
    version: integer('version').notNull().default(1),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('inspections_site_id_idx').on(table.siteId),
    index('inspections_user_id_idx').on(table.userId),
    index('inspections_is_deleted_idx').on(table.isDeleted),
  ]
);

/**
 * Measurements table
 */
export const measurements = pgTable(
  'measurements',
  {
    id: uuid('id').primaryKey(),
    inspectionId: uuid('inspection_id')
      .notNull()
      .references(() => inspections.id, { onDelete: 'restrict' }),
    metricType: varchar('metric_type', { length: 50 }).notNull(), // 'DENSITY' | 'MOISTURE' | 'TEMPERATURE' | 'PH' | 'CORE_RECOVERY' | 'RQD' | 'CUSTOM'
    numericValue: doublePrecision('numeric_value'),
    stringValue: text('stringValue'),
    unit: varchar('unit', { length: 50 }).notNull(),
    gps: jsonb('gps').$type<GPSMetadata | null>(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    notes: text('notes'),
    version: integer('version').notNull().default(1),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    index('measurements_inspection_id_idx').on(table.inspectionId),
    index('measurements_metric_type_idx').on(table.metricType),
    index('measurements_is_deleted_idx').on(table.isDeleted),
  ]
);
