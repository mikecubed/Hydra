# Task List: Web-Controlled Mutations

**Feature**: `web-controlled-mutations`
**Branch**: `feat/web-controlled-mutations`
**Created**: 2026-03-27
**Spec**: [`spec.md`](./spec.md)
**Plan**: [`plan.md`](./plan.md)
**Total tasks**: 41
**Phases**: 0–8 across Contracts / Daemon / Gateway / Browser / Integration tracks

---

## How to read this file

```
- [ ] T### [Ph#] [TRACK] Title
      Files: exact/file/paths.ts  (✦ = create new, ✎ = modify existing)
      Depends: T### T###
      AC: acceptance criteria bullet(s)
```

Priority codes: **P1** = must-have (US1–US2), **P2** = should-have (US3–US5), **P3** = nice-to-have (US6–US7).

---

## Phase 0 — Schema Contracts

> **Track**: CONTRACTS · **Unblocks**: all parallel sprint tracks · **Exit gate**: `npm run quality` passes on `packages/web-contracts/`; `config-mutation.test.ts` passes

---

- [x] **T001** [Ph0] [CONTRACTS] [P1] `config-mutation.ts` — core mutation schemas
  ```
  Files:
    ✦ packages/web-contracts/src/config-mutation.ts
  ```
  **Depends**: —
  **AC**:
  - Exports `RoutingMode` (`z.enum(['economy','balanced','performance'])`), `ModelTier` (`z.enum(['default','fast','cheap'])`), `AgentId` (dynamically derived from built-in physical agents `claude`, `gemini`, `codex`, `local`, optional `copilot`, plus any `agents.customAgents[]` — agents without a `models` config entry are excluded from model-tier selection and shown as read-only).
  - Exports `SafeConfigView` using `.strip()` with a `.superRefine()` that walks all parsed-object keys and throws a `ZodError` on any key matching `/(apiKey|secret|hash|password)/i`. Extra undeclared fields are silently stripped, not rejected.
  - Exports `RoutingModeMutationRequest` (fields: `mode: RoutingMode`, `expectedRevision: z.string()`).
  - Exports `ModelTierMutationRequest` (fields: `tier: ModelTier`, `expectedRevision: z.string()`).
  - Exports `BudgetMutationRequest` (fields: `modelId: z.string()`, `dailyLimit: z.int().positive().nullable()`, `weeklyLimit: z.int().positive().nullable()`, `expectedRevision: z.string()`); schema-level refinement rejects requests where both limits are `null`.
  - Exports `ConfigMutationResponse` (fields: `snapshot: SafeConfigView`, `appliedRevision: z.string()`, `timestamp: z.iso.datetime()`).
  - All schemas compile with zero TypeScript errors (`tsc --noEmit`).

---

- [x] **T002** [Ph0] [CONTRACTS] [P1] `workflow-launch.ts` — workflow launch schemas
  ```
  Files:
    ✦ packages/web-contracts/src/workflow-launch.ts
  ```
  **Depends**: —
  **AC**:
  - Exports `WorkflowName` (`z.enum(['evolve','tasks','nightly'])`).
  - Exports `WorkflowLaunchRequest` (fields: `workflow: WorkflowName`, `label: z.string().nullable().optional()`, `idempotencyKey: z.string().uuid()`, `expectedRevision: z.string()`).
  - Exports `WorkflowLaunchResponse` (fields: `taskId: z.string()`, `workflow: WorkflowName`, `launchedAt: z.iso.datetime()`, `destructive: z.boolean()`).
  - All schemas compile with zero TypeScript errors.

---

- [x] **T003** [Ph0] [CONTRACTS] [P1] Extend `audit-schemas.ts` with mutation audit types
  ```
  Files:
    ✎ packages/web-contracts/src/audit-schemas.ts
  ```
  **Depends**: T001
  **AC**:
  - `AuditEventType` enum extended with exactly six new values: `config.routing.mode.changed`, `config.models.active.changed`, `config.usage.budget.changed`, `workflow.launched`, `config.mutation.rejected`, `workflow.launch.rejected`.
  - Existing `AuditRecord` schema still accepts all original event type values (no regression).
  - Exports `MutationAuditRecord` schema (fields: `id`, `timestamp`, `eventType: AuditEventType`, `operatorId`, `sessionId`, `targetField`, `beforeValue: z.unknown()`, `afterValue: z.unknown()`, `outcome: z.enum(['success','failure'])`, `rejectionReason: z.string().nullable()`, `sourceIp: z.string()`).
  - Exports `AuditPageRequest` (fields: `limit: z.number().int().min(1).max(100).default(20)`, `cursor: z.string().optional()`).
  - Exports `AuditPageResponse` (fields: `records: z.array(MutationAuditRecord)`, `nextCursor: z.string().nullable()`, `totalCount: z.number().nullable().optional()`).

---

- [x] **T004** [Ph0] [CONTRACTS] [P1] Gateway-layer contract files (`contracts/` subdir — three new files)
  ```
  Files:
    ✦ packages/web-contracts/src/contracts/config-mutation.ts
    ✦ packages/web-contracts/src/contracts/workflow-launch.ts
    ✦ packages/web-contracts/src/contracts/audit-read.ts
  ```
  **Depends**: T001, T002, T003
  **AC**:
  - `contracts/config-mutation.ts` exports: `GetSafeConfigResponse` (wraps `SafeConfigView`), `PatchRoutingModeRequest` / `PatchRoutingModeResponse`, `PatchModelTierRequest` (includes `:agent` path-param schema validated against `AgentId`) / `PatchModelTierResponse`, `PatchBudgetRequest` / `PatchBudgetResponse`. Pattern mirrors existing `contracts/operations-control.ts`.
  - `contracts/workflow-launch.ts` exports: `PostWorkflowLaunchRequest` / `PostWorkflowLaunchResponse`.
  - `contracts/audit-read.ts` exports: `GetAuditRequest` (query-param schema: `limit`, `cursor`) / `GetAuditResponse` (wraps `AuditPageResponse`).
  - All three files import only from their sibling source schemas (no circular deps).

---

- [x] **T005** [Ph0] [CONTRACTS] [P1] Contract unit tests — `config-mutation.test.ts`
  ```
  Files:
    ✦ packages/web-contracts/src/__tests__/config-mutation.test.ts
  ```
  **Depends**: T001, T002, T003
  **AC**:
  - `SafeConfigView.parse` **strips** objects with extra (undeclared) fields (`.strip()` behavior — SC-007): parsing an object with extra keys silently removes them and returns only declared fields.
  - `SafeConfigView.parse` **rejects** objects containing any key matching `apiKey`, `secret`, `hash`, or `password` (superRefine guard — SC-010, R-3).
  - `RoutingModeMutationRequest.parse` rejects unknown mode values (e.g., `"turbo"`).
  - `ModelTierMutationRequest.parse` rejects unknown tier values (e.g., `"ultra"`).
  - `BudgetMutationRequest.parse` rejects non-positive `dailyLimit` and `weeklyLimit` (e.g., `0`, `-1`).
  - `BudgetMutationRequest.parse` rejects non-integer `dailyLimit` (e.g., `1.5`).
  - `BudgetMutationRequest.parse` rejects requests where both `dailyLimit` and `weeklyLimit` are `null`.
  - All test cases run via `node --test` and pass with zero failures.

