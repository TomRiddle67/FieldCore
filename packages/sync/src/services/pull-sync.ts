import type { FieldCoreDexie } from '../db/database.js';
import type {
  PullRequest,
  PullResponse,
  ServerChangeLog,
  EntityType,
} from '@fieldcore/types';

/**
 * Transport adapter function signature for pull sync.
 * Zero HTTP dependencies in @fieldcore/sync.
 */
export type PullTransport = (request: PullRequest) => Promise<PullResponse>;

export interface PullBatchOptions {
  scope?: string; // default "default" (only valid value in v1)
  limit?: number; // default 100, max 500
  deviceId?: string;
  now?: () => string; // Clock provider for deterministic testing
}

export interface PullBatchResult {
  changesApplied: number;
  latestSequence: string; // bigint-safe string
  hasMore: boolean;
  cursorExpired?: boolean; // when true, client must surface for revalidation
  error?: string;
}

export interface PullAllResult {
  totalApplied: number;
  latestSequence: string;
  pagesPulled: number;
  cursorExpired?: boolean;
  error?: string;
}

/**
 * Client Pull Synchronization Service.
 * Manages incremental log replication, atomic Dexie transaction commit (apply + cursor advance),
 * version-gated idempotent application, and hasMore pagination.
 */
export class PullSyncService {
  constructor(private readonly db: FieldCoreDexie) {}

  /**
   * Reads the current local cursor for a given scope (defaults to "default").
   * Returns "0" if no cursor exists yet.
   */
  async getLocalCursor(scope = 'default'): Promise<string> {
    const record = await this.db.pull_cursors.get(scope);
    return record ? String(record.lastServerSequence) : '0';
  }

  /**
   * Returns the corresponding Dexie domain table for an EntityType.
   */
  private getTable(entityType: EntityType) {
    switch (entityType) {
      case 'PROJECT':
        return this.db.projects;
      case 'SITE':
        return this.db.sites;
      case 'INSPECTION':
        return this.db.inspections;
      case 'MEASUREMENT':
        return this.db.measurements;
      default:
        throw new Error(`Unsupported entityType for pull sync: ${entityType}`);
    }
  }

  /**
   * Pulls one page of changes from the transport, validates, and applies them
   * atomically along with the cursor update inside a single Dexie transaction.
   */
  async pullBatch(
    transport: PullTransport,
    options: PullBatchOptions = {}
  ): Promise<PullBatchResult> {
    const scope = options.scope ?? 'default';
    const limit = options.limit ?? 100;
    const nowIso = options.now ? options.now() : new Date().toISOString();

    const currentCursor = await this.getLocalCursor(scope);

    const pullReq: PullRequest = {
      deviceId: options.deviceId ?? '00000000-0000-0000-0000-000000000000',
      afterSequence: currentCursor,
      limit,
    };

    let response: PullResponse;
    try {
      response = await transport(pullReq);
    } catch (transportError: any) {
      return {
        changesApplied: 0,
        latestSequence: currentCursor,
        hasMore: false,
        error: transportError?.message ?? 'Transport error',
      };
    }

    // If the server signals cursor expiration (e.g. offline window expired),
    // surface to caller for revalidation; do NOT advance cursor or crash.
    if (response.cursorExpired) {
      return {
        changesApplied: 0,
        latestSequence: currentCursor,
        hasMore: false,
        cursorExpired: true,
      };
    }

    let appliedCount = 0;

    // Atomic transaction: All domain upserts + cursor advance commit together.
    // If anything throws or aborts, no domain changes and no cursor changes persist.
    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.sites,
        this.db.inspections,
        this.db.measurements,
        this.db.pull_cursors,
      ],
      async () => {
        for (const change of response.changes) {
          const table = this.getTable(change.entityType);
          const existing: any = await table.get(change.entityId);

          // Version check:
          // If local record's version >= incoming.version, skip!
          // This correctly handles:
          // 1. Idempotent re-delivery of already applied sequence.
          // 2. Local-version-ahead scenario: unsynced local edit at N+1, pull delivers N -> skip pull, leave local edit intact.
          if (existing && existing.version >= change.version) {
            continue;
          }

          if (change.isTombstone) {
            const tombstoneRecord = {
              ...(existing ?? {}),
              ...change.payload,
              id: change.entityId,
              version: change.version,
              isDeleted: true,
              deletedAt: (change.payload as any)?.deletedAt ?? change.createdAt,
              createdAt: existing?.createdAt ?? change.createdAt,
              updatedAt: change.createdAt,
            };
            await table.put(tombstoneRecord);
            appliedCount++;
          } else {
            const updatedRecord = {
              ...(existing ?? {}),
              ...change.payload,
              id: change.entityId,
              version: change.version,
              isDeleted: false,
              deletedAt: null,
              createdAt: existing?.createdAt ?? change.createdAt,
              updatedAt: change.createdAt,
            };
            await table.put(updatedRecord);
            appliedCount++;
          }
        }

        // Advance client pull cursor inside the same atomic transaction
        await this.db.pull_cursors.put({
          scope,
          lastServerSequence: String(response.latestSequence),
          updatedAt: nowIso,
        });
      }
    );

    return {
      changesApplied: appliedCount,
      latestSequence: String(response.latestSequence),
      hasMore: response.hasMore,
      cursorExpired: false,
    };
  }

  /**
   * Loops pullBatch while hasMore is true, advancing the cursor per-page.
   * Halts on error, cursorExpired, or when hasMore is false.
   */
  async pullAll(
    transport: PullTransport,
    options: PullBatchOptions = {}
  ): Promise<PullAllResult> {
    let totalApplied = 0;
    let pagesPulled = 0;
    let currentLatest = await this.getLocalCursor(options.scope);

    while (true) {
      const batchResult = await this.pullBatch(transport, options);

      if (batchResult.error) {
        return {
          totalApplied,
          latestSequence: currentLatest,
          pagesPulled,
          error: batchResult.error,
        };
      }

      if (batchResult.cursorExpired) {
        return {
          totalApplied,
          latestSequence: currentLatest,
          pagesPulled,
          cursorExpired: true,
        };
      }

      totalApplied += batchResult.changesApplied;
      currentLatest = batchResult.latestSequence;
      pagesPulled++;

      if (!batchResult.hasMore) {
        break;
      }
    }

    return {
      totalApplied,
      latestSequence: currentLatest,
      pagesPulled,
    };
  }
}
