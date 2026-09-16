# FIELDCORE

Offline-first field operations platform engineered for connectivity-constrained geoscience, mining, surveying, environmental, and industrial field environments.

---

## About FieldCore

FieldCore is a resilient, local-first web and PWA architecture designed for field teams operating in remote or underground environments with intermittent, high-latency, or nonexistent network connectivity.

Unlike conventional cloud-centric applications that treat offline usage as an exception or edge-case fallback, FieldCore treats the local client device as the primary system of record for active work. Field technicians create, update, and organize multi-tiered relational hierarchies (Projects, Sites, Inspections, and Measurements) with zero network dependency. When network access is available, FieldCore synchronizes changes bi-directionally with the central PostgreSQL datastore using monotonic sequence tracking, crash-resilient isolated transactions, and deterministic whole-record conflict resolution.

---

## 1. Project Status

### Sync & Application Infrastructure — Complete

All six architectural stages (Milestones 1–4 / A–E) are fully implemented, verified with adversarial test suites against live PostgreSQL and simulated network conditions, and committed to `main`.

| Stage | Milestone | Focus Area | Status | Key Invariants Proven |
|---|---|---|---|---|
| **Stage 1** | Milestone 1 | Domain Modeling & State Machines | ✅ Complete | RFC 4122 UUIDv4 keys, whole-record versioning (`version`), Zod validation, fail-closed sync state machine transitions. |
| **Stage 2** | Milestone 2 | Client Offline Persistence & Repositories | ✅ Complete | Dexie IndexedDB persistence, atomic mutation pipelines, monotonic local sequence (`localSeq`), conflict-lock gating. |
| **Stage 3** | Milestone 3 | Push Sync Protocol & Server Transactions | ✅ Complete | Fastify HTTP sync API (`POST /sync/push`), per-operation Postgres transaction isolation (`FOR UPDATE`), fast-path idempotency cache, DB unique constraint (`23505`) race safety, jittered backoff, client crash recovery (`SYNCING` reset). |
| **Stage 4** | Milestone D | Monotonic Pull Replication Feed | ✅ Complete | Server change feed (`change_log` ordered strictly by `BIGSERIAL` sequence), atomic apply + cursor advance in single client transaction, version-compare idempotency, own-operation round-trip deduplication, multi-page drainage loop. |
| **Stage 5** | Milestone E | Deterministic Conflict Resolution | ✅ Complete | Client `ConflictResolutionService`, cascading conflict batch exclusion, read-only `EDIT_DELETE` (Delete strictly wins), invariant-preserving `KEEP_MINE` (fresh `operationId` + fresh `localSeq`, original op marked `REJECTED`, baseVersion advanced to live version). |
| **Stage 6** | Milestone 4 | Web Application, PWA & Field Hardware | ✅ Complete | Vite React SPA, PWA manifest (`display: "standalone"`), Service Worker with strict `/sync/*` and `/api/*` bypass, on-save GPS capture with soft degradation (5,000ms default timeout, `null` on denial/timeout/invalid coords), repository-wrapped live queries (`useLiveQuery`), Supervisor sync bar, interactive Conflict Drawer, live two-device convergence E2E test. |

### Authentication Infrastructure — Phase 1 Complete (PR #26, merged 2026-09-15)

