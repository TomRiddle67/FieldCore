/**
 * Opaque refresh token generation and hashing.
 *
 * Security decisions:
 * - Refresh tokens are cryptographically random 48-byte values encoded as hex strings.
 *   48 bytes = 384 bits of entropy, well above the OWASP minimum of 128 bits.
 * - The raw token is returned to the client exactly once (at issuance).
 * - Only the SHA-256 hash of the raw token is stored in the database.
 *   This means even if the database is compromised, the raw tokens are not exposed.
 * - SHA-256 is appropriate here because the tokens already have sufficient entropy
 *   (no need for a work-factor KDF like Argon2 for high-entropy random values).
 * - Refresh tokens are NOT JWTs — they are opaque to the client and must be
 *   validated against the database record (revocable by design).
 *
 * Deferred:
 * - Token rotation / reuse detection (Phase 2)
 * - Session-family revocation on reuse detection (Phase 2)
 */

import { randomBytes, createHash } from 'node:crypto';

/** Raw refresh token string (96 hex chars = 48 bytes). Returned to the client once. */
export type RawRefreshToken = string;

/** SHA-256 hash of a raw refresh token. Stored in the database. */
export type HashedRefreshToken = string;

/**
 * Generates a cryptographically random opaque refresh token.
 * The caller must immediately hash the result for storage and return the raw
 * token to the client — the raw token must NOT be stored.
 *
 * @returns 96-character lowercase hex string (48 bytes of entropy).
 */
export function generateRefreshToken(): RawRefreshToken {
  return randomBytes(48).toString('hex');
}

/**
 * Hashes a raw refresh token for database storage using SHA-256.
 *
 * This is a one-way operation. The raw token is never derivable from the hash.
 *
 * @param rawToken - The raw token from generateRefreshToken().
 * @returns 64-character lowercase hex SHA-256 hash.
 */
export function hashRefreshToken(rawToken: RawRefreshToken): HashedRefreshToken {
  return createHash('sha256').update(rawToken).digest('hex');
}
