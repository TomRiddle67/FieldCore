import { describe, it, expect } from 'vitest';
import { gpsMetadataSchema } from '../gps.js';

describe('GPS Metadata Validation', () => {
  const validTimestamp = new Date().toISOString();

  it('accepts valid latitude and longitude coordinates', () => {
    const validGPS = {
      latitude: -33.8688,
      longitude: 151.2093,
      altitude: 45.8,
      accuracy: 2.1,
      heading: 180.5,
      speed: 1.2,
      timestamp: validTimestamp,
    };
    const result = gpsMetadataSchema.safeParse(validGPS);
    expect(result.success).toBe(true);
  });

  it('rejects latitude outside [-90, 90]', () => {
    const invalidGPS = {
      latitude: 91.5,
      longitude: 0,
      timestamp: validTimestamp,
    };
    const result = gpsMetadataSchema.safeParse(invalidGPS);
    expect(result.success).toBe(false);
  });

  it('rejects longitude outside [-180, 180]', () => {
    const invalidGPS = {
      latitude: 0,
      longitude: -185.2,
      timestamp: validTimestamp,
    };
    const result = gpsMetadataSchema.safeParse(invalidGPS);
    expect(result.success).toBe(false);
  });

  it('rejects negative accuracy or speed', () => {
    const negativeAccuracy = {
      latitude: 10,
      longitude: 20,
      accuracy: -5,
      timestamp: validTimestamp,
    };
    expect(gpsMetadataSchema.safeParse(negativeAccuracy).success).toBe(false);

    const negativeSpeed = {
      latitude: 10,
      longitude: 20,
      speed: -2,
      timestamp: validTimestamp,
    };
    expect(gpsMetadataSchema.safeParse(negativeSpeed).success).toBe(false);
  });

  it('rejects heading outside [0, 360]', () => {
    const invalidHeading = {
      latitude: 10,
      longitude: 20,
      heading: 365,
      timestamp: validTimestamp,
    };
    expect(gpsMetadataSchema.safeParse(invalidHeading).success).toBe(false);
  });
});