---

- [x] **T006** [Ph0] [CONTRACTS] [P1] Extend `index.ts` barrel + Phase 0 quality gate
  ```
  Files:
    ✎ packages/web-contracts/src/index.ts
  ```
  **Depends**: T001, T002, T003, T004, T005
  **AC**:
  - `index.ts` re-exports all new schemas from `config-mutation.ts`, `workflow-launch.ts`, and the three `contracts/` files under a `// Mutation contracts (Phase 5)` comment block, following the existing phase-grouping style.
  - `npm run quality` on `packages/web-contracts/` exits 0: lint, typecheck, `format:check`, `lint:cycles` all pass.
  - No circular dependencies introduced between any `web-contracts` files.

---

## Phase 1 — Daemon P1: Safe-Read + Routing Mode Mutation

> **Track**: DAEMON · **Prerequisite**: Phase 0 complete · **Exit gate**: `test/daemon/mutation-routes.test.ts` passes; concurrent-mutation determinism test passes; `npm run quality` on `lib/`

---

- [x] **T007** [Ph1] [DAEMON] [P1] Scaffold `mutation-routes.ts` with `computeConfigRevision` and `GET /config/safe`
  ```
  Files:
    ✦ lib/daemon/mutation-routes.ts
  ```
  **Depends**: T006, T008a
  **AC**:
  - Imports `configMutex` from `lib/daemon/mutation-lock.ts` (the in-repo Promise-chain mutex — no external dependency).
  - `computeConfigRevision(config)` function: SHA-256 hash (Node `crypto.createHash('sha256')`) of `JSON.stringify({ routing: config.routing, models: config.models, usage: config.usage })`, truncated to 32 hex chars. Calling it twice on the same config object produces identical output (deterministic — Phase 1 AC).
  - `GET /config/safe` handler: reads `hydra.config.json` via `loadHydraConfig()`, parses with `SafeConfigView.strip()`, attaches `revision: computeConfigRevision(config)`, returns 200 with `SafeConfigView` body; returns 503 `{ error: 'daemon-unavailable' }` on read error.
  - File compiles with zero TypeScript errors.

---

- [x] **T008** [Ph1] [DAEMON] [P1] `POST /config/routing/mode` handler with optimistic-concurrency mutex
  ```
  Files:
    ✎ lib/daemon/mutation-routes.ts
  ```
  **Depends**: T007
  **AC**:
  - Handler acquires `configMutex` before reading config and releases it after writing (R-1: concurrent mutations cannot interleave file read and write).
  - Parses body with `RoutingModeMutationRequest`; returns 400 on schema failure.
  - Computes current revision; returns 409 `{ error: 'stale-revision' }` if `body.expectedRevision` does not match (R-1).
  - Writes new `routing.mode` to `hydra.config.json` via existing `writeState`/`saveHydraConfig` pattern.
  - Appends a `MutationAuditRecord` to `mutation-audit.jsonl` with `eventType: 'config.routing.mode.changed'`, `targetField: 'config.routing.mode'`, `beforeValue`, `afterValue`, `outcome: 'success'`. Audit failure does **not** suppress the 200 response (R-2).
  - Returns 200 `ConfigMutationResponse` with updated `SafeConfigView` snapshot and new `appliedRevision`.
  - After a successful mutation, re-reading `GET /config/safe` reflects the new mode and a **different** revision token.

---

- [x] **T008a** [Ph1] [DAEMON] [P1] `mutation-lock.ts` — in-repo Promise-chain mutex
  ```
  Files:
    ✦ lib/daemon/mutation-lock.ts
    ✦ test/daemon/mutation-lock.test.ts
  ```
  **Depends**: T006
  **AC**:
  - Exports `configMutex` — a simple Promise-chain mutex (no external dependency, consistent with minimal-deps philosophy).
  - `configMutex.acquire()` returns a release function; only one caller can hold the lock at a time.
  - Concurrent `acquire()` calls queue and resolve in order.
  - Test file at `test/daemon/mutation-lock.test.ts` covers:
    - Two concurrent `acquire()` calls: second waits until first releases.
    - Release after acquire allows next queued caller to proceed.
    - No deadlock when acquire/release is called in a loop (10 iterations).
  - File compiles with zero TypeScript errors.

---

- [x] **T009** [Ph1] [DAEMON] [P1] Register mutation routes in `orchestrator-daemon.ts` + Phase 1 daemon tests
  ```
  Files:
    ✎ lib/orchestrator-daemon.ts
    ✦ test/daemon/mutation-routes.test.ts
  ```
  **Depends**: T007, T008, T008a
  **AC**:
  - `orchestrator-daemon.ts` imports `handleMutationRoute` from `mutation-routes.ts` and dispatches HTTP requests to it **after** `isAuthorized(req)` in the daemon middleware chain, consistent with how `handleWriteRoute` is wired. Mutation routes must NOT be wired alongside read-routes (which run before auth).
  - Test file covers (via `node:test` + `node:assert/strict`):
    - `GET /config/safe` → 200 with shape matching `SafeConfigView`
    - `GET /config/safe` with missing / corrupt config file → 503
    - `POST /config/routing/mode` valid body + correct revision → 200; `MutationAuditRecord` appended to log file
    - `POST /config/routing/mode` stale `expectedRevision` → 409 `{ error: 'stale-revision' }`
    - `POST /config/routing/mode` invalid mode value (e.g., `"turbo"`) → 400
    - `POST /config/routing/mode` missing `expectedRevision` field → 400
    - **Concurrency test**: two simultaneous `POST /config/routing/mode` requests carrying the same `expectedRevision` via `Promise.all` — exactly one resolves 200 and one resolves 409 (deterministic, no flakiness).
  - `npm run quality` on `lib/` exits 0.

---

## Phase 2 — Gateway P1: Mutations Module Scaffold + Routing Route

> **Track**: GATEWAY · **Prerequisite**: Phase 0 complete (Phase 1 daemon **not** required — tests use stubs) · **Exit gate**: all gateway tests pass; `npm run quality` on `apps/web-gateway/`

---

- [x] **T010** [Ph2] [GATEWAY] [P1] `daemon-mutations-client.ts` — typed HTTP client for all six daemon endpoints
  ```
  Files:
    ✦ apps/web-gateway/src/mutations/daemon-mutations-client.ts
  ```
  **Depends**: T006
  **AC**:
  - `DaemonMutationsClient` class follows `daemon-operations-client.ts` pattern exactly: configurable `daemonUrl` and injectable `fetch` for tests; 5-second default timeout.
  - Implements all six methods: `getSafeConfig()`, `postRoutingMode(body)`, `postModelTier(agent, body)`, `postBudget(body)`, `postWorkflowLaunch(body)`, `getAudit(params)`.
  - Each method returns a typed success union or a `GatewayErrorResponse`: daemon `400` → `{ error: 'validation' }`, daemon `409` → `{ error: 'stale-revision' }` or `{ error: 'workflow-conflict' }`, daemon `503` / network error → `{ error: 'daemon-unavailable' }`.
  - No `any` types in the file; compiles cleanly.

