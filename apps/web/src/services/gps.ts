import type { GPSMetadata } from '@fieldcore/types';
import { gpsMetadataSchema } from '@fieldcore/validation';

export interface GpsCaptureOptions {
  timeoutMs?: number;
  enableHighAccuracy?: boolean;
}

/**
 * Captures GPS coordinates from the browser Geolocation API.
 *
 * LOCKED SPECIFICATION (Option A - Soft Degradation):
 * - Runs with 5,000ms timeout and high accuracy.
 * - Triggered strictly at the moment of record save, NOT on form open.
 * - On permission denial, timeout, or hardware unavailability, resolves to null.
 * - NEVER throws or blocks a save. Offline/underground field operations proceed unhindered.
 */
export async function captureGpsCoordinates(
  options: GpsCaptureOptions = {}
): Promise<GPSMetadata | null> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const enableHighAccuracy = options.enableHighAccuracy ?? true;

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return null;
  }

  return new Promise((resolve) => {
    let hasResolved = false;

    // Safety timeout timer in case geolocation hangs
    const timer = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        resolve(null);
      }
    }, timeoutMs);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (hasResolved) return;
        hasResolved = true;
        clearTimeout(timer);

        try {
          const rawGps: GPSMetadata = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy ?? 0,
            altitude: position.coords.altitude ?? null,
            heading: position.coords.heading ?? null,
            speed: position.coords.speed ?? null,
            timestamp: new Date(position.timestamp).toISOString(),
          };

          // Validate against schema
          const validated = gpsMetadataSchema.parse(rawGps);
          resolve(validated);
        } catch {
          // Schema validation failed (e.g. invalid latitude/longitude range) -> degrade gracefully
          resolve(null);
        }
      },
      (_err) => {
        if (hasResolved) return;
        hasResolved = true;
        clearTimeout(timer);
        // Permission denied, position unavailable, or browser timeout -> degrade gracefully
        resolve(null);
      },
      {
        enableHighAccuracy,
        timeout: timeoutMs,
        maximumAge: 10000,
      }
    );
  });
}
