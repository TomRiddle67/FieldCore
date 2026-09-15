/**
 * Unit tests for auth utility modules.
 *
 * These tests do NOT require a database or running server.
 * They cover: password hashing, JWT sign/verify, refresh token generation,
 * and the auth config loader.
 */

import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signAccessToken, verifyAccessToken } from '../auth/jwt.js';
import { generateRefreshToken, hashRefreshToken } from '../auth/token.js';
import { loadAuthConfig } from '../auth/config.js';
import type { AccessTokenClaims } from '../auth/jwt.js';

// ─────────────────────────────────────────────────────────
// loadAuthConfig
// ─────────────────────────────────────────────────────────

describe('loadAuthConfig', () => {
  it('loads valid config from env', () => {
    const env = { JWT_SECRET: 'a'.repeat(32) };
    const config = loadAuthConfig(env);
    expect(config.jwtSecret).toBe('a'.repeat(32));
    expect(config.jwtAlgorithm).toBe('HS256');
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.refreshTokenTtlDays).toBe(30);
  });

  it('throws if JWT_SECRET is missing', () => {
    expect(() => loadAuthConfig({})).toThrow('JWT_SECRET');
  });

  it('throws if JWT_SECRET is shorter than 32 chars', () => {
    expect(() => loadAuthConfig({ JWT_SECRET: 'short' })).toThrow('too short');
  });

  it('applies custom TTL overrides', () => {
    const env = {
      JWT_SECRET: 'a'.repeat(32),
      ACCESS_TOKEN_TTL_SECONDS: '300',
      REFRESH_TOKEN_TTL_DAYS: '7',
    };
    const config = loadAuthConfig(env);
    expect(config.accessTokenTtlSeconds).toBe(300);
    expect(config.refreshTokenTtlDays).toBe(7);
  });

  it('throws if ACCESS_TOKEN_TTL_SECONDS is below minimum', () => {
    const env = { JWT_SECRET: 'a'.repeat(32), ACCESS_TOKEN_TTL_SECONDS: '30' };
    expect(() => loadAuthConfig(env)).toThrow('ACCESS_TOKEN_TTL_SECONDS');
  });
});

// ─────────────────────────────────────────────────────────
// Password hashing
// ─────────────────────────────────────────────────────────

describe('hashPassword / verifyPassword', () => {
  it('produces a PHC string', async () => {
    const hash = await hashPassword('test-password');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifies correct password', async () => {
    const hash = await hashPassword('correct-password');
    expect(await verifyPassword('correct-password', hash)).toBe(true);
  });

  it('rejects incorrect password', async () => {
    const hash = await hashPassword('correct-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('returns false for malformed hash', async () => {
    expect(await verifyPassword('any-password', 'not-a-valid-hash')).toBe(false);
  });

  it('produces different hashes for same password (unique salts)', async () => {
    const h1 = await hashPassword('same-password');
    const h2 = await hashPassword('same-password');
    expect(h1).not.toBe(h2);
  });
}, 30000); // argon2 is intentionally slow

// ─────────────────────────────────────────────────────────
// JWT sign / verify
// ─────────────────────────────────────────────────────────

describe('signAccessToken / verifyAccessToken', () => {
  const config = loadAuthConfig({
    JWT_SECRET: 'test-jwt-secret-that-is-long-enough-for-hs256',
  });

  const claims: AccessTokenClaims = {
    sub: '11111111-1111-4111-8111-111111111111',
    deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    sid: 'session-id-1234',
  };

  it('signs and verifies a token with expected claims', async () => {
    const token = await signAccessToken(claims, config);
    const verified = await verifyAccessToken(token, config);
    expect(verified.sub).toBe(claims.sub);
    expect(verified.deviceId).toBe(claims.deviceId);
    expect(verified.sid).toBe(claims.sid);
    expect(typeof verified.iat).toBe('number');
    expect(typeof verified.exp).toBe('number');
    expect(verified.exp).toBeGreaterThan(verified.iat);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken(claims, config);
    const otherConfig = loadAuthConfig({ JWT_SECRET: 'b'.repeat(46) });
    await expect(verifyAccessToken(token, otherConfig)).rejects.toThrow();
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken(claims, config);
    const [h, p, s] = token.split('.');
    const tampered = `${h}.${p}x.${s}`;
    await expect(verifyAccessToken(tampered, config)).rejects.toThrow();
  });

  it('sets expiration within expected range', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(claims, config);
    const { exp, iat } = await verifyAccessToken(token, config);
    const after = Math.floor(Date.now() / 1000);
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(iat).toBeLessThanOrEqual(after + 1);
    expect(exp - iat).toBe(config.accessTokenTtlSeconds);
  });

  it('rejects token declaring alg:none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: claims.sub,
        deviceId: claims.deviceId,
        sid: claims.sid,
        exp: Math.floor(Date.now() / 1000) + 900,
      })
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    await expect(verifyAccessToken(noneToken, config)).rejects.toThrow();
  });

  it('rejects token declaring unexpected/wrong algorithm (e.g. HS384)', async () => {
    const secret = new TextEncoder().encode(config.jwtSecret);
    const token = await new SignJWT({
      sub: claims.sub,
      deviceId: claims.deviceId,
      sid: claims.sid,
    })
      .setProtectedHeader({ alg: 'HS384' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);

    await expect(verifyAccessToken(token, config)).rejects.toThrow();
  });

  it('rejects expired JWT access token', async () => {
    const secret = new TextEncoder().encode(config.jwtSecret);
    const expiredToken = await new SignJWT({
      sub: claims.sub,
      deviceId: claims.deviceId,
      sid: claims.sid,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secret);

    await expect(verifyAccessToken(expiredToken, config)).rejects.toThrow();
  });

  it('rejects token missing required claims (sub, deviceId, sid)', async () => {
    const secret = new TextEncoder().encode(config.jwtSecret);

    // Missing deviceId
    const missingDeviceToken = await new SignJWT({
      sub: claims.sub,
      sid: claims.sid,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    await expect(verifyAccessToken(missingDeviceToken, config)).rejects.toThrow(
      'JWT missing required claim: deviceId'
    );

    // Missing sub
    const missingSubToken = await new SignJWT({
      deviceId: claims.deviceId,
      sid: claims.sid,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    await expect(verifyAccessToken(missingSubToken, config)).rejects.toThrow(
      'JWT missing required claim: sub'
    );

    // Missing sid
    const missingSidToken = await new SignJWT({
      sub: claims.sub,
      deviceId: claims.deviceId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    await expect(verifyAccessToken(missingSidToken, config)).rejects.toThrow(
      'JWT missing required claim: sid'
    );
  });
});

// ─────────────────────────────────────────────────────────
// Refresh token generation
// ─────────────────────────────────────────────────────────

describe('generateRefreshToken / hashRefreshToken', () => {
  it('generates a 96-character hex string', () => {
    const token = generateRefreshToken();
    expect(token).toHaveLength(96);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('generates unique tokens on every call', () => {
    const t1 = generateRefreshToken();
    const t2 = generateRefreshToken();
    expect(t1).not.toBe(t2);
  });

  it('hashes to a 64-character SHA-256 hex string', () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic — same input produces same hash', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('different tokens produce different hashes', () => {
    const t1 = generateRefreshToken();
    const t2 = generateRefreshToken();
    expect(hashRefreshToken(t1)).not.toBe(hashRefreshToken(t2));
  });
});