---

- [x] **T011** [Ph2] [GATEWAY] [P1] `request-validator.ts` — Zod validation helpers for mutation request bodies
  ```
  Files:
    ✦ apps/web-gateway/src/mutations/request-validator.ts
  ```
  **Depends**: T006
  **AC**:
  - Exports: `validateRoutingModeBody(body)`, `validateModelTierBody(agent, body)` (validates `:agent` path param against known agents with `models` config; 400 on unknown or ineligible agent), `validateBudgetBody(body)`, `validateWorkflowLaunchBody(body)`, `validateAuditParams(query)`.
  - Each function returns the parsed schema type on success or a `ValidationError` discriminant on failure — never throws.
  - Pattern mirrors `operations/request-validator.ts` exactly.

---

- [x] **T012** [Ph2] [GATEWAY] [P1] `response-translator.ts` — maps daemon error categories to HTTP status + client messages
  ```
  Files:
    ✦ apps/web-gateway/src/mutations/response-translator.ts
  ```
  **Depends**: T010
  **AC**:
  - Maps `GatewayErrorResponse` categories to HTTP status + message string:
    - `stale-revision` → 409 `"Config has changed — reload and retry"`
    - `daemon-unavailable` → 503 `"Daemon unreachable"`
    - `validation` → 400 + forwarded message from daemon
    - `workflow-conflict` → 409 `"Workflow already running"`
  - No `any` types; compiles cleanly; function is pure (no side-effects, testable in isolation).

---

- [x] **T012a** [Ph2] [GATEWAY] [P1] Extend `gateway-error-response.ts` with new error categories
  ```
  Files:
    ✎ apps/web-gateway/src/shared/gateway-error-response.ts
  ```
  **Depends**: T006
  **AC**:
  - `ErrorCategory` type extended with three new categories: `stale-revision`, `daemon-unavailable`, `workflow-conflict`.
  - `ERROR_CATEGORIES` array updated to include all eight categories.
  - Existing five categories unchanged (no regression).
  - File compiles with zero TypeScript errors.

---

- [x] **T013** [Ph2] [GATEWAY] [P1] `mutations-routes.ts` Phase 1 routes (`GET /config/safe`, `POST /config/routing/mode`) + register in `index.ts` + update `GATEWAY_ROUTE_PREFIXES`
  ```
  Files:
    ✦ apps/web-gateway/src/mutations/mutations-routes.ts
    ✎ apps/web-gateway/src/index.ts
    ✎ apps/web-gateway/src/server-runtime.ts
  ```
  **Depends**: T010, T011, T012, T012a
  **AC**:
  - `mutations-routes.ts` is a Hono sub-router typed with `GatewayEnv`; follows `operations-routes.ts` structure exactly.
  - `GET /config/safe`: calls `daemonClient.getSafeConfig()`; translates errors via `response-translator.ts`; returns 200 or 503. No CSRF required on GET (auth and CSRF applied globally by `createProtectedRouteGroup`).
  - `POST /config/routing/mode`: `validateRoutingModeBody` (400 on failure) → `mutatingRateLimiter` (429 at ≥31 mutations/60 s/session) → `daemonClient.postRoutingMode` → return translated response. Auth and CSRF applied globally by `createProtectedRouteGroup()`. On gateway-level rejection, record to existing `AuditStore`. Audit write failure must be logged but MUST NOT suppress the mutation response (R-2 / SEC-06).
  - `index.ts` registers `mutationsRouter` via `createProtectedRouteGroup()` in `createProtectedRootRoutes()`, matching the same pattern as the `operations` module.
  - `server-runtime.ts` `GATEWAY_ROUTE_PREFIXES` updated to include `/mutations` and `/audit` (prevents SPA static-file fallback interception).
  - No `lib/` imports anywhere in `apps/web-gateway/` (SEC-03 / R-6).

---

- [x] **T014** [Ph2] [GATEWAY] [P1] Gateway Phase 1 tests — `mutations-routes.test.ts` (P1 cases) + `daemon-mutations-client.test.ts`
  ```
  Files:
    ✦ apps/web-gateway/src/mutations/__tests__/mutations-routes.test.ts
    ✦ apps/web-gateway/src/mutations/__tests__/daemon-mutations-client.test.ts
  ```
  **Depends**: T013
  **AC**:
  - `mutations-routes.test.ts` Phase 1 cases (daemon client stubbed throughout):
    - `GET /config/safe` authenticated → 200 with `SafeConfigView`-shaped body
    - `GET /config/safe` no session → 401 (not 503)
    - `POST /config/routing/mode` valid CSRF + session → daemon stub called with correct payload; 200 returned
    - `POST /config/routing/mode` missing CSRF token → 403; daemon client never called
    - `POST /config/routing/mode` expired session → 401; CSRF check never reached
    - `POST /config/routing/mode` invalid mode value → 400; daemon client never called
    - `POST /config/routing/mode` daemon stub returns stale-revision → 409 forwarded
    - `POST /config/routing/mode` daemon stub unavailable → 503 forwarded
    - Successful mutation → gateway audit records success; audit write failure does not suppress response
    - Audit service throws → 200 still returned; logger spy shows structured error
    - 31st mutation in 60-second window from the same session → 429
  - `daemon-mutations-client.test.ts`:
    - Correct HTTP method + path for each of the six daemon endpoint methods
    - Request body serialised correctly for `postRoutingMode`, `postModelTier`, `postBudget`
    - Daemon `409` → `{ error: 'stale-revision' }` category
    - Daemon `503` → `{ error: 'daemon-unavailable' }` category
    - Network error (fetch rejects) → `{ error: 'daemon-unavailable' }` category
  - All tests run via `node:test` + `node:assert/strict`; `npm run quality` on `apps/web-gateway/` exits 0.

---

## Phase 3 — Daemon P2/P3: Model, Budget, Workflow Launch, Audit

> **Track**: DAEMON · **Prerequisite**: Phase 1 (T007–T009) · **Exit gate**: all daemon tests pass; `npm run quality` on `lib/`

---

- [x] **T015** [Ph3] [DAEMON] [P2] `POST /config/models/:agent/active` handler
  ```
  Files:
    ✎ lib/daemon/mutation-routes.ts
    ✎ test/daemon/mutation-routes.test.ts
  ```
  **Depends**: T009
  **AC**:
  - Handler acquires `configMutex` for read-hash-write-audit cycle.
  - Validates `:agent` path param against known agents with `models` config entries; returns 400 on unknown or ineligible agent (e.g., `local`, `copilot`, custom `cli` agents without models config).
  - Parses body with `ModelTierMutationRequest`; returns 400 on schema failure.
  - Checks `expectedRevision`; returns 409 `{ error: 'stale-revision' }` on mismatch.
  - Writes new tier to `hydra.config.json` under `models[agent].tiers.active` (or equivalent config key).
  - Appends `MutationAuditRecord` with `targetField: 'config.models.<agent>.active'`, correct before/after values, `outcome: 'success'`.
  - Returns 200 `ConfigMutationResponse` with updated `SafeConfigView` snapshot.
  - New test cases added to `test/daemon/mutation-routes.test.ts`:
    - `POST /config/models/claude/active` valid request → 200 + correct tier in response
    - `POST /config/models/unknown/active` → 400
    - `POST /config/models/gemini/active` stale revision → 409

