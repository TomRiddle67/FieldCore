import { z } from 'zod';

/**
 * Zod schema for GPS metadata validation.
 */
export const gpsMetadataSchema = z.object({
  latitude: z
    .number()
    .min(-90, 'Latitude must be between -90 and 90 degrees')
    .max(90, 'Latitude must be between -90 and 90 degrees'),
  longitude: z
    .number()
    .min(-180, 'Longitude must be between -180 and 180 degrees')
    .max(180, 'Longitude must be between -180 and 180 degrees'),
  altitude: z.number().nullable().optional(),
  accuracy: z
    .number()
    .min(0, 'Accuracy must be a non-negative number in meters')
    .nullable()
    .optional(),
  heading: z
    .number()
    .min(0, 'Heading must be between 0 and 360 degrees')
    .max(360, 'Heading must be between 0 and 360 degrees')
    .nullable()
    .optional(),
  speed: z
    .number()
    .min(0, 'Speed must be a non-negative number in m/s')
    .nullable()
    .optional(),
  timestamp: z.string().datetime({ message: 'GPS timestamp must be a valid ISO 8601 string' }),
});

export type GPSMetadataInput = z.infer<typeof gpsMetadataSchema>;
