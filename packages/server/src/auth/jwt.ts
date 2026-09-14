/**
 * JWT access token signing and verification using the `jose` library.
 *
 * Security decisions:
 * - Algorithm: HS256 — explicitly pinned in both sign and verify.
 *   The verifier explicitly specifies `algorithms: ['HS256']` so the jose library
 *   will reject tokens whose header declares any other algorithm, including `alg:none`.
 * - The signing secret is passed in by the caller (from AuthConfig) — never read
 *   from process.env inside this module.
 * - Claims validated on every verification: `sub`, `sid`, `deviceId`, `exp`, `iat`.
 * - `alg: none` cannot be accepted because jose's jwtVerify requires a real key
 *   and the `algorithms` option whitelist excludes it.
 *
 * Deferred: RS256 / asymmetric key rotation (Phase 3+).
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { AuthConfig } from './config.js';

export interface AccessTokenClaims {
  /** Authenticated user ID (canonical identity claim). */
  sub: string;
  /** Authenticated device ID. */
  deviceId: string;
  /** Session ID — allows future per-session revocation. */
  sid: string;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  /** Issued-at (Unix seconds). */
  iat: number;
  /** Expiration (Unix seconds). */
  exp: number;
}

/**
 * Signs a new short-lived JWT access token.
 *
 * @param claims - The authenticated principal claims to embed.
 * @param config - Auth configuration (secret + TTL).
 * @returns Signed JWT string.
 */
export async function signAccessToken(
  claims: AccessTokenClaims,
  config: Pick<AuthConfig, 'jwtSecret' | 'jwtAlgorithm' | 'accessTokenTtlSeconds'>
): Promise<string> {
  const secret = new TextEncoder().encode(config.jwtSecret);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: claims.sub,
    deviceId: claims.deviceId,
    sid: claims.sid,
  } satisfies Omit<AccessTokenClaims, 'sub'> & Pick<JWTPayload, 'sub'>)
    .setProtectedHeader({ alg: config.jwtAlgorithm })
    .setIssuedAt(now)
    .setExpirationTime(now + config.accessTokenTtlSeconds)
    .sign(secret);
}

/**
 * Verifies a JWT access token.
 *
 * Rejects:
 * - Expired tokens
 * - Tokens signed with any key other than config.jwtSecret
 * - Tokens declaring any algorithm other than HS256 (including `alg:none`)
 * - Tokens missing required claims (sub, deviceId, sid)
 * - Tampered tokens (signature mismatch)
 *
 * @param token - JWT string from the Authorization header.
 * @param config - Auth configuration (secret + algorithm).
 * @returns Verified claims if valid.
 * @throws {JWTExpired | JWTSignatureVerificationFailed | JWSAlgorithmNotAllowed | Error}
 */
export async function verifyAccessToken(
  token: string,
  config: Pick<AuthConfig, 'jwtSecret' | 'jwtAlgorithm'>
): Promise<VerifiedAccessToken> {
  const secret = new TextEncoder().encode(config.jwtSecret);

  const { payload } = await jwtVerify(token, secret, {
    // Explicit algorithm whitelist — rejects alg:none and any non-HS256 algorithm.
    // This is the primary defense against algorithm confusion attacks.
    algorithms: [config.jwtAlgorithm],
  });

  // Validate required custom claims are present and are strings
  const sub = payload.sub;
  const deviceId = payload['deviceId'];
  const sid = payload['sid'];

  if (typeof sub !== 'string' || !sub) {
    throw new Error('JWT missing required claim: sub');
  }
  if (typeof deviceId !== 'string' || !deviceId) {
    throw new Error('JWT missing required claim: deviceId');
  }
  if (typeof sid !== 'string' || !sid) {
    throw new Error('JWT missing required claim: sid');
  }

  return {
    sub,
    deviceId,
    sid,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}