---

- [x] **T016** [Ph3] [DAEMON] [P2] `POST /config/usage/budget` handler + `POST /workflows/launch` handler
  ```
  Files:
    ✎ lib/daemon/mutation-routes.ts
    ✎ test/daemon/mutation-routes.test.ts
  ```
  **Depends**: T015
  **AC**:
  - **Budget handler**: acquires `configMutex`; validates at least one of `dailyLimit`/`weeklyLimit` is non-null and any non-null value is a positive integer; validates `modelId` exists in the current config's usage map (400 on unknown); checks revision; writes updated budget; appends `MutationAuditRecord` with `targetField: 'config.usage.budget.<modelId>'`; if `dailyLimit > weeklyLimit` after update, daemon logs a structured warning but still persists and returns 200; returns `ConfigMutationResponse`.
  - **Workflow launch handler**: acquires `configMutex` (R-5: conflict check + dedup + enqueue inside lock); validates `workflow` against `WorkflowName` enum (400 on unknown); validates `idempotencyKey` is a UUID (400 on missing/invalid); deduplicates: if a launch with the same `idempotencyKey` was processed within the last 60 seconds, returns the existing task ID without launching again (FR-009a); checks if a task with the same workflow is in `running`/`pending` state → returns 409 `{ error: 'workflow-conflict' }`; checks `expectedRevision`; assigns new task ID via `nextId()`; enqueues workflow task; appends `MutationAuditRecord` with `eventType: 'workflow.launched'`; returns 202 `WorkflowLaunchResponse` with `taskId`, `workflow`, `launchedAt`, and `destructive: true` for `evolve`/`nightly`, `destructive: false` for `tasks`.
  - New test cases:
    - Budget: valid request → 200
    - Budget: non-positive `dailyLimit` → 400
    - Budget: both limits `null` → 400
    - Budget: unknown `modelId` → 400
    - Workflow: `tasks` → 202 + `destructive: false`
    - Workflow: `evolve` → 202 + `destructive: true`
    - Workflow: already-running workflow → 409
    - Workflow: unknown workflow name → 400

---

- [x] **T017** [Ph3] [DAEMON] [P3] `GET /audit` handler + extend daemon tests
  ```
  Files:
    ✎ lib/daemon/mutation-routes.ts
    ✎ test/daemon/mutation-routes.test.ts
  ```
  **Depends**: T016
  **AC**:
  - Handler parses `limit` (default 20, max 100) and `cursor` (base64-encoded ISO timestamp of oldest record in the previous page) from query params.
  - Reads from the mutation audit store (in-memory array backed by `mutation-audit.jsonl`).
  - Returns records in **reverse-chronological** order.
  - `nextCursor` is null when no more records exist; non-null when further pages are available.
  - `totalCount` is the current in-memory array length.
  - Cursor-based pagination: records from page N do **not** appear on page N+1 (no duplicates).
  - New test cases:
    - `GET /audit` empty store → 200 + `{ records: [], nextCursor: null }`
    - `GET /audit?limit=2` with 5 records → 2 records + non-null `nextCursor`
    - `GET /audit?limit=2&cursor=<nextCursor>` → next 2 records (different from first page) + non-null cursor
    - `GET /audit?limit=2&cursor=<thirdCursor>` → 1 record + `nextCursor: null`

---

- [x] **T017a** [Ph3] [DAEMON] [P1] Phase 3 quality gate
  ```
  Files:
    (no new files — validation-only task)
  ```
  **Depends**: T017
  **AC**:
  - Run `npm run quality` with all Phase 3 files staged; verify 0 TS errors and 0 lint errors for new daemon handlers.
  - `test/daemon/mutation-routes.test.ts` passes with all Phase 3 test cases.

---

## Phase 4 — Gateway P2/P3: Model, Budget, Workflow, Audit Routes

> **Track**: GATEWAY · **Prerequisites**: Phase 2 (T010–T014) + Phase 3 (T015–T017) · **Exit gate**: all gateway tests pass; `npm run quality` on `apps/web-gateway/`

---

- [x] **T018** [Ph4] [GATEWAY] [P2] Extend `mutations-routes.ts` with remaining four routes
  ```
  Files:
    ✎ apps/web-gateway/src/mutations/mutations-routes.ts
  ```
  **Depends**: T014, T017
  **AC**:
  - `POST /config/models/:agent/active`: same middleware stack as routing-mode route; `validateModelTierBody(agent, body)` rejects unknown or ineligible `:agent` with 400 before daemon is called; forwards to `daemonClient.postModelTier`; gateway attempt log records rejection on failure.
  - `POST /config/usage/budget`: same middleware stack; `validateBudgetBody` rejects non-positive values; forwards to `daemonClient.postBudget`; gateway attempt log records rejection on failure.
  - `POST /workflows/launch`: same middleware stack; `validateWorkflowLaunchBody` rejects unknown workflow name or missing `idempotencyKey`; forwards to `daemonClient.postWorkflowLaunch`; when daemon returns `destructive: true`, gateway passes it through transparently; gateway attempt log records rejection on failure.
  - `GET /audit`: applies session auth only (no CSRF, no rate-limiter — applied globally by `createProtectedRouteGroup`); `validateAuditParams` parses `limit` and `cursor`; forwards to `daemonClient.getAudit`; returns 200 `AuditPageResponse` or translated error.
  - All six routes (from Phase 2 + Phase 4) are live under `/mutations/`.

---

- [x] **T019** [Ph4] [GATEWAY] [P2] Extend `mutations-routes.test.ts` with Phase 4 test cases
  ```
  Files:
    ✎ apps/web-gateway/src/mutations/__tests__/mutations-routes.test.ts
  ```
  **Depends**: T018
  **AC**:
  - `POST /config/models/unknown/active` → 400 (daemon client never called)
  - `POST /config/models/claude/active` valid → 200
  - `POST /config/usage/budget` non-positive `dailyLimit` → 400
  - `POST /workflows/launch` unknown workflow name → 400
  - `POST /workflows/launch` daemon stub returns `workflow-conflict` → 409
  - `POST /workflows/launch` no CSRF token → 403; daemon client never called
  - `POST /workflows/launch` `evolve` → 202 + `{ destructive: true }` in response body
  - `GET /audit` no session → 401
  - `GET /audit?limit=5&cursor=<opaque>` valid session → daemon called with `{ limit: 5, cursor: '<opaque>' }`
  - `GET /audit` daemon unavailable stub → 503
  - **Auth/rate-limit coverage** (T-3): 401 for unauthenticated model-tier and budget mutations; 429 for rate-limit responses on all four mutation routes; rejected requests are not forwarded to the daemon.
  - `npm run quality` on `apps/web-gateway/` exits 0.

---

