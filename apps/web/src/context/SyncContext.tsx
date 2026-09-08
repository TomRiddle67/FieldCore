import React, { createContext, useContext, useMemo, useState, useCallback, useEffect } from 'react';
import {
  FieldCoreDexie,
  ProjectRepository,
  SiteRepository,
  InspectionRepository,
  MeasurementRepository,
  SyncStatusService,
  ConflictResolutionService,
  PushSyncService,
  PullSyncService,
  type RepositoryContext,
  type PushTransport,
  type PullTransport,
} from '@fieldcore/sync';

export interface SyncContextValue {
  db: FieldCoreDexie;
  projectRepo: ProjectRepository;
  siteRepo: SiteRepository;
  inspectionRepo: InspectionRepository;
  measurementRepo: MeasurementRepository;
  syncStatusService: SyncStatusService;
  conflictResolutionService: ConflictResolutionService;
  pushSyncService: PushSyncService;
  pullSyncService: PullSyncService;
  context: RepositoryContext;
  isSyncing: boolean;
  lastSyncError: string | null;
  syncNow: () => Promise<void>;
  deviceProfile: string;
}

const SyncContext = createContext<SyncContextValue | null>(null);

function getOrCreateStorageId(key: string, defaultVal: string): string {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return stored;
    localStorage.setItem(key, defaultVal);
    return defaultVal;
  } catch {
    return defaultVal;
  }
}

export function SyncProvider({
  children,
  forcedDb,
  forcedContext,
}: {
  children: React.ReactNode;
  forcedDb?: FieldCoreDexie;
  forcedContext?: RepositoryContext;
}) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  const deviceProfile = useMemo(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('device') || 'default';
    }
    return 'default';
  }, []);

  const repoContext = useMemo<RepositoryContext>(() => {
    if (forcedContext) return forcedContext;
    if (deviceProfile === 'A') {
      return {
        userId: '11111111-1111-4111-8111-111111111111',
        deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        clientId: 'client-a-id',
      };
    }
    if (deviceProfile === 'B') {
      return {
        userId: '11111111-1111-4111-8111-111111111111',
        deviceId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        clientId: 'client-b-id',
      };
    }
    return {
      userId: '11111111-1111-4111-8111-111111111111',
      deviceId: '00000000-0000-0000-0000-000000000000',
      clientId: 'client-default-id',
    };
  }, [forcedContext, deviceProfile]);

  const services = useMemo(() => {
    const db = forcedDb || new FieldCoreDexie(`fieldcore_${deviceProfile}_db`);
    const projectRepo = new ProjectRepository(db, repoContext);
    const siteRepo = new SiteRepository(db, repoContext);
    const inspectionRepo = new InspectionRepository(db, repoContext);
    const measurementRepo = new MeasurementRepository(db, repoContext);
    const syncStatusService = new SyncStatusService(db);
    const conflictResolutionService = new ConflictResolutionService(db);
    const pushSyncService = new PushSyncService(db);
    const pullSyncService = new PullSyncService(db);

    return {
      db,
      projectRepo,
      siteRepo,
      inspectionRepo,
      measurementRepo,
      syncStatusService,
      conflictResolutionService,
      pushSyncService,
      pullSyncService,
    };
  }, [forcedDb, deviceProfile, repoContext]);

  // Transports communicating with the backend API
  const pushTransport = useCallback<PushTransport>(async (batch) => {
    const res = await fetch('/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Push failed with status ${res.status}: ${text}`);
    }
    return res.json();
  }, []);

  const pullTransport = useCallback<PullTransport>(async (req) => {
    const params = new URLSearchParams({
      deviceId: req.deviceId,
      afterSequence: String(req.afterSequence ?? 0),
      limit: String(req.limit),
    });
    const res = await fetch(`/sync/pull?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pull failed with status ${res.status}: ${text}`);
    }
    return res.json();
  }, []);

  // Sync execution runner with concurrency guard and try-finally error handling
  const syncNow = useCallback(async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setLastSyncError(null);

    try {
      // 1. Push local pending mutations
      await services.pushSyncService.pushBatch(pushTransport);
      // 2. Pull remote changes down to local Dexie
      await services.pullSyncService.pullAll(pullTransport, {
        deviceId: repoContext.deviceId,
      });
    } catch (err: any) {
      const msg = err?.message || 'Sync failed';
      setLastSyncError(msg);
      console.warn('FieldCore sync error:', err);
    } finally {
      // Guaranteed reset so the Sync Now button is never stuck disabled
      setIsSyncing(false);
    }
  }, [isSyncing, services, pushTransport, pullTransport, repoContext.deviceId]);

  // Cleanup DB on unmount if custom
  useEffect(() => {
    return () => {
      // noop
    };
  }, []);

  const value = useMemo<SyncContextValue>(
    () => ({
      ...services,
      context: repoContext,
      isSyncing,
      lastSyncError,
      syncNow,
      deviceProfile,
    }),
    [services, repoContext, isSyncing, lastSyncError, syncNow, deviceProfile]
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSyncContext(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new Error('useSyncContext must be used within a SyncProvider');
  }
  return ctx;
}
