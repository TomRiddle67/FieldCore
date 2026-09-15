/**
 * Password hashing and verification using Argon2id.
 *
 * Argon2id is memory-hard and substantially increases the cost of GPU/parallel password-cracking
 * attacks, while providing stronger side-channel resistance characteristics than Argon2d.
 *
 * Security decisions:
 * - Variant: argon2id (OWASP ASVS L2+ recommendation)
 * - Memory cost: 64 MiB (65536 KiB) — OWASP minimum for interactive logins
 * - Time cost: 3 iterations
 * - Parallelism: 2
 * - Salt: generated automatically per-hash by the argon2 library
 * - Hash output: stored as a PHC string ($argon2id$v=...$m=...,t=...,p=...$<salt>$<hash>)
 *
 * The hash is never returned through API responses.
 * The plaintext password is never stored or logged.
 */

import { hash, verify, argon2id } from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2id as 2,
  memoryCost: 65536,   // 64 MiB
  timeCost: 3,
  parallelism: 2,
} as const;

/**
 * Hashes a plaintext password using Argon2id.
 * The salt is generated automatically and embedded in the returned PHC string.
 *
 * @param plaintext - The user's plaintext password (never stored)
 * @returns PHC string suitable for database storage
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against a stored Argon2id hash.
 *
 * Timing-safe: argon2 verify uses a constant-time comparison internally.
 *
 * @param plaintext - The user's supplied password
 * @param storedHash - The PHC hash string from the database
 * @returns true if the password matches, false otherwise
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    // Malformed hash or other argon2 error — treat as verification failure
    return false;
  }
}