- [x] **T019b** [Ph4] [GATEWAY] [P2] Rejected-attempt audit coverage test
  ```
  Files:
    ✎ apps/web-gateway/src/mutations/__tests__/mutations-routes.test.ts
  ```
  **Depends**: T019
  **AC**:
  - Verify gateway audit records are written for every rejected mutation attempt before the response is sent:
    - CSRF fail → 403 + `AuditStore` entry with `outcome: 'failure'`
    - Session fail → 401 + `AuditStore` entry with `outcome: 'failure'`
    - Validation fail → 400 + `AuditStore` entry with `outcome: 'failure'`
    - Rate-limit → 429 + `AuditStore` entry with `outcome: 'failure'`
  - Integration test checks `AuditStore.getRecords()` after each forced rejection to confirm the record was written before the response was returned.

---

## Phase 5 — Browser P1: Config Read Panel + Routing Mutation UI

> **Track**: BROWSER · **Prerequisite**: Phase 0 (T001–T006); Phase 2 gateway **not** required — uses mocked API layer · **Exit gate**: browser specs pass; `npm run quality` on `apps/web/`

---

- [x] **T020** [Ph5] [BROWSER] [P1] `api/mutations-client.ts` — typed browser-side gateway client
  ```
  Files:
    ✦ apps/web/src/features/mutations/api/mutations-client.ts
  ```
  **Depends**: T006
  **AC**:
  - Exports `createMutationsClient(baseUrl: string): MutationsClient` factory function. Follows `operations-client.ts` pattern: typed `fetch` wrappers; injects `X-CSRF-Token` header from `__csrf` cookie (same cookie-extraction pattern as existing Phase 2/4a browser features) for all mutating POST endpoints.
  - Implements six methods: `getSafeConfig()`, `postRoutingMode(body)`, `postModelTier(agent, body)`, `postBudget(body)`, `postWorkflowLaunch(body)`, `getAudit(params)`. All mutation methods use POST (not PATCH).
  - Each method returns typed success result or `GatewayErrorBody` discriminant — zero `any` escapes.
  - `getSafeConfig` and `getAudit` do **not** inject CSRF header.

---

- [x] **T021** [Ph5] [BROWSER] [P1] `model/use-safe-config.ts` — config fetch hook with revision exposure
  ```
  Files:
    ✦ apps/web/src/features/mutations/model/use-safe-config.ts
  ```
  **Depends**: T020
  **AC**:
  - Hook signature: `useSafeConfig(): { config: SafeConfigView | null; revision: string | null; isLoading: boolean; error: string | null; refetch: () => void }`.
  - Fetches `GET /config/safe` on mount; sets `isLoading: true` during fetch; sets `error` string on 503; clears `error` on success.
  - Does **not** auto-poll; `refetch` triggers a fresh fetch and updates `config` and `revision`.
  - `revision` is extracted from `SafeConfigView.revision` field and exposed at the hook level (used by mutation callers for `expectedRevision` — FR-009).
  - No `any` types.

---

- [x] **T022** [Ph5] [BROWSER] [P1] `model/use-mutation.ts` — generic mutation hook
  ```
  Files:
    ✦ apps/web/src/features/mutations/model/use-mutation.ts
  ```
  **Depends**: T020
  **AC**:
  - Generic signature: `useMutation<TRequest, TResponse>(mutationFn, options?: { onSuccess?: (result: TResponse) => void }): { mutate: (body: TRequest) => Promise<void>; isLoading: boolean; error: string | null; reset: () => void }`.
  - `mutate` sets `isLoading: true` before call; clears it after resolution regardless of outcome.
  - On success: calls `options.onSuccess(result)` if provided (used to trigger `refetch` in config panel — FR-015).
  - On error: sets `error` to the error message string.
  - `reset()` clears `error` and `isLoading` without triggering a new mutation.
  - No `any` types.

---

- [x] **T023** [Ph5] [BROWSER] [P1] `components/mutation-error-banner.tsx` — dismissible inline error banner
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/mutation-error-banner.tsx
  ```
  **Depends**: T006
  **AC**:
  - Props: `{ message: string | null; onDismiss: () => void }`.
  - Renders nothing (returns `null`) when `message` is `null`.
  - When `message` is non-null, renders a dismissible banner with the message text and a close/dismiss button that calls `onDismiss`.
  - No `any` types; compiles cleanly.

---

- [x] **T024** [Ph5] [BROWSER] [P1] `components/confirm-dialog.tsx` — reusable single-step confirm dialog
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/confirm-dialog.tsx
  ```
  **Depends**: T006
  **AC**:
  - Props: `{ isOpen: boolean; title: string; from: string; to: string; onConfirm: () => void; onCancel: () => void; isLoading: boolean }`.
  - Renders both `from` and `to` values in the dialog body.
  - Confirm button is **disabled** while `isLoading: true`.
  - Cancel button immediately calls `onCancel` without any side-effects; does not call `onConfirm`.
  - Confirm button calls `onConfirm` exactly once per click.
  - Dialog is not rendered (or is visually hidden) when `isOpen: false`.

---

- [x] **T025** [Ph5] [BROWSER] [P1] `components/routing-section.tsx` — routing mode display + mutation trigger
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/routing-section.tsx
  ```
  **Depends**: T021, T022, T024
  **AC**:
  - Displays current routing mode as a badge; `<select>` with `economy`|`balanced`|`performance` options.
  - Selecting the **already-active** mode does **not** open the confirm dialog (no-op — US2 AC edge case).
  - Selecting a **different** mode opens `ConfirmDialog` with correct `from`/`to` labels.
  - On dialog cancel: no network request is sent.
  - On dialog confirm: calls `useMutation(postRoutingMode)` with `{ mode: selectedMode, expectedRevision: revision }`; spinner/disabled state shown during in-flight mutation.
  - On success: calls `refetch` from `useSafeConfig` (FR-015).
  - On mutation error (e.g., stale revision): `MutationErrorBanner` shows the error message.

---

- [x] **T026** [Ph5] [BROWSER] [P1] `components/config-panel.tsx` — Phase 1 shell with routing section + stubs
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/config-panel.tsx
  ```
  **Depends**: T021, T023, T025
  **AC**:
  - Top-level panel that calls `useSafeConfig()` to load config on mount.
  - Renders `RoutingSection` (live), plus **stub/placeholder** elements for `ModelsSection` and `BudgetsSection` (to be wired in T035).
  - Shows `MutationErrorBanner` for top-level errors.
  - Shows "Config unavailable — daemon unreachable" message on 503 (US1 AC-2); does not render stale data when error is present.
  - Does not crash when `config` is `null` (loading state renders a loading indicator).
  - Relies on `useSession` guard for 401 redirect (no direct redirect logic in this component).

---

