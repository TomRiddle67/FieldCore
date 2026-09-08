import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureGpsCoordinates } from '../services/gps';

describe('Stage 6 GPS Capture Service — Soft Degradation Invariant', () => {
  const originalNavigator = global.navigator;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
    });
  });

  it('resolves valid GPS metadata when geolocation succeeds', async () => {
    const mockCoords = {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 5,
      altitude: 12.5,
      heading: 90,
      speed: 1.2,
    };

    const mockGeolocation = {
      getCurrentPosition: vi.fn((success) => {
        success({
          coords: mockCoords,
          timestamp: 1725540000000,
        });
      }),
    };

    Object.defineProperty(global, 'navigator', {
      value: { geolocation: mockGeolocation },
      writable: true,
    });

    const promise = captureGpsCoordinates({ timeoutMs: 1000 });
    const result = await promise;

    expect(result).not.toBeNull();
    expect(result?.latitude).toBe(37.7749);
    expect(result?.longitude).toBe(-122.4194);
    expect(result?.accuracy).toBe(5);
  });

  it('soft degradation: resolves to null when geolocation times out (never throws)', async () => {
    const mockGeolocation = {
      getCurrentPosition: vi.fn((_success, _error) => {
        // Hangs indefinitely to simulate canyon / cave with no satellite lock
      }),
    };

    Object.defineProperty(global, 'navigator', {
      value: { geolocation: mockGeolocation },
      writable: true,
    });

    const promise = captureGpsCoordinates({ timeoutMs: 2000 });

    // Advance time past the 2000ms timeout
    vi.advanceTimersByTime(2500);

    const result = await promise;
    // Core invariant: MUST resolve to null and NOT throw or block
    expect(result).toBeNull();
  });

  it('soft degradation: resolves to null when user denies permission (never throws)', async () => {
    const mockGeolocation = {
      getCurrentPosition: vi.fn((_success, error) => {
        error({
          code: 1, // PERMISSION_DENIED
          message: 'User denied Geolocation',
        });
      }),
    };

    Object.defineProperty(global, 'navigator', {
      value: { geolocation: mockGeolocation },
      writable: true,
    });

    const result = await captureGpsCoordinates({ timeoutMs: 1000 });
    expect(result).toBeNull();
  });

  it('soft degradation: resolves to null when coordinates fail schema validation (e.g. invalid latitude)', async () => {
    const mockCoords = {
      latitude: 195.0, // Invalid latitude (> 90)
      longitude: -122.4194,
      accuracy: 5,
    };

    const mockGeolocation = {
      getCurrentPosition: vi.fn((success) => {
        success({
          coords: mockCoords,
          timestamp: Date.now(),
        });
      }),
    };

    Object.defineProperty(global, 'navigator', {
      value: { geolocation: mockGeolocation },
      writable: true,
    });

    const result = await captureGpsCoordinates({ timeoutMs: 1000 });
    // Invalid coordinates fail Zod schema validation and degrade safely to null
    expect(result).toBeNull();
  });
});