JWT authentication, Argon2id password hashing, device identity, session management, and refresh tokens are implemented and merged into `main`. See [Section 6](#6-authentication-infrastructure--phase-1) for full detail.

> **Current Phase 1 state:** Sync routes (`POST /sync/push`, `GET /sync/pull`) are not yet gated by authentication. This is the current implementation state — not the intended final security architecture. Auth enforcement on sync routes is planned for Phase 2.

---

## 2. Test Verification Evidence

### Post-merge (main) baseline — 2026-09-15

```bash
$ pnpm --filter @fieldcore/server exec vitest run

 Test Files  6 passed (6)
      Tests  68 passed (68)
   Start at  09:28:47
   Duration  21.08s

stdout | [teardown-verification] remainingUsers count: 0
```

**Server test file breakdown (68 tests):**

| File | Tests |
|---|---|
| `auth-routes.test.ts` | 21 |
| `auth.test.ts` | 23 |
| `push.test.ts` | 9 |
| `adversarial-pull.test.ts` | 5 |
| `adversarial-push.test.ts` | 4 |
| `pull.test.ts` | 6 |

### Full workspace test suite

```bash
$ pnpm test

packages/types test:        2 passed  (2)
packages/database test:     7 passed  (7)
packages/validation test:  42 passed (42)
packages/sync test:        51 passed (51)
packages/server test:      68 passed (68)
apps/web test:             13 passed (13)

Total: 183 passed across 28 test files (0 failures)
```

### Key Adversarial Test Proofs

1. **Two-Device Convergence E2E (`two-device-e2e.test.ts`)**:
   Live HTTP integration test connecting Device A and Device B to the real Fastify sync server, real Postgres database, and Vite dev reverse proxy.
   Proves Device A creates v1 → pushes → Device B pulls v1 → edits to v2 & pushes → Device A edits offline (baseVersion 1) → pushes → encounters 409 CONFLICT → resolves `KEEP_MINE` → re-queues under fresh `operationId` with `baseVersion: 2` → pushes to reach v3 → Device B pulls v3. Both devices assert `name === 'Device A Local Edit'` and `version === 3`.

2. **Permanent Idempotency Invariant (`push-handler.ts` & `conflict-resolution.ts`)**:
   Proves `operationId` permanently identifies one specific mutation attempt.
   Duplicate deliveries return cached response without side effects.
   `KEEP_MINE` re-queues a fresh mutation under a newly minted `operationId` while the original stays `REJECTED` (terminal, for audit), avoiding cache collision or server purge workarounds.

3. **PWA & Network Isolation (`service-worker-bypass.test.ts`)**:
   Statically and behaviorally proves that `sw.js` caches static shell assets while completely bypassing `/sync/*` and `/api/*` calls (never triggers `event.respondWith`).

4. **GPS Timing & Soft Degradation (`gps-capture.test.ts`)**:
   Proves geolocation is never invoked on component mount or form open.
   On timeout (> 2,000ms), permission denial, or coordinate schema validation failure, safely resolves to `null` without throwing or blocking save.

5. **Architectural Guard (`architectural-guard.test.ts`)**:
   Statically analyzes all UI components under `apps/web/src/components/`.
   Asserts 0 violations of direct `FieldCoreDexie` imports or `db.*` queries, ensuring UI reads exclusively via repository-wrapped `useLiveQuery` hooks.

6. **Auth Adversarial Suite (`auth-routes.test.ts`, `auth.test.ts`)**:
   44 integration and unit tests covering JWT algorithm pinning (`alg:none` rejection, HS384 rejection), Argon2id correctness, cross-user device hijacking prevention, first-device bootstrap, transactional rollback, concurrent first-device logins, expired/revoked session/token rejection, and teardown isolation (`remainingUsers count: 0`).

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
│   └── server/                # Fastify HTTP API (push-handler, pull-handler, auth/* routes)
├── .env.example               # Environment variable reference — copy to .env before running
├── docker-compose.yml         # Local PostgreSQL 16 container for development and testing
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

# 2. Configure environment
cp .env.example .env
# Set JWT_SECRET in .env to a secure 32+ character string:
# JWT_SECRET=$(openssl rand -hex 32)

# 3. Start PostgreSQL container
docker compose up -d

# 4. Apply schema migrations to local PostgreSQL
pnpm --filter @fieldcore/database db:migrate
```

### Environment Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | No | `postgres://fieldcore:fieldcore_dev_password@localhost:5432/fieldcore` | PostgreSQL connection string |
| `PORT` | No | `3001` | Fastify server port |
| `JWT_SECRET` | **Yes** | *(none — server fails closed if missing or < 32 chars)* | HS256 signing secret for JWT access tokens. Must be >= 32 characters. Generate with `openssl rand -hex 32`. |
| `ACCESS_TOKEN_TTL_SECONDS` | No | `900` (15 min) | Access token expiration in seconds. Minimum: 60. |
| `REFRESH_TOKEN_TTL_DAYS` | No | `30` | Refresh token lifetime in days. Minimum: 1. |

### Running Tests
```bash
# Run full monorepo test suite (183 tests across 28 test files)
pnpm test

# Run specific package tests
pnpm --filter @fieldcore/sync test
pnpm --filter @fieldcore/server test
pnpm --filter @fieldcore/web test

# Run the live two-device convergence E2E integration test
pnpm --filter @fieldcore/web test src/__tests__/two-device-e2e.test.ts

# Run auth-specific tests
pnpm --filter @fieldcore/server exec vitest run src/__tests__/auth-routes.test.ts src/__tests__/auth.test.ts
```

### Running the Live Application
```bash
# Terminal 1: Start Fastify Sync Server (runs on http://127.0.0.1:3001)
npx tsx packages/server/src/bin.ts

# Terminal 2: Start Vite Dev Server (runs on http://localhost:3000)
pnpm --filter @fieldcore/web dev --port 3000
```

> **Development only.** The dev seed creates a default user on first startup. Do not use these credentials in any environment other than a local development database.
> - **Email**: `engineer@fieldcore.io`
> - **Password**: `fieldcore-dev-password`
> - **Pre-seeded devices**: Default Device (`0000...0000`), Field Device A (`aaaa...aaaa`), Field Device B (`bbbb...bbbb`)

Open two browser tabs to simulate independent field workers:
- **Device A Profile**: `http://localhost:3000/?device=A`
- **Device B Profile**: `http://localhost:3000/?device=B`

---

## 6. Authentication Infrastructure — Phase 1

Merged in PR #26. All auth code lives in `packages/server/src/auth/`.

### API Routes

| Method | Route | Auth Required | Description |
|---|---|---|---|
| `POST` | `/auth/login` | No | Authenticate with email + password + optional `deviceId`. |
| `POST` | `/auth/refresh` | No (uses refresh token) | Exchange a valid refresh token for a new access token. |
| `POST` | `/auth/logout` | Bearer token | Revoke the current session. |
| `POST` | `/auth/devices/register` | Bearer token | Register an additional device for the authenticated user. |

### JWT Access Tokens

- **Algorithm**: HS256, explicitly pinned in both signing and verification. The algorithm is not runtime-configurable.
- **Lifetime**: 15 minutes by default (`ACCESS_TOKEN_TTL_SECONDS`).
- **Claims**: `sub` (user ID), `deviceId`, `sid` (session ID), `iat`, `exp`.
- **Verification rejects**: wrong signing key, tampered payload, expired token, `alg:none`, any non-HS256 algorithm, missing `sub`/`deviceId`/`sid`.
- **Library**: [`jose`](https://github.com/panva/jose).

### Refresh Tokens

- **Format**: Opaque 48-byte cryptographically random value (96 hex chars; 384 bits of entropy).
- **Storage**: Only the SHA-256 hash is stored in the database. The raw token is returned to the client exactly once and is never stored server-side.
- **Lifetime**: 30 days by default (`REFRESH_TOKEN_TTL_DAYS`).
- **Revocation**: Refresh tokens are revoked implicitly when their session is revoked (e.g. via `/auth/logout`).
- **⚠️ Not yet implemented**: Token rotation and reuse detection are deferred to Phase 2. A given refresh token may be used multiple times within its TTL.

### Password Hashing

- **Algorithm**: Argon2id via the native [`argon2`](https://github.com/ranisalt/node-argon2) package.
- **Parameters**: 64 MiB memory cost, 3 iterations, parallelism 2, auto-generated salt per hash.
- **Storage**: PHC string format (`$argon2id$v=...$m=...,t=...,p=...$<salt>$<hash>`). The plaintext password is never stored or logged.
- Argon2id is memory-hard and substantially increases the cost of GPU/parallel password-cracking attacks, while providing stronger side-channel resistance characteristics than Argon2d.

### Device Identity & Session Model

The core identity invariant enforced at every authenticated boundary:

```
JWT.sub == session.userId == device.userId
JWT.deviceId == session.deviceId == device.id
```

Identity is always derived from the verified authentication context, never from client-supplied request fields.

#### First-Device Bootstrap (Login Path)

`POST /auth/login` supports two paths:

1. **Existing-device login** (`email + password + deviceId`): Verifies device ownership (`device.userId == authenticated user.id`) and revocation status. Creates session and refresh token atomically.

2. **First-device auto-provisioning** (`email + password`, `deviceId` omitted): Only available when the authenticated user has **zero** registered devices. The server generates the device UUID, and creates the device, session, and refresh token in one atomic database transaction. Returns the server-generated `deviceId` to the client.

   If the user already has registered devices and `deviceId` is omitted: `400 DEVICE_ID_REQUIRED`.

   If a client supplies an unknown or unowned `deviceId`: `400 DEVICE_NOT_FOUND`. An unknown `deviceId` is never interpreted as a new device to auto-create.

#### Authenticated Device Registration

`POST /auth/devices/register` (requires Bearer token):
- User identity is derived strictly from `request.auth.sub` (the verified token principal).
- Any `userId`, `id`, or `deviceId` in the request body is ignored.
- The server generates the authoritative device UUID.
- Returns new device, session, access token, and refresh token.

#### Session Handling

- Sessions are created on login and device registration.
- Sessions are identified by `sid` in the JWT.
- Logout (`POST /auth/logout`) marks the session as revoked. Subsequent refresh attempts against the revoked session are rejected with `SESSION_EXPIRED`.

#### Device Revocation

- The `requireAuth` middleware performs a live database check on every authenticated request.
- If `device.isRevoked == true`: `403 DEVICE_REVOKED`, even if the JWT is otherwise cryptographically valid.

#### Logout Semantics

- Logout revokes the session record identified by the `sid` JWT claim.
- Refresh tokens for the session become invalid immediately (session check in `/auth/refresh`).
- The access token itself is stateless and cannot be server-revoked before its TTL expires. It will become invalid within `ACCESS_TOKEN_TTL_SECONDS` (default: 15 min).
- **⚠️ Not yet implemented**: JWT access-token blocklisting is deferred to Phase 2.

### Configuration — Fail-Closed

Authentication configuration (`packages/server/src/auth/config.ts`) is validated at server startup. The process exits immediately if:
- `JWT_SECRET` is not set.
- `JWT_SECRET` is shorter than 32 characters.
- `ACCESS_TOKEN_TTL_SECONDS` is not a valid integer >= 60.
- `REFRESH_TOKEN_TTL_DAYS` is not a valid integer >= 1.

There are no silent insecure defaults for `JWT_SECRET`.

### Known Limitations / Deferred Work

The following are **not implemented** in Phase 1 and are explicitly deferred:

| Item | Status |
|---|---|
| Refresh-token rotation | ⏳ Deferred — Phase 2 |
| Refresh-token reuse detection | ⏳ Deferred — Phase 2 |
| JWT access-token blocklisting | ⏳ Deferred — Phase 2 |
| Rate limiting / brute-force protection | ⏳ Deferred |
| Project-level authorization / scoping | ⏳ Deferred |
| Offline revalidation wiring into sync | ⏳ Deferred |
| Auth enforcement on `/sync/push` and `/sync/pull` | ⏳ Deferred — Phase 2 |
| "Logout all devices" / global session revocation | ⏳ Deferred — Phase 2 |
| RS256 / asymmetric key rotation | ⏳ Deferred — Phase 3+ |

---

## 7. Development Workflow

```
FieldCore uses an issue-driven Git workflow:

**GitHub Issue → Feature Branch → Implementation & Tests → Pull Request → Review → Merge → Post-Merge Verification**

Changes are developed on dedicated branches and merged into `main` through pull requests after the relevant tests and reviews pass.

```

### Completed Milestones

| PR | Branch | Description | Merged |
|---|---|---|---|
| #26 | `feat/25-auth-infrastructure` | Phase 1: JWT auth, Argon2id, device identity, sessions, refresh tokens | 2026-09-15 |

---

## 8. Roadmap (Planned — Not Yet Implemented)

The items below are planned future work. They are documented here for orientation only. None of the following are implemented on `main`.

- **Phase 2 — Auth Hardening**: Refresh-token rotation and reuse detection; access-token blocklisting; rate limiting; auth enforcement on sync routes (`POST /sync/push`, `GET /sync/pull`).
- **Project-level authorization**: Scoping data access to user-assigned projects.
- **Offline revalidation wiring**: Enforcing the 7-day `offline_auth_window_days` window in the sync protocol (`REQUIRES_REVALIDATION` response).
- **Advanced device management**: Device enrollment flows, recovery, and revocation UIs.
- **Media/binary synchronization**: Photo, video, and attachment sync.
- **Dynamic forms**: Configurable field-capture templates.
- **Live tracking**: Real-time GPS track recording and replay.
- **Advanced maps**: Offline tile caching, polygon/polyline overlays.
- **Analytics & reporting**: Field data aggregation, export, and dashboards.
- **Cloud deployment**: Production infrastructure, CI/CD pipelines, secrets management.