- [x] **T027** [Ph5] [BROWSER] [P1] Browser specs — `config-panel.browser.spec.tsx` + `confirm-dialog.browser.spec.tsx`
  ```
  Files:
    ✦ apps/web/src/features/mutations/__tests__/config-panel.browser.spec.tsx
    ✦ apps/web/src/features/mutations/__tests__/confirm-dialog.browser.spec.tsx
  ```
  **Depends**: T026
  **AC**:
  - `config-panel.browser.spec.tsx`:
    - Renders routing section correctly from a mocked `SafeConfigView` (no crash on valid data).
    - The entire rendered output contains **no** text matching the substrings `key`, `secret`, `hash`, or `password` (SC-010 / FR-010).
    - Shows "daemon unreachable" message when `getSafeConfig` mock returns 503.
    - Stubs `ModelsSection` and `BudgetsSection` are rendered without crashing.
  - `confirm-dialog.browser.spec.tsx`:
    - Cancel button click does **not** call `onConfirm` prop.
    - Confirm button click calls `onConfirm` exactly once.
    - Confirm button is disabled when `isLoading={true}`.
    - `from` and `to` prop values are visible in the rendered dialog body.
  - All specs run via Vitest browser mode (`*.browser.spec.tsx`) and pass with zero failures.
  - `npm run quality` on `apps/web/` exits 0.

---

## Phase 6 — Browser P2: Model, Budget + Workflow Launch UI

> **Track**: BROWSER · **Prerequisite**: Phase 5 (T020–T027) · **Exit gate**: browser specs pass; `npm run quality` on `apps/web/`

---

- [x] **T028** [Ph6] [BROWSER] [P2] `components/models-section.tsx` — per-agent tier selector with confirmation
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/models-section.tsx
  ```
  **Depends**: T025
  **AC**:
  - Renders one row per agent with a `models` config entry from `SafeConfigView.models` (typically `gemini`, `codex`, `claude`; agents without `models` config like `local`, `copilot`, custom `cli` agents are shown as read-only).
  - Each row shows agent name + current tier badge + `<select>` for `default`|`fast`|`cheap`.
  - Confirm button for a row is **disabled** when selected tier equals current tier (US3 AC-2).
  - On dialog confirm: calls `postModelTier` with `{ agent, tier: selectedTier, expectedRevision: revision }`.
  - On stale-revision error: shows a non-blocking toast (distinct from the blocking `MutationErrorBanner` — US3 AC-3); does **not** block the UI.
  - On success: calls `refetch` (FR-015).

---

- [x] **T029** [Ph6] [BROWSER] [P2] `components/budgets-section.tsx` — per-model budget inputs with cross-field advisory
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/budgets-section.tsx
  ```
  **Depends**: T028
  **AC**:
  - Renders one row per model key in `SafeConfigView.usage.budgets`; each row shows model ID + numeric inputs for `dailyLimit` and `weeklyLimit`.
  - Confirm button is **disabled** and an inline validation error is shown if either input contains a non-positive or non-integer value (US4 AC-2).
  - Advisory warning (non-blocking, not disabling) shown in the confirm dialog when `dailyLimit > weeklyLimit` (US4 AC-3 / spec §4.2).
  - On confirm: calls `postBudget` with `{ modelId, dailyLimit, weeklyLimit, expectedRevision: revision }`.
  - On success: calls both `refetch` (config panel) **and** a separate `onBudgetMutated` callback prop to invalidate the `operations-panels` budget gauge data (spec §6.4 integration point — FR-015 / SC-003).

---

- [x] **T030** [Ph6] [BROWSER] [P2] `components/destructive-confirm-dialog.tsx` — two-step typed-phrase confirm dialog
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/destructive-confirm-dialog.tsx
  ```
  **Depends**: T024
  **AC**:
  - Wraps `ConfirmDialog` for Step 1; Step 2 is a separate modal with a `<input type="text">` and the required phrase displayed to the operator.
  - Submit button at Step 2 is **disabled** until `input.value === requiredPhrase` (strict `===`, no `.trim()`, no `.normalize()` — SEC-09 / R-4).
  - Submit button remains disabled for near-matches: wrong case (`"confirm"` vs `"CONFIRM"`), trailing space (`"CONFIRM "`), leading space (`" CONFIRM"`).
  - Submit button enabled **only** on exact character-for-character match.
  - Cancel at Step 2 closes the entire flow; `onConfirm` is never called; re-initiating the flow starts at Step 1.
  - Props: `{ isOpen: boolean; title: string; from: string; to: string; requiredPhrase: string; onConfirm: () => void; onCancel: () => void; isLoading: boolean }`.

---

- [x] **T031** [Ph6] [BROWSER] [P2] `components/workflow-launch-panel.tsx` — workflow selector + gated launch
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/workflow-launch-panel.tsx
  ```
  **Depends**: T030
  **AC**:
  - Renders a radio group or `<select>` for `evolve`|`tasks`|`nightly`.
  - Selecting `tasks` and clicking Launch opens `ConfirmDialog` (non-destructive — plan §3.2).
  - Selecting `evolve` or `nightly` and clicking Launch opens `DestructiveConfirmDialog` with `requiredPhrase` equal to the workflow name in uppercase (e.g., `"EVOLVE"`).
  - Dismissing either dialog without confirming sends **no** network request (US5 AC-3).
  - On confirm: calls `postWorkflowLaunch({ workflow, expectedRevision: revision })`.
  - On success: displays "Workflow launched — Task #`<taskId>`" with an anchor linking to the queue panel entry.
  - On 409 `workflow-conflict`: shows "Workflow already running" inline (US5 AC-2).
  - On daemon unreachable: shows a daemon-unreachable error inline without leaving an orphaned task entry (US5 AC-4).

---

- [x] **T032** [Ph6] [BROWSER] [P2] Browser spec — `destructive-confirm-dialog.browser.spec.tsx`
  ```
  Files:
    ✦ apps/web/src/features/mutations/__tests__/destructive-confirm-dialog.browser.spec.tsx
  ```
  **Depends**: T030
  **AC**:
  - Submit button disabled before any phrase is typed (SC-006).
  - Submit button disabled with wrong case: input `"confirm"`, phrase `"CONFIRM"` → disabled.
  - Submit button disabled with trailing space: input `"CONFIRM "`, phrase `"CONFIRM"` → disabled.
  - Submit button disabled with leading space: input `" CONFIRM"`, phrase `"CONFIRM"` → disabled.
  - Submit button **enabled** only when input equals phrase exactly: `"CONFIRM"` → enabled (SC-006 / SEC-09).
  - Cancel at Step 2: `onConfirm` spy is never called.
  - All cases pass with zero failures.

---

- [x] **T033** [Ph6] [BROWSER] [P2] Browser spec — `workflow-launch-panel.browser.spec.tsx`
  ```
  Files:
    ✦ apps/web/src/features/mutations/__tests__/workflow-launch-panel.browser.spec.tsx
  ```
  **Depends**: T031
  **AC**:
  - Selecting `evolve` and clicking Launch opens `DestructiveConfirmDialog` (not standard `ConfirmDialog`).
  - Selecting `tasks` and clicking Launch opens standard `ConfirmDialog`.
  - Dismissing either dialog (clicking Cancel): `postWorkflowLaunch` mock is never called.
  - Confirming a `tasks` launch with a mocked successful response: task ID is displayed in the panel.
  - All cases pass with zero failures.

---

