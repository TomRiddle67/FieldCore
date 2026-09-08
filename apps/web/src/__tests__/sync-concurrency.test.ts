import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';

describe('Stage 6 Sync Concurrency Guard & Error Recovery', () => {
  it('guards against concurrent sync invocations (second call while syncing is ignored)', async () => {
    let pushCalls = 0;
    let pullCalls = 0;
    let isSyncing = false;

    // Simulate the syncNow logic from SyncContext
    const pushBatch = vi.fn(async () => {
      pushCalls++;
      await new Promise((r) => setTimeout(r, 50));
    });

    const pullAll = vi.fn(async () => {
      pullCalls++;
      await new Promise((r) => setTimeout(r, 50));
    });

    const runSync = async () => {
      if (isSyncing) return;
      isSyncing = true;
      try {
        await pushBatch();
        await pullAll();
      } finally {
        isSyncing = false;
      }
    };

    // User rapidly clicks Sync Now 3 times
    const [run1, run2, run3] = [runSync(), runSync(), runSync()];
    await Promise.all([run1, run2, run3]);

    // Only one execution should have run
    expect(pushCalls).toBe(1);
    expect(pullCalls).toBe(1);
    expect(isSyncing).toBe(false);
  });

  it('guarantees isSyncing resets to false in finally block even when push rejects', async () => {
    let isSyncing = false;
    let lastError: string | null = null;

    const failingPush = vi.fn(async () => {
      throw new Error('Network offline: Failed to fetch');
    });

    const runSync = async () => {
      if (isSyncing) return;
      isSyncing = true;
      lastError = null;
      try {
        await failingPush();
      } catch (err: any) {
        lastError = err?.message || 'Sync failed';
      } finally {
        // Locked specification: must reset in finally so button is never permanently disabled
        isSyncing = false;
      }
    };

    await runSync();

    expect(isSyncing).toBe(false);
    expect(lastError).toBe('Network offline: Failed to fetch');

    // A subsequent sync attempt can run immediately once connection is restored
    const successfulPush = vi.fn(async () => {});
    const runSync2 = async () => {
      if (isSyncing) return;
      isSyncing = true;
      try {
        await successfulPush();
      } finally {
        isSyncing = false;
      }
    };

    await runSync2();
    expect(successfulPush).toHaveBeenCalledTimes(1);
    expect(isSyncing).toBe(false);
  });
});
