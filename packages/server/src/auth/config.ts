/**
 * Authentication configuration module.
 *
 * Reads all authentication-related environment variables and validates them at
 * module-load time.  If any required variable is missing or invalid the process
 * fails with an explicit error — fail closed, never silently use insecure defaults.
 */

export const AUTH_ALGORITHM = 'HS256' as const;
export type AuthAlgorithm = typeof AUTH_ALGORITHM;

export interface AuthConfig {
  /** HS256 signing secret for JWT access tokens. Must be >= 32 chars. */
  jwtSecret: string;
  /** Explicitly pinned algorithm — always 'HS256'. Never overrideable at runtime. */
  jwtAlgorithm: AuthAlgorithm;
  /** Access token lifetime in seconds. Default: 900 (15 minutes). */
  accessTokenTtlSeconds: number;
  /** Refresh token lifetime in days. Default: 30 days. */
  refreshTokenTtlDays: number;
}

/**
 * Loads and validates authentication configuration from environment variables.
 *
 * Required:
 *   JWT_SECRET  — signing secret, minimum 32 characters
 *
 * Optional (with secure defaults):
 *   ACCESS_TOKEN_TTL_SECONDS  — integer, defaults to 900 (15 min)
 *   REFRESH_TOKEN_TTL_DAYS    — integer, defaults to 30
 *
 * @throws {Error} if JWT_SECRET is missing or too short.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      '[auth-config] JWT_SECRET environment variable is required but not set. ' +
        'Set a cryptographically random secret of at least 32 characters. ' +
        'See .env.example for guidance.'
    );
  }
  if (jwtSecret.length < 32) {
    throw new Error(
      `[auth-config] JWT_SECRET is too short (${jwtSecret.length} chars). ` +
        'Minimum length is 32 characters for HS256 security margin.'
    );
  }

  const rawAccessTtl = env.ACCESS_TOKEN_TTL_SECONDS;
  const accessTokenTtlSeconds = rawAccessTtl ? parseInt(rawAccessTtl, 10) : 900;
  if (isNaN(accessTokenTtlSeconds) || accessTokenTtlSeconds < 60) {
    throw new Error(
      `[auth-config] ACCESS_TOKEN_TTL_SECONDS must be an integer >= 60, got: ${rawAccessTtl}`
    );
  }

  const rawRefreshTtl = env.REFRESH_TOKEN_TTL_DAYS;
  const refreshTokenTtlDays = rawRefreshTtl ? parseInt(rawRefreshTtl, 10) : 30;
  if (isNaN(refreshTokenTtlDays) || refreshTokenTtlDays < 1) {
    throw new Error(
      `[auth-config] REFRESH_TOKEN_TTL_DAYS must be an integer >= 1, got: ${rawRefreshTtl}`
    );
  }

  return {
    jwtSecret,
    jwtAlgorithm: AUTH_ALGORITHM,
    accessTokenTtlSeconds,
    refreshTokenTtlDays,
  };
}