- [x] **T034** [Ph6] [BROWSER] [P2] Wire `ModelsSection` + `BudgetsSection` into `config-panel.tsx`
  ```
  Files:
    ✎ apps/web/src/features/mutations/components/config-panel.tsx
  ```
  **Depends**: T028, T029, T033
  **AC**:
  - `config-panel.tsx` replaces the Phase 5 stubs with the live `ModelsSection` and `BudgetsSection` components.
  - `BudgetsSection` receives an `onBudgetMutated` callback that invalidates the `operations-panels` budget gauge data source (spec §6.4).
  - All three sections (routing, models, budgets) render correctly from a valid `SafeConfigView` mock.
  - `config-panel.browser.spec.tsx` still passes after this change with no new test failures.
  - `npm run quality` on `apps/web/` exits 0.

---

- [x] **T034a** [Ph6] [BROWSER] [P2] Integration test: config panel live data + budget gauge refresh
  ```
  Files:
    ✦ apps/web/src/features/mutations/__tests__/config-panel-integration.browser.spec.tsx
  ```
  **Depends**: T034
  **AC**:
  - Verify config panel renders live model tier and budget values from a mocked `GET /config/safe` response.
  - Verify that a budget mutation triggers re-fetch of the operations-panels budget gauge via the `onBudgetMutated` callback: mock `postBudget` to resolve successfully, assert that the `onBudgetMutated` callback is called exactly once, and assert that `useSafeConfig().refetch` is called to refresh the config panel.
  - All cases pass with zero failures.

---

## Phase 7 — Browser P3: Audit Trail Panel

> **Track**: BROWSER · **Prerequisite**: Phase 6 (T028–T034) · **Exit gate**: browser specs pass; `npm run quality` on `apps/web/`

---

- [ ] **T035** [Ph7] [BROWSER] [P3] `model/use-audit-page.ts` — cursor-based paginated audit hook
  ```
  Files:
    ✦ apps/web/src/features/mutations/model/use-audit-page.ts
  ```
  **Depends**: T020
  **AC**:
  - Hook signature: `useAuditPage(): { records: MutationAuditRecord[]; isLoading: boolean; hasMore: boolean; loadMore: () => void; error: string | null }`.
  - Fetches first page (`limit: 20`) on mount using `getAudit`.
  - `loadMore` fetches the next page using the `nextCursor` from the previous response and **appends** results to `records` (does not replace — SC-009 / FR-014).
  - `hasMore` is `false` when the last response returned `nextCursor: null`.
  - Calling `loadMore` when `isLoading: true` or `hasMore: false` is a no-op.
  - No `any` types.

---

