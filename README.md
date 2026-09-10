# FIELDCORE

Offline-first field operations platform engineered for connectivity-constrained geoscience, mining, surveying, environmental, and industrial field environments.

---

## 1. Project Status (v1 Complete)

All six architectural stages (Milestones 1–4 / A–E) are fully implemented, verified with adversarial test suites against live PostgreSQL and simulated network conditions, and committed to `main`.

| Stage | Milestone | Focus Area | Status | Key Invariants Proven |
|---|---|---|---|---|
| **Stage 1** | Milestone 1 | Domain Modeling & State Machines | ✅ Complete | RFC 4122 UUIDv4 keys, whole-record versioning (`version`), Zod validation, fail-closed sync state machine transitions. |
| **Stage 2** | Milestone 2 | Client Offline Persistence & Repositories | ✅ Complete | Dexie IndexedDB persistence, atomic mutation pipelines, monotonic local sequence (`localSeq`), conflict-lock gating. |
| **Stage 3** | Milestone 3 | Push Sync Protocol & Server Transactions | ✅ Complete | Fastify HTTP sync API (`POST /sync/push`), per-operation Postgres transaction isolation (`FOR UPDATE`), fast-path idempotency cache, DB unique constraint (`23505`) race safety, jittered backoff, client crash recovery (`SYNCING` reset). |
| **Stage 4** | Milestone D | Monotonic Pull Replication Feed | ✅ Complete | Server change feed (`change_log` ordered strictly by `BIGSERIAL` sequence), atomic apply + cursor advance in single client transaction, version-compare idempotency, own-operation round-trip deduplication, multi-page drainage loop. |
| **Stage 5** | Milestone E | Deterministic Conflict Resolution | ✅ Complete | Client `ConflictResolutionService`, cascading conflict batch exclusion, read-only `EDIT_DELETE` (Delete strictly wins), invariant-preserving `KEEP_MINE` (fresh `operationId` + fresh `localSeq`, original op marked `REJECTED`, baseVersion advanced to live version). |
| **Stage 6** | Milestone 4 | Web Application, PWA & Field Hardware | ✅ Complete | Vite React SPA, PWA manifest (`display: "standalone"`), Service Worker with strict `/sync/*` and `/api/*` bypass, on-save GPS capture with soft degradation (5,000ms default timeout, `null` on denial/timeout/invalid coords), repository-wrapped live queries (`useLiveQuery`), Supervisor sync bar, interactive Conflict Drawer, live two-device convergence E2E test. |

---

## 2. Test Verification Evidence — 139 / 139 Passing Across 26 Suites

The entire monorepo test suite passes with 100% green exit code:

```bash
$ pnpm test

packages/types test:        2 passed  (2)
packages/database test:     7 passed  (7)
packages/validation test:  42 passed (42)
packages/sync test:        51 passed (51)
packages/server test:      24 passed (24)
apps/web test:             13 passed (13)

Total: 139 passed across 26 test files (0 failures)
```

### Key Adversarial Test Proofs:
1. **Two-Device Convergence E2E (`two-device-e2e.test.ts`)**:
   - Live HTTP integration test connecting Device A and Device B to the real Fastify sync server, real Postgres database, and Vite dev reverse proxy.
   - Proves Device A creates v1 → pushes → Device B pulls v1 → edits to v2 & pushes → Device A edits offline (baseVersion 1) → pushes → encounters 409 CONFLICT → resolves `KEEP_MINE` → re-queues under fresh `operationId` with `baseVersion: 2` → pushes to reach v3 → Device B pulls v3. Both devices assert `name === 'Device A Local Edit'` and `version === 3`.
2. **Permanent Idempotency Invariant (`push-handler.ts` & `conflict-resolution.ts`)**:
   - Proves `operationId` permanently identifies one specific mutation attempt.
   - Duplicate deliveries return cached response without side effects.
   - `KEEP_MINE` re-queues a fresh mutation under a newly minted `operationId` while the original stays `REJECTED` (terminal, for audit), avoiding cache collision or server purge workarounds.
3. **PWA & Network Isolation (`service-worker-bypass.test.ts`)**:
   - Statically and behaviorally proves that `sw.js` caches static shell assets while completely bypassing `/sync/*` and `/api/*` calls (never triggers `event.respondWith`).
