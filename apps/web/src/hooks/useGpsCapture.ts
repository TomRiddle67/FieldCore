import { useState, useCallback } from 'react';
import type { GPSMetadata } from '@fieldcore/types';
import { captureGpsCoordinates, type GpsCaptureOptions } from '../services/gps';

export type GpsStatus = 'idle' | 'capturing' | 'success' | 'degraded';

export function useGpsCapture() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle');

  const captureOnSave = useCallback(
    async (options?: GpsCaptureOptions): Promise<GPSMetadata | null> => {
      setIsCapturing(true);
      setGpsStatus('capturing');

      try {
        const coords = await captureGpsCoordinates(options);
        if (coords) {
          setGpsStatus('success');
          return coords;
        } else {
          setGpsStatus('degraded');
          return null;
        }
      } catch {
        setGpsStatus('degraded');
        return null;
      } finally {
        setIsCapturing(false);
      }
    },
    []
  );

  return {
    isCapturing,
    gpsStatus,
    captureOnSave,
  };
}