- [ ] **T036** [Ph7] [BROWSER] [P3] `components/audit-row.tsx` — single audit record row renderer
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/audit-row.tsx
  ```
  **Depends**: T006
  **AC**:
  - Props: `{ record: MutationAuditRecord }`.
  - Renders: actor display name (`operatorId` or raw ID fallback), formatted locale timestamp, event-type badge (colour-coded: `success` outcome → green, `failure` outcome → red), `targetField` in monospace, before/after values (formatted as locale token count for budget events — e.g., `3,000,000`), outcome badge, and `rejectionReason` text when outcome is `failure` (US6 AC-3).
  - Component does not crash when `rejectionReason` is `null`.

---

- [ ] **T037** [Ph7] [BROWSER] [P3] `components/audit-panel.tsx` — paginated audit table with empty state
  ```
  Files:
    ✦ apps/web/src/features/mutations/components/audit-panel.tsx
  ```
  **Depends**: T035, T036
  **AC**:
  - Calls `useAuditPage()` on mount; renders `AuditRow` for each record in the `records` array.
  - Records are displayed in the order returned by the hook (reverse-chronological — FR-006).
  - "Load more" button is **disabled** when `!hasMore || isLoading`.
  - Empty state: when `records.length === 0` and `!isLoading`, renders "No mutations recorded yet." (not a blank element — US6 AC-4).
  - Loading state: renders a loading indicator while `isLoading: true` on the first fetch.

---

- [ ] **T038** [Ph7] [BROWSER] [P3] Browser spec — `audit-panel.browser.spec.tsx`
  ```
  Files:
    ✦ apps/web/src/features/mutations/__tests__/audit-panel.browser.spec.tsx
  ```
  **Depends**: T037
  **AC**:
  - 25 mocked records: first page (20 records) rendered; "Load more" button visible and enabled.
  - Clicking "Load more" with a second-page mock (5 records + `nextCursor: null`): total of 25 records visible; "Load more" button disabled afterwards.
  - Empty records mock: "No mutations recorded yet." message shown (not a blank list).
  - Each rendered row includes: actor text, timestamp text, event-type text, before/after values, outcome badge text.
  - All cases pass with zero failures.
  - `npm run quality` on `apps/web/` exits 0.

---

## Phase 8 — Integration + Quality Gate

> **Track**: INTEGRATION · **Prerequisites**: Phase 4 (T018–T019) + Phase 7 (T035–T038) fully complete · **Exit gate**: all integration tests pass; `npm run quality` exits 0 project-wide

---

- [ ] **T039** [Ph8] [INTEGRATION] [P1] Round-trip integration tests — all six mutation/read endpoints
  ```
  Files:
    ✦ test/integration/web-mutations/round-trip.test.ts  (or equivalent integration test location)
  ```
  **Depends**: T019, T038
  **AC**:
  - One integration test per endpoint (six total), each verifying all three of:
    1. Valid CSRF cookie + header present → 2xx response with schema-validated response body.
    2. Request body forwarded verbatim to the daemon stub (no silent mutation by the gateway layer).
    3. `mutationAuditService.record(...)` is invoked with the correct `eventType` **before** the response is returned to the caller (SEC-06 / SC-004).
  - Tests use an in-process daemon stub (not a real file I/O daemon) to avoid test-environment coupling.
  - All six tests pass with zero failures.

---

- [ ] **T040** [Ph8] [INTEGRATION] [P1] Concurrent optimistic-concurrency determinism test
  ```
  Files:
    ✎ test/integration/web-mutations/round-trip.test.ts  (or a sibling file)
  ```
  **Depends**: T039
  **AC**:
  - Two simultaneous `POST /config/routing/mode` requests carrying the **same** `expectedRevision` are submitted via `Promise.all` against a live or in-process test daemon that uses the `configMutex`.
  - Exactly one request resolves with HTTP 200 and one resolves with HTTP 409.
  - Test is **deterministic**: running it 10 times in succession always produces the same 1-success/1-fail outcome (no flakiness — R-1).

---

- [ ] **T041** [Ph8] [INTEGRATION] [P3] Audit cursor pagination round-trip test
  ```
  Files:
    ✎ test/integration/web-mutations/round-trip.test.ts  (or a sibling file)
  ```
  **Depends**: T040
  **AC**:
  - Test seeds exactly 45 `MutationAuditRecord` entries into the in-process test daemon's mutation audit store.
  - `GET /audit?limit=20` → 20 records returned + non-null `nextCursor`.
  - `GET /audit?limit=20&cursor=<nextCursor>` → 20 records returned + non-null `nextCursor`; no record appears in both this page and the previous page.
  - `GET /audit?limit=20&cursor=<secondCursor>` → exactly 5 records returned + `nextCursor: null`.
  - Total unique records across all three pages = 45.
  - **1,000-record stress test**: seed 1,000 mutation audit entries, cursor-paginate through all 50 pages of 20, verify no records are duplicated or dropped. Total unique records across all 50 pages = 1,000.

---

- [ ] **T042** [Ph8] [ALL] [P1] Project-wide quality gate + ESLint import boundary check
  ```
  Files:
    (no new files — this is a validation-only task)
  ```
  **Depends**: T039, T040, T041
  **AC**:
  - `npm run quality` (covering `lint`, `format:check`, `typecheck`, `lint:cycles`) exits 0 on **all** packages and apps: `packages/web-contracts/`, `apps/web-gateway/`, `apps/web/`, `lib/`.
  - `lint:cycles` reports **zero** circular dependency violations introduced by the new feature (R-6).
  - ESLint boundary rules confirm zero `lib/` imports from any `apps/` or `packages/web*` package (SEC-03).
  - Zero `any` types in any new file (`typecheck` confirms — plan §4.8.2).
  - Each new `lib/*.ts` file has a matching `test/<path>/<name>.test.ts` (new-file test policy — not `__tests__` subdirectories).
  - All new Zod schemas in `packages/web-contracts/` — `SafeConfigView` uses `.strip()` (SC-007).

---

## Summary

### Task counts by phase

| Phase             | Track       | Tasks  | Task IDs                                      |
| ----------------- | ----------- | ------ | --------------------------------------------- |
| 0 — Contracts     | CONTRACTS   | 6      | T001–T006                                     |
| 1 — Daemon P1     | DAEMON      | 4      | T007, T008, T008a, T009                       |
| 2 — Gateway P1    | GATEWAY     | 6      | T010–T012a, T013, T014                        |
| 3 — Daemon P2/P3  | DAEMON      | 4      | T015–T017, T017a                              |
| 4 — Gateway P2/P3 | GATEWAY     | 3      | T018, T019, T019b                             |
| 5 — Browser P1    | BROWSER     | 8      | T020–T027                                     |
| 6 — Browser P2    | BROWSER     | 8      | T028–T034, T034a                              |
| 7 — Browser P3    | BROWSER     | 4      | T035–T038                                     |
| 8 — Integration   | INTEGRATION | 4      | T039–T042                                     |
| **Total**         |             | **49** | T001–T042 + T008a, T012a, T017a, T019b, T034a |

### Task counts by user story

| User Story                   | Priority | Tasks                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------- |
| US1 — Config Read Panel      | P1       | T001–T003, T006–T009, T008a, T010–T014, T012a, T020–T022, T026–T027 |
| US2 — Routing Mode Mutation  | P1       | T001, T006–T009, T008a, T010–T014, T012a, T022, T024–T027           |
| US3 — Model Tier Mutation    | P2       | T002–T004, T015, T017a, T018–T019, T019b, T028, T034, T034a         |
| US4 — Budget Limit Mutation  | P2       | T002–T004, T016, T017a, T018–T019, T019b, T029, T034, T034a         |
| US5 — Workflow Launch        | P2       | T002–T004, T016, T017a, T018–T019, T019b, T031, T033                |
| US6 — Audit Trail Panel      | P3       | T003, T017, T017a, T018–T019, T019b, T035–T038, T041                |
| US7 — Destructive Safeguards | P3       | T030, T032, T033                                                    |

### Dependency graph and parallel execution

```
T001 ─┐
T002 ─┤
      ├─→ T003 ─→ T004 ─→ T005 ─→ T006
                                    │
              ┌─────────────────────┤─────────────────────────┐
              │                     │                          │
     [DAEMON TRACK]       [GATEWAY TRACK]            [BROWSER TRACK]
              │                     │                          │
     T007 ─→ T008         T010 ─┐              T020 ─→ T021 ─┐
     T008a ──┘            T011 ─┤                    T022 ─┤
             T009          T012 ─┤                    T023 ─┤
              │           T012a─┤                    T024 ─┤
              │            T013 ──┴─→ T014              T025 ──┤
              │                                    T025 ──┤
              │                                    T026 ──┤
              │                                    T027 ──┘
              │                                        │
     T015 ─→ T016         T018 ─→ T019          T028 ─→ T029 ─┐
              │                   T019b          T030 ─→ T031 ─┤
             T017                                T032 ─→ T033 ─┤
            T017a                                         T034 ─┤
                                                         T034a─┘
                                                              │
                                                 T035 ─→ T036 ─┐
                                                         T037 ─┤
                                                         T038 ──┘
              │                   │                           │
              └───────────────────┴───────────────────────────┘
                                                              │
                                    T039 ─→ T040 ─→ T041 ─→ T042
```

### Parallel sprint tracks (after Phase 0 completes)

| Sprint       | Daemon                  | Gateway                                                     | Browser                                         |
| ------------ | ----------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| **Sprint A** | T007, T008, T008a, T009 | T010, T011, T012, T012a, T013, T014                         | T020, T021, T022, T023, T024, T025, T026, T027  |
| **Sprint B** | T015, T016, T017, T017a | T018, T019, T019b                                           | T028, T029, T030, T031, T032, T033, T034, T034a |
| **Sprint C** | —                       | —                                                           | T035, T036, T037, T038                          |
| **Sprint D** | T039, T040, T041, T042  | ← requires Sprint B (gateway) + Sprint C (browser) complete |                                                 |

> **Note**: Gateway Phase 4 (T018–T019) depends on Phase 3 daemon (T015–T017) being **complete** (not just stubbed), unlike Phase 2 which used stubs. Do not start T018 until T017 is merged.

### Suggested MVP scope

**MVP = Phase 0 + Phase 1 + Phase 2 + Phase 5** (T001–T027)

This delivers the foundational operator read surface (US1) and the highest-value mutation (US2 — routing mode) end-to-end: contracts → daemon → gateway → browser. It satisfies SC-001 through SC-008 and provides the base on which US3–US7 can ship incrementally per sprint.

**Post-MVP priority order**: US3 model selection (T015, T018, T028, T034) → US4 budgets (T016, T018, T029, T034) → US5 workflow launch (T016, T018, T031–T033) → US6 audit trail (T017–T019, T035–T038) → US7 destructive safeguards (T030, T032, largely done by US5 work).

---

## Risk mitigations quick-reference

| Risk                                    | Mitigation                                                          | Tasks             |
| --------------------------------------- | ------------------------------------------------------------------- | ----------------- |
| R-1: Concurrent mutation race           | In-repo Promise-chain mutex (`mutation-lock.ts`) in daemon          | T008a, T007, T040 |
| R-2: Audit write failure masks mutation | Write config first; audit failure logged, 200 not suppressed        | T008, T013, T014  |
| R-3: SafeConfigView schema drift        | `.strip()` + `superRefine` key-name guard                           | T001, T005        |
| R-4: Typed-phrase bypass                | `===` comparison only, no `.trim()`                                 | T030, T032        |
| R-5: Workflow conflict race             | Same `configMutex` for conflict-check + idempotency dedup + enqueue | T016              |
| R-6: Browser import boundary            | `lint:cycles` as Phase 8 gate                                       | T042              |