4. **GPS Timing & Soft Degradation (`gps-capture.test.ts`)**:
   - Proves geolocation is never invoked on component mount or form open (spy count 0).
   - Captured strictly upon clicking Save (spy count 1).
   - On timeout (>2,000ms), permission denial, or coordinate schema validation failure (e.g. `latitude > 90`), safely resolves to `null` without throwing or blocking save. Production default timeout is 5,000ms.
5. **Architectural Guard (`architectural-guard.test.ts`)**:
   - Statically analyzes all UI components under `apps/web/src/components/`.
   - Asserts 0 violations of direct `FieldCoreDexie` imports or `db.*` queries, ensuring UI reads exclusively via repository-wrapped `useLiveQuery` hooks.

---

## 3. Monorepo Architecture

```
FieldCore/
├── apps/
│   └── web/                   # Vite + React 18 PWA (Supervisor Dashboard, Entity Explorer, Conflict Drawer)
├── packages/
│   ├── types/                 # Shared TypeScript domain models, sync interfaces, state machine transitions
│   ├── validation/            # Runtime Zod validation schemas (entities, GPS metadata, sync payloads)
│   ├── database/              # PostgreSQL Drizzle ORM schema, migrations, connection client
│   ├── sync/                  # Client sync engine (PushSyncService, PullSyncService, ConflictResolutionService, Repositories)
│   └── server/                # Fastify HTTP sync API (push-handler, pull-handler, device authentication, transaction isolation)
├── docker-compose.yml         # Local PostgreSQL 16 container for adversarial testing and development
└── vitest.config.ts           # Root test configuration (file parallelism disabled for database test isolation)
```

---

## 4. Architectural Principles & Invariants

- **Local-First & UI Isolation**: UI components interact exclusively through the repository layer and `useLiveQuery(() => repo.list())`. No component touches IndexedDB directly.
- **Client-Generated UUIDs**: All client-created records use RFC 4122 UUIDv4 keys, enabling disconnected field teams to establish full relational parent-child hierarchies (Project → Site → Inspection → Measurement) while completely offline.
- **Permanent Mutation Idempotency**: Every mutation has a unique `operationId` decoupled from `entityId`. Idempotency records in PostgreSQL are immutable; once recorded, an `operationId` identifies that exact mutation attempt permanently.
- **Atomic Apply + Monotonic Pull Cursor**: Pull replication streams ordered strictly by `BIGSERIAL` sequence. Domain updates and cursor checkpoints commit inside a single client IndexedDB transaction to eliminate crash windows.
- **Deterministic Conflict Resolution**:
  - `KEEP_SERVER`: Client record overwritten by authoritative server snapshot; linked operation transitions to terminal `REJECTED`.
  - `KEEP_MINE`: Client edit is preserved; original operation transitions to terminal `REJECTED` (for audit); a fresh `SyncOperation` is minted with a new `operationId`, auto-assigned `localSeq`, and `baseVersion` advanced to the live server version.
  - `EDIT_DELETE`: Delete strictly wins; non-user-resolvable, rendered as read-only cards in the Conflict Drawer.
- **Crash Recovery**: Startup routine sweeps dangling `SYNCING` operations back to `PENDING` with backoff reset, safely re-sending them relying on server idempotency.

---

## 5. Getting Started

### Prerequisites
- Node.js >= 20.0.0
- pnpm >= 9.0.0 (`corepack enable`)
- Docker & Docker Compose (for local PostgreSQL)

### Setup & Installation
```bash
# 1. Clone repository and install dependencies
git clone git@github.com:TomRiddle67/FieldCore.git
cd FieldCore
pnpm install

# 2. Start PostgreSQL container
docker compose up -d

# 3. Push schema to local PostgreSQL
pnpm --filter @fieldcore/database db:push
```

### Running Tests
```bash
# Run full monorepo test suite (139 tests across 6 workspace projects)
pnpm test

# Run specific package tests
pnpm --filter @fieldcore/sync test
pnpm --filter @fieldcore/server test
pnpm --filter @fieldcore/web test

# Run the live two-device convergence E2E integration test
pnpm --filter @fieldcore/web test src/__tests__/two-device-e2e.test.ts
```

### Running the Live Application
```bash
# Terminal 1: Start Fastify Sync Server (runs on http://127.0.0.1:3001)
npx tsx packages/server/src/bin.ts

# Terminal 2: Start Vite Dev Server (runs on http://localhost:3000)
pnpm --filter @fieldcore/web dev --port 3000
```

Open two browser tabs to simulate independent field workers:
- **Device A Profile**: `http://localhost:3000/?device=A`
- **Device B Profile**: `http://localhost:3000/?device=B`
