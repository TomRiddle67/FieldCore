/**
 * GPS Metadata representation for location-tagged field observations.
 */
export interface GPSMetadata {
  latitude: number;
  longitude: number;
  altitude?: number | null;
  accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp: string; // ISO 8601 string
}

/**
 * User roles in Fieldcore field operations.
 */
export type UserRole = 'ADMIN' | 'SUPERVISOR' | 'GEOLOGIST' | 'OPERATOR';

/**
 * User account identity.
 */
export interface User {
  id: string; // UUIDv4
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/**
 * Client device platform classification.
 */
export type DevicePlatform = 'WEB' | 'DESKTOP' | 'MOBILE_IOS' | 'MOBILE_ANDROID';

/**
 * Physical or browser client device registration.
 */
export interface Device {
  id: string; // UUIDv4
  userId: string;
  deviceIdentifier: string;
  name: string;
  platform: DevicePlatform;
  lastSeenAt: string;
  lastRevalidatedAt: string;
  offlineAuthWindowDays: number; // Default 7 days
  isRevoked: boolean;
  revokedAt?: string | null;
  revokedReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Project lifecycle statuses.
 */
export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'COMPLETED';

/**
 * Operational field survey/mining project.
 */
export interface Project {
  id: string; // Client-generated UUIDv4
  name: string;
  code: string;
  description?: string | null;
  status: ProjectStatus;
  version: number;
  isDeleted: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Geographical site / borehole / pit within a project.
 */
export interface Site {
  id: string; // Client-generated UUIDv4
  projectId: string;
  name: string;
  code: string;
  gps?: GPSMetadata | null;
  description?: string | null;
  version: number;
  isDeleted: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Inspection workflow statuses.
 */
export type InspectionStatus = 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

/**
 * Field inspection or observation session.
 */
export interface Inspection {
  id: string; // Client-generated UUIDv4
  siteId: string;
  userId: string;
  deviceId: string;
  title: string;
  status: InspectionStatus;
  scheduledDate?: string | null;
  completedDate?: string | null;
  notes?: string | null;
  version: number;
  isDeleted: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Types of geological and engineering measurements.
 */
export type MeasurementMetricType =
  | 'DENSITY'
  | 'MOISTURE'
  | 'TEMPERATURE'
  | 'PH'
  | 'CORE_RECOVERY'
  | 'RQD'
  | 'CUSTOM';

/**
 * Quantitative or qualitative field measurement.
 */
export interface Measurement {
  id: string; // Client-generated UUIDv4
  inspectionId: string;
  metricType: MeasurementMetricType;
  numericValue?: number | null;
  stringValue?: string | null;
  unit: string;
  gps?: GPSMetadata | null;
  recordedAt: string;
  notes?: string | null;
  version: number;
  isDeleted: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Supported domain entity types for synchronization.
 */
export type EntityType = 'PROJECT' | 'SITE' | 'INSPECTION' | 'MEASUREMENT';

/**
 * Mapping from EntityType to corresponding domain interface.
 */
export interface EntityTypeMap {
  PROJECT: Project;
  SITE: Site;
  INSPECTION: Inspection;
  MEASUREMENT: Measurement;
}
