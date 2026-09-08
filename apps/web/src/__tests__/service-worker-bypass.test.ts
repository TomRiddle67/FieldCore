import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Stage 6 Service Worker — Strict /sync/* Bypass Invariant', () => {
  const swCode = fs.readFileSync(
    path.resolve(__dirname, '../../public/sw.js'),
    'utf-8'
  );

  it('proves sw.js statically contains the strict /sync/ and /api/ bypass condition', () => {
    // Assert the exact routing exclusion is present in the SW source
    expect(swCode).toContain("url.pathname.startsWith('/sync/')");
    expect(swCode).toContain("url.pathname.startsWith('/api/')");
    expect(swCode).toContain('return; // Bypass Service Worker completely');
  });

  it('proves that fetch events for /sync/pull and /sync/push NEVER trigger event.respondWith', () => {
    // Mock the Service Worker environment
    const eventListeners: Record<string, Function> = {};
    const mockSelf = {
      addEventListener: (event: string, handler: Function) => {
        eventListeners[event] = handler;
      },
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    };

    // Evaluate sw.js in mock sandbox
    const mockCaches = {
      open: vi.fn().mockResolvedValue({ put: vi.fn(), addAll: vi.fn() }),
      match: vi.fn().mockResolvedValue(null),
      keys: vi.fn().mockResolvedValue([]),
    };
    const runSw = new Function('self', 'caches', swCode);
    runSw(mockSelf, mockCaches);

    expect(eventListeners['fetch']).toBeDefined();
    const fetchHandler = eventListeners['fetch'];

    // 1. Test /sync/pull request
    const mockPullRespondWith = vi.fn();
    const pullEvent = {
      request: {
        url: 'http://localhost:3000/sync/pull?deviceId=d1&afterSequence=0&limit=100',
        method: 'GET',
      },
      respondWith: mockPullRespondWith,
    };
    fetchHandler(pullEvent);
    // Crucial invariant: respondWith must NOT be called for /sync/pull
    expect(mockPullRespondWith).not.toHaveBeenCalled();

    // 2. Test /sync/push request
    const mockPushRespondWith = vi.fn();
    const pushEvent = {
      request: {
        url: 'http://localhost:3000/sync/push',
        method: 'POST',
      },
      respondWith: mockPushRespondWith,
    };
    fetchHandler(pushEvent);
    // Crucial invariant: respondWith must NOT be called for /sync/push
    expect(mockPushRespondWith).not.toHaveBeenCalled();

    // 3. Test static asset request (e.g. /manifest.webmanifest)
    const mockStaticRespondWith = vi.fn();
    const staticEvent = {
      request: {
        url: 'http://localhost:3000/manifest.webmanifest',
        method: 'GET',
      },
      respondWith: mockStaticRespondWith,
    };
    fetchHandler(staticEvent);
    // Static asset MUST be intercepted by respondWith
    expect(mockStaticRespondWith).toHaveBeenCalledTimes(1);
  });
});
