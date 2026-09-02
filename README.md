# FIELDCORE

Offline-first field operations platform for connectivity-constrained geoscience, mining, surveying, environmental, and industrial field environments.

## System Architecture Principles

- **Local-First / UI Independence**: UI interacts exclusively through the local persistence layer (IndexedDB via Dexie) and repository layer.
- **Client-Generated UUIDs**: All client-created entities use RFC 4122 UUIDv4 to support offline creation of relational hierarchies.
- **Operation-Level Idempotency**: Every mutation has a unique `operationId` decoupled from `entityId`.
- **Monotonic Server Sequence**: Pull synchronization uses an authoritative server sequence (`BIGSERIAL`) rather than timestamps.
- **Whole-Record Conflict Resolution**: Version-based optimistic concurrency (`version`) with deterministic conflict resolution (`KEEP_SERVER` | `KEEP_MINE`).
- **Tombstone Propagation**: Soft deletion markers (`isDeleted`, `isTombstone`) ensure deletes propagate reliably to offline peers without accidental resurrection.

## Packages

- `@fieldcore/types` - Shared TypeScript interfaces and domain enums.
- `@fieldcore/validation` - Runtime Zod schemas with UUID enforcement and validation rules.
- `@fieldcore/database` - Drizzle ORM schema for PostgreSQL, change logs, idempotency records, and database client.
- `@fieldcore/sync` - Synchronization engine, push/pull protocols, and conflict handlers.

## Getting Started

```bash
# Enable corepack and install dependencies
corepack enable
pnpm install

# Start local PostgreSQL database
docker compose up -d

# Run tests and type checks
pnpm test
pnpm typecheck
```
