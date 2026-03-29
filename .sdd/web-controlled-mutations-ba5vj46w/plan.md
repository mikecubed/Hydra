# Implementation Plan: Web-Controlled Mutations

**Created**: 2026-03-27
**Spec**: `.sdd/web-controlled-mutations-ba5vj46w/spec.md`
**Branch**: `feat/web-controlled-mutations`
**Phase**: 5 of the Hydra web initiative

---

## 1. Technical Context

| Dimension                    | Decision                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Language**                 | TypeScript, ESM, no build step (`"type": "module"`)                                                                                   |
| **Gateway framework**        | Hono — follow `apps/web-gateway/src/operations/` patterns exactly                                                                     |
| **Browser framework**        | React — follow `apps/web/src/features/operations-panels/` patterns                                                                    |
| **Schema validation**        | Zod — `SafeConfigView` uses `.strip()` (silently remove extra fields); mutation request bodies validated at gateway before forwarding |
| **Testing (gateway/daemon)** | Node `node:test` + `node:assert/strict`                                                                                               |
| **Testing (browser)**        | Vitest browser specs (`*.browser.spec.tsx`)                                                                                           |
| **Auth prerequisite**        | Phase 2 (`web-session-auth`) CSRF double-submit cookie + `useSession` already live                                                    |
| **Daemon port**              | `4173` (existing `lib/orchestrator-daemon.ts`)                                                                                        |
| **Gateway port**             | `4174` (existing gateway)                                                                                                             |
| **Config file**              | `hydra.config.json` — daemon is sole writer; gateway never touches it                                                                 |

### Revision Token Strategy (resolves OQ-1)

Use a **content hash** of the mutable config sections (`routing`, `models`, `usage`) serialised to
a canonical JSON string and hashed with SHA-256 (first 16 hex bytes). This survives daemon restarts
because it is deterministic from the file on disk, not from ephemeral in-memory counters.  
The daemon computes the revision on every `GET /config/safe` response and re-computes after every
successful write. Stale-revision detection in mutation handlers: re-read the config, re-hash, and
compare to the `expectedRevision` in the request body.

### Destructive Action Classification (resolves OQ-2)

| Action                                  | Classified destructive? | Rationale                                                   |
| --------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `POST /workflows/launch` with `evolve`  | **Yes**                 | Multi-round rewrite of agent code; potentially irreversible |
| `POST /workflows/launch` with `nightly` | **Yes**                 | Large batch operations; may clear archived state            |
| `POST /workflows/launch` with `tasks`   | No                      | Bounded discovery run; no destructive side-effects          |
| `POST /config/routing/mode`             | No                      | Reversible at any time                                      |
| `POST /config/models/:agent/active`     | No                      | Reversible at any time                                      |
| `POST /config/usage/budget`             | No                      | Reversible at any time                                      |

The browser feature encodes this classification statically in `workflow-launch-panel.tsx`;
the daemon enforces it independently via a `destructive` flag on the `WorkflowLaunchResponse`.

### Audit Log Persistence Strategy (resolves OQ-3)

Dual-log design:

- **Daemon audit log** (`mutation-audit.jsonl`): append-only JSONL file + in-memory array. Records
  every mutation that reaches the daemon, with before/after values. The daemon owns this log and
  serves it via `GET /audit` (paginated). `totalCount` on `GET /audit` responses is the current
  in-memory array length (available until restart; omitted after restart until a fresh load is
  triggered). The browser audit trail panel reads only this log.
- **Gateway attempt log**: gateway-level rejections (CSRF fail, session fail, validation fail,
  rate-limit) are appended to the existing `AuditStore` in `apps/web-gateway/src/audit/`. No new
  file is needed. These records do not include before/after values and are not surfaced in the
  browser audit trail panel — they are operational logs only.

---

## 2. Project Structure

### Files to **create** (new)

```
packages/web-contracts/src/
  config-mutation.ts                          # Phase 0
  workflow-launch.ts                          # Phase 0
  contracts/config-mutation.ts               # Phase 0
  contracts/workflow-launch.ts               # Phase 0
  contracts/audit-read.ts                    # Phase 0
  __tests__/config-mutation.test.ts          # Phase 0

lib/daemon/
  mutation-routes.ts                          # Phase 1 + Phase 3

apps/web-gateway/src/mutations/
  mutations-routes.ts                         # Phase 2 + Phase 4
  daemon-mutations-client.ts                 # Phase 2
  request-validator.ts                       # Phase 2
  response-translator.ts                     # Phase 2
  __tests__/mutations-routes.test.ts         # Phase 2 + Phase 4
  __tests__/daemon-mutations-client.test.ts  # Phase 2

apps/web/src/features/mutations/
  api/mutations-client.ts                    # Phase 5
  model/use-safe-config.ts                   # Phase 5
  model/use-mutation.ts                      # Phase 5
  model/use-audit-page.ts                    # Phase 7
  components/config-panel.tsx                # Phase 5
  components/routing-section.tsx             # Phase 5
  components/models-section.tsx              # Phase 6
  components/budgets-section.tsx             # Phase 6
  components/confirm-dialog.tsx              # Phase 5
  components/destructive-confirm-dialog.tsx  # Phase 6
  components/workflow-launch-panel.tsx       # Phase 6
  components/audit-panel.tsx                 # Phase 7
  components/audit-row.tsx                   # Phase 7
  components/mutation-error-banner.tsx       # Phase 5
  __tests__/config-panel.browser.spec.tsx    # Phase 5
  __tests__/confirm-dialog.browser.spec.tsx  # Phase 5
  __tests__/destructive-confirm-dialog.browser.spec.tsx  # Phase 6
  __tests__/workflow-launch-panel.browser.spec.tsx       # Phase 6
  __tests__/audit-panel.browser.spec.tsx     # Phase 7
```

### Files to **modify** (existing)

```
packages/web-contracts/src/
  audit-schemas.ts        # Extend AuditEventType + add MutationAuditRecord, AuditPage*
  index.ts                # Re-export all new schemas and contracts

lib/daemon/
  mutation-routes.ts      # Populated across Phase 1 and Phase 3

apps/web-gateway/src/
  index.ts                # Register mutations router via createProtectedRouteGroup (same as operations)
  server-runtime.ts       # Add /mutations and /audit to GATEWAY_ROUTE_PREFIXES
  shared/gateway-error-response.ts  # Add stale-revision, daemon-unavailable, workflow-conflict categories
```

---

## 3. Dependency Order

```
Phase 0: Contracts
    │
    ├─ Phase 1: Daemon P1 ──────────────────────────┐
    │   (GET /config/safe, POST routing/mode)       │
    │                                                │
    ├─ Phase 2: Gateway P1 ─────────────────────────┤ (daemon stubs for tests)
    │   (mutations module scaffold + P1 routes)      │
    │                                                │
    └─ Phase 5: Browser P1 ─────────────────────────┤ (mocked API layer)
        (config panel + routing UI + confirm dialog) │
                                                     │
Phase 3: Daemon P2/P3  ◄──────────────── Phase 1 ───┤
    (model, budget, workflow, audit)                 │
                                                     │
Phase 4: Gateway P2/P3 ◄────── Phase 2 + Phase 3 ──┤
    (model, budget, workflow, audit routes)          │
                                                     │
Phase 6: Browser P2 ◄────────────────── Phase 5 ────┘
    (model section, budget section, workflow launch) │
                                                     │
Phase 7: Browser P3 ◄─────────────────── Phase 6 ──┘
    (audit panel, destructive safeguards)

Phase 8: Integration + Quality Gate ◄── Phases 4 + 7
```

**Parallelisable tracks after Phase 0:**

| Track     | Owner         | Phases  | Can start                                               |
| --------- | ------------- | ------- | ------------------------------------------------------- |
| Contracts | Contracts eng | 0       | Immediately                                             |
| Daemon    | Backend eng   | 1, 3    | After Phase 0                                           |
| Gateway   | Backend eng   | 2, 4    | After Phase 0 (Phase 1 daemon not required — use stubs) |
| Browser   | Frontend eng  | 5, 6, 7 | After Phase 0 (mock API layer; Phase 2 not required)    |

---

## 4. Phases

---

### Phase 0 — Schema Contracts (blocking foundation)

**Track: contracts**  
**Priority stories enabled: all**  
**Exit gate: `npm run quality` passes on `packages/web-contracts/`**

#### 4.0.1 Deliverables

**`packages/web-contracts/src/config-mutation.ts`** (new)

```typescript
// Enums
export const RoutingMode; // z.enum(['economy','balanced','performance'])
export const ModelTier; // z.enum(['default','fast','cheap'])
export const AgentId; // Dynamically derived: built-in physical agents (claude, gemini, codex, local)
// + optional copilot + agents.customAgents[]. Agents without a
// models config entry are excluded from model-tier selection.

// Read shape
export const SafeConfigView; // .strip() — routing.mode, models map, usage.budgets, revision

// Mutation requests
export const RoutingModeMutationRequest; // mode + expectedRevision
export const ModelTierMutationRequest; // tier + expectedRevision
export const BudgetMutationRequest; // modelId + dailyLimit? + weeklyLimit? + expectedRevision

// Mutation response (shared)
export const ConfigMutationResponse; // snapshot: SafeConfigView + appliedRevision + timestamp
```

`SafeConfigView` must use `.strip()`. The schema must explicitly **exclude** any key whose name
contains `apiKey`, `secret`, `hash`, or `password`. Enforce via a Zod `.superRefine()` that walks
the parsed object's keys and rejects any match (guards against future config shape drift).

**`packages/web-contracts/src/workflow-launch.ts`** (new)

```typescript
export const WorkflowName; // z.enum(['evolve','tasks','nightly'])
export const WorkflowLaunchRequest; // workflow + label? + idempotencyKey (UUID) + expectedRevision
export const WorkflowLaunchResponse; // taskId + workflow + launchedAt + destructive: boolean
```

**`packages/web-contracts/src/audit-schemas.ts`** (extended)

Extend the existing `AuditEventType` z.enum with six new values:

- `config.routing.mode.changed`
- `config.models.active.changed`
- `config.usage.budget.changed`
- `workflow.launched`
- `config.mutation.rejected`
- `workflow.launch.rejected`

Add new Zod schemas:

```typescript
export const MutationAuditRecord; // id, timestamp, eventType, operatorId, sessionId,
// targetField, beforeValue, afterValue, outcome,
// rejectionReason (nullable), sourceIp
export const AuditPageRequest; // limit (default 20, max 100) + cursor (optional)
export const AuditPageResponse; // records: MutationAuditRecord[], nextCursor?, totalCount?
```

**`packages/web-contracts/src/contracts/config-mutation.ts`** (new)

Gateway-layer request/response contracts mirroring `operations-control.ts`:

- `GetSafeConfigResponse` — wraps `SafeConfigView`
- `PatchRoutingModeRequest/Response`
- `PatchModelTierRequest/Response` (includes `:agent` path param schema)
- `PatchBudgetRequest/Response`

**`packages/web-contracts/src/contracts/workflow-launch.ts`** (new)

- `PostWorkflowLaunchRequest/Response`

**`packages/web-contracts/src/contracts/audit-read.ts`** (new)

- `GetAuditRequest` (query param schema: `limit`, `cursor`)
- `GetAuditResponse` — wraps `AuditPageResponse`

**`packages/web-contracts/src/__tests__/config-mutation.test.ts`** (new)

Cover all SC-007 requirements:

- `SafeConfigView.parse` rejects objects with extra fields (strict)
- `SafeConfigView.parse` rejects objects with `apiKey`, `secret`, `hash`, `password` keys
- `RoutingModeMutationRequest` rejects unknown mode values
- `ModelTierMutationRequest` rejects unknown tier values
- `BudgetMutationRequest` rejects non-positive and non-integer `dailyLimit`/`weeklyLimit`
- `BudgetMutationRequest` rejects request where both `dailyLimit` and `weeklyLimit` are null

**`packages/web-contracts/src/index.ts`** (extended)

Add re-exports for all new schemas and contract types. Follow the existing block grouping:

```typescript
// Mutation contracts (Phase 5)
export * from './config-mutation.ts';
export * from './workflow-launch.ts';
export * from './contracts/config-mutation.ts';
export * from './contracts/workflow-launch.ts';
export * from './contracts/audit-read.ts';
```

#### 4.0.2 Acceptance criteria

- `SafeConfigView.parse` strips unknown fields and throws on forbidden key names.
- All six new `AuditEventType` values are accepted by the existing `AuditRecord` schema.
- `npm run quality` (lint + typecheck + format:check + lint:cycles) passes with zero new violations.
- Test confirms parsing with extra keys **strips** them (`.strip()` behavior) rather than rejecting.

---

### Phase 1 — Daemon P1: Safe-Read + Routing Mode Mutation

**Track: daemon**  
**Priority stories enabled: US1, US2**  
**Prerequisite: Phase 0**  
**Exit gate: daemon unit tests pass; `npm run quality` on `lib/`**

#### 4.1.1 Deliverables

**`lib/daemon/mutation-routes.ts`** (new — populated incrementally across Phase 1 and Phase 3)

Phase 1 populates:

```
GET  /config/safe
POST /config/routing/mode
```

Key implementation details:

- **In-repo Promise-chain mutex** (`lib/daemon/mutation-lock.ts`): a simple single-writer lock
  implemented as a Promise chain (no external dependency). Avoids adding `async-mutex` to
  `package.json`, consistent with the project's minimal-deps philosophy. Exported as
  `const configMutex` and shared by all mutation handlers. Must be created and tested before
  wiring mutation routes.
- **Revision token**: `computeConfigRevision(config)` — SHA-256 (Node `crypto.createHash`) of
  `JSON.stringify({routing: config.routing, models: config.models, usage: config.usage})`,
  truncated to 32 hex chars.
- **`GET /config/safe`**: Read `hydra.config.json` via `loadHydraConfig()`, project into
  `SafeConfigView` with `.strip()` parse, attach `revision`. Return 200 or 503 on read error.
- **`POST /config/routing/mode`**: Parse body with `RoutingModeMutationRequest`, verify
  `expectedRevision` matches `computeConfigRevision()`, write new routing mode to
  `hydra.config.json` via `writeState` pattern, re-compute revision, append
  `MutationAuditRecord` to mutation audit log, return `ConfigMutationResponse`.
- **Stale revision**: Return `409 Conflict` with body `{ error: 'stale-revision' }`.
- **Optimistic concurrency**: All mutation handlers acquire the in-repo Promise-chain mutex
  (single-writer) so concurrent POST requests do not interleave file reads and writes.

**Register in `lib/orchestrator-daemon.ts`**:

Import and wire `handleMutationRoute` into the HTTP request dispatcher. The mutation-routes
handler MUST be registered **after** `isAuthorized(req)` in the daemon middleware chain,
consistent with how `handleWriteRoute` is wired (after auth, not alongside read-routes which
run before auth).

**`test/daemon/mutation-routes.test.ts`** (new — matches `test/<path>/<name>.test.ts` policy)

- `GET /config/safe` → 200 with `SafeConfigView` shape
- `GET /config/safe` with no config file → 503
- `POST /config/routing/mode` valid body + correct revision → 200 + audit record written
- `POST /config/routing/mode` stale revision → 409
- `POST /config/routing/mode` invalid mode → 400
- `POST /config/routing/mode` missing `expectedRevision` → 400

#### 4.1.2 Acceptance criteria

- Revision token is deterministic: calling `computeConfigRevision` twice on the same config
  object produces the same string.
- After a successful routing-mode mutation, re-reading `GET /config/safe` returns the new mode
  and a new revision token.
- Concurrent routing-mode mutations with the same revision: exactly one succeeds (200), the
  other receives 409.
- In-repo Promise-chain mutex in `lib/daemon/mutation-lock.ts` has a matching test at
  `test/daemon/mutation-lock.test.ts`.

---

### Phase 2 — Gateway P1: Mutations Module Scaffold + Routing Route

**Track: gateway**  
**Priority stories enabled: US1 (gateway side), US2 (gateway side)**  
**Prerequisite: Phase 0** (Phase 1 daemon not required — tests use daemon client stubs)  
**Exit gate: gateway unit tests pass; `npm run quality` on `apps/web-gateway/`**

#### 4.2.1 Deliverables

**`apps/web-gateway/src/mutations/daemon-mutations-client.ts`** (new)

Follows `daemon-operations-client.ts` exactly:

- `DaemonMutationsClient` class, configurable `daemonUrl` and `fetch` (injectable for tests)
- 5-second default timeout
- Methods mirroring each of the six daemon endpoints:
  ```
  getSafeConfig()                       → SafeConfigView | GatewayErrorResponse
  postRoutingMode(body)                 → ConfigMutationResponse | GatewayErrorResponse
  postModelTier(agent, body)            → ConfigMutationResponse | GatewayErrorResponse
  postBudget(body)                      → ConfigMutationResponse | GatewayErrorResponse
  postWorkflowLaunch(body)              → WorkflowLaunchResponse | GatewayErrorResponse
  getAudit(params)                      → AuditPageResponse | GatewayErrorResponse
  ```
- Daemon `4xx` / `5xx` mapped to `GatewayErrorResponse` categories:
  `400 → validation`, `409 → stale-revision`, `503/network → daemon-unavailable`

**`apps/web-gateway/src/mutations/request-validator.ts`** (new)

Zod validation helpers (same pattern as `operations/request-validator.ts`):

- `validateRoutingModeBody(body)` → `RoutingModeMutationRequest | ValidationError`
- `validateModelTierBody(agent, body)` → validates agent path param + `ModelTierMutationRequest`
- `validateBudgetBody(body)` → `BudgetMutationRequest`
- `validateWorkflowLaunchBody(body)` → `WorkflowLaunchRequest`
- `validateAuditParams(query)` → `AuditPageRequest`

**`apps/web-gateway/src/mutations/response-translator.ts`** (new)

Maps `GatewayErrorResponse` categories to HTTP status codes and client-visible messages:

- `stale-revision` → `409` + `"Config has changed — reload and retry"`
- `daemon-unavailable` → `503` + `"Daemon unreachable"`
- `validation` → `400` + forwarded message
- `workflow-conflict` → `409` + `"Workflow already running"`

**`apps/web-gateway/src/mutations/mutations-routes.ts`** (new — Phase 2 routes only)

Hono sub-router. Phase 2 populates:

```
GET  /config/safe
POST /config/routing/mode
```

Middleware stack: auth and CSRF are applied globally by `createProtectedRouteGroup()` in
`apps/web-gateway/src/index.ts` — individual mutation routes do not wire these themselves.
Per mutating route, the route-level stack is:

1. `requestValidator` (400 on schema rejection)
2. `mutatingRateLimiter` (429 on threshold exceeded) — skip for GET
3. Daemon client call
4. Gateway attempt log: on rejection (CSRF fail, session fail, validation fail, rate-limit),
   record to the existing `AuditStore`. On success, the daemon records its own audit entry
   (SEC-06 dual-log model).

Audit write failure: log structured error via gateway logger, do **not** suppress the mutation
response (spec requirement SEC-06: "A failed audit write MUST NOT silently suppress the mutation").

**`apps/web-gateway/src/shared/gateway-error-response.ts`** (modified)

Extend `ErrorCategory` type and `ERROR_CATEGORIES` array with three new categories:

- `stale-revision` — optimistic concurrency conflict (409)
- `daemon-unavailable` — daemon unreachable (503)
- `workflow-conflict` — duplicate workflow launch (409)

**`apps/web-gateway/src/index.ts`** (modified)

Register `mutationsRouter` via `createProtectedRouteGroup()` in `createProtectedRootRoutes()`,
matching the same pattern used by the `operations` module:

```typescript
protectedRootRoutes.route('/', createMutationsRoutes({ daemonClient: mutationsClient }));
```

**`apps/web-gateway/src/server-runtime.ts`** (modified)

Add `/mutations` and `/audit` to `GATEWAY_ROUTE_PREFIXES`. Without this, GET requests to these
routes will be intercepted by the SPA static-file fallback and return HTML.

**`apps/web-gateway/src/mutations/__tests__/mutations-routes.test.ts`** (new — Phase 2 cases)

Daemon client stubbed throughout. Phase 2 cases:

- Valid CSRF + session → daemon client called with correct payload
- Missing CSRF header → `403` before daemon is called
- Expired session → `401` before CSRF check
- `GET /config/safe` authenticated → 200 with `SafeConfigView` shape
- `POST /config/routing/mode` invalid mode → `400` before daemon is called
- `POST /config/routing/mode` stale revision from daemon stub → `409` forwarded
- `POST /config/routing/mode` daemon unavailable stub → `503`
- Successful mutation → gateway attempt log records success; audit write does not suppress response
- Mutation rate limit: 31st request in 60-second window → `429`

**`apps/web-gateway/src/mutations/__tests__/daemon-mutations-client.test.ts`** (new)

- Correct HTTP method and path for each of the six daemon endpoints
- Request body serialisation for `postRoutingMode`, `postModelTier`, `postBudget`
- Daemon `409` → `{ error: 'stale-revision' }` category
- Daemon `503` → `{ error: 'daemon-unavailable' }` category
- Network error → `{ error: 'daemon-unavailable' }` category

#### 4.2.2 Acceptance criteria

- `GET /config/safe` without a session returns `401` (not `503`).
- `POST /config/routing/mode` without CSRF token returns `403` and daemon client is never called.
- Gateway attempt log records one entry per gateway-level rejection (CSRF fail, session fail,
  validation fail, rate-limit). Daemon audit log records durable mutations separately.

---

### Phase 3 — Daemon P2/P3: Model, Budget, Workflow, Audit

**Track: daemon**  
**Priority stories enabled: US3, US4, US5, US6**  
**Prerequisite: Phase 1**  
**Exit gate: daemon unit tests pass; `npm run quality` on `lib/`**

#### 4.3.1 Deliverables

**`lib/daemon/mutation-routes.ts`** (extended)

Add handlers for:

```
POST /config/models/:agent/active
POST /config/usage/budget
POST  /workflows/launch
GET   /audit
```

Implementation notes per handler:

**`POST /config/models/:agent/active`**:

- Path param `agent` validated against known agents with `models` config entries (400 on unknown
  or ineligible agent). Built-in physical agents: `claude`, `gemini`, `codex`, `local`; optional
  `copilot`; plus any `agents.customAgents[]`. Agents without `models` config are excluded.
- `expectedRevision` checked; 409 on stale.
- Write new tier for the named agent into `hydra.config.json` under
  `models[agent].tiers.active` (or equivalent config key).
- Return `ConfigMutationResponse` with updated `SafeConfigView`.
- Append `MutationAuditRecord` with `targetField: 'config.models.<agent>.active'`.

**`POST /config/usage/budget`**:

- Validate: at least one of `dailyLimit`, `weeklyLimit` is non-null; each non-null value is a
  positive integer; `modelId` exists in the current config's usage map (400 on unknown).
- `expectedRevision` checked; 409 on stale.
- Write updated budget values.
- Cross-field advisory only: if `dailyLimit > weeklyLimit` after update, daemon logs a warning
  but persists the change (the gateway surfaces the warning verbatim from the response).
- Append `MutationAuditRecord` with `targetField: 'config.usage.budget.<modelId>'`.

**`POST /workflows/launch`**:

- Validate `workflow` against `WorkflowName` enum (400 on unknown).
- Validate `idempotencyKey` is a valid UUID (400 on missing/invalid). Deduplicate: if a launch
  with the same key was processed within the last 60 seconds, return the existing task ID and
  `WorkflowLaunchResponse` without launching a second instance (FR-009a).
- Check daemon task queue: if a task with the same workflow name is in `running` or `pending`
  state, return `409 Conflict` with `{ error: 'workflow-conflict' }`.
- `expectedRevision` checked for optimistic concurrency.
- Assign a new task ID via `nextId()`.
- Append `MutationAuditRecord` with `eventType: 'workflow.launched'`.
- Enqueue the workflow task. Return `WorkflowLaunchResponse` with `taskId`, `workflow`,
  `launchedAt`, and `destructive: true` if workflow is `evolve` or `nightly`.

**`GET /audit`**:

- Parse `limit` (default 20, max 100) and `cursor` (opaque, optional) from query params.
- Read from the mutation audit store.
- Cursor format: base64-encoded ISO timestamp of the oldest record in the previous page.
- Return `AuditPageResponse` with records in reverse-chronological order,
  `nextCursor` (null if no more records), `totalCount` (current in-memory count).

**`test/daemon/mutation-routes.test.ts`** (extended)

Add cases for Phase 3 handlers:

- `POST /config/models/:agent/active` valid → 200 + correct tier written
- `POST /config/models/:agent/active` unknown agent → 400
- `POST /config/usage/budget` valid → 200
- `POST /config/usage/budget` non-positive `dailyLimit` → 400
- `POST /config/usage/budget` both limits null → 400
- `POST /config/usage/budget` unknown `modelId` → 400
- `POST /workflows/launch` valid `tasks` → 202 + taskId + `destructive: false`
- `POST /workflows/launch` `evolve` → 202 + `destructive: true`
- `POST /workflows/launch` already-running workflow → 409
- `POST /workflows/launch` unknown workflow → 400
- `GET /audit` empty store → 200 + empty records array
- `GET /audit` with cursor → correct page returned

#### 4.3.2 Acceptance criteria

- Workflow launch for `evolve` returns `destructive: true` in the response.
- `GET /audit` returns records newest-first; subsequent cursor request returns older records
  without repeating records from the first page.
- Two concurrent budget mutations with the same `expectedRevision`: exactly one succeeds.

---

### Phase 4 — Gateway P2/P3: Model, Budget, Workflow, Audit Routes

**Track: gateway**  
**Priority stories enabled: US3, US4, US5, US6 (gateway side)**  
**Prerequisites: Phase 2 + Phase 3**  
**Exit gate: gateway unit tests pass; `npm run quality` on `apps/web-gateway/`**

#### 4.4.1 Deliverables

**`apps/web-gateway/src/mutations/mutations-routes.ts`** (extended)

Add routes:

```
POST /config/models/:agent/active
POST /config/usage/budget
POST  /workflows/launch
GET   /audit
```

`POST /workflows/launch` uses the same middleware stack as other mutating routes. When daemon
returns `destructive: true` in the response body, the gateway passes it through transparently —
the browser decides whether to show the two-step dialog.

`GET /audit` does not require CSRF; it does require a valid session.

**`apps/web-gateway/src/mutations/__tests__/mutations-routes.test.ts`** (extended)

Add Phase 4 cases (daemon client stubbed):

- `POST /config/models/:agent/active` unknown agent in path → `400`
- `POST /config/models/:agent/active` valid → `200`
- `POST /config/usage/budget` non-positive value → `400`
- `POST /workflows/launch` unknown workflow → `400`
- `POST /workflows/launch` daemon returns workflow-conflict → `409`
- `POST /workflows/launch` no CSRF → `403` before daemon called
- `GET /audit` unauthenticated → `401`
- `GET /audit` with `limit=5&cursor=<opaque>` → daemon called with correct params
- `GET /audit` daemon unavailable → `503`

#### 4.4.2 Acceptance criteria

- All six mutation/audit/read routes are live under `/mutations/`.
- `POST /workflows/launch` with a destructive workflow responds `202` + `{ destructive: true }`.
- `GET /audit` without session returns `401`.

---

### Phase 5 — Browser P1: Config Read Panel + Routing Mutation UI

**Track: browser**  
**Priority stories enabled: US1, US2**  
**Prerequisite: Phase 0** (uses mocked API layer — Phase 2 gateway not required for browser dev)  
**Exit gate: browser specs pass; `npm run quality` on `apps/web/`**

#### 4.5.1 Deliverables

**`apps/web/src/features/mutations/api/mutations-client.ts`** (new)

Typed `fetch` wrappers for all six gateway endpoints. Injects `X-CSRF-Token` from the
`__csrf` cookie (follow the pattern established in Phase 2/4a browser features).
Returns typed success or error union — no `any` escapes.

```typescript
export function createMutationsClient(baseUrl: string): MutationsClient;
// Methods: getSafeConfig, postRoutingMode, postModelTier, postBudget,
//          postWorkflowLaunch, getAudit
```

**`apps/web/src/features/mutations/model/use-safe-config.ts`** (new)

```typescript
export function useSafeConfig(): {
  config: SafeConfigView | null;
  revision: string | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
};
```

Fetches on mount; exposes `refetch` for post-mutation invalidation. Does not auto-poll
(mutations trigger explicit refetches).

**`apps/web/src/features/mutations/model/use-mutation.ts`** (new)

Generic hook for all config mutations:

```typescript
export function useMutation<TRequest, TResponse>(
  mutationFn: (body: TRequest) => Promise<TResponse | GatewayError>,
): {
  mutate: (body: TRequest) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  reset: () => void;
};
```

On success: calls optional `onSuccess` callback (used to trigger `refetch` in config panel).
On error: sets `error` string; `reset()` clears it.

**`apps/web/src/features/mutations/components/mutation-error-banner.tsx`** (new)

Dismissible inline error banner. Props: `message: string | null`, `onDismiss: () => void`.
Renders nothing when `message` is null.

**`apps/web/src/features/mutations/components/confirm-dialog.tsx`** (new)

Reusable single-step confirm dialog:

```
Props: {
  isOpen: boolean;
  title: string;
  from: string;          // current value summary
  to: string;            // new value summary
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}
```

Confirm button disabled while `isLoading`. Cancel immediately closes without side effects.

**`apps/web/src/features/mutations/components/routing-section.tsx`** (new)

Displays current routing mode as a badge. Shows a `<select>` with the three mode values.
Disables the selector and shows a spinner while a mutation is in-flight.
On selection change (when value differs from current): opens `ConfirmDialog`.
On dialog confirm: calls `useMutation(postRoutingMode)`, passes `revision` from
`useSafeConfig`, calls `refetch` on success.

**`apps/web/src/features/mutations/components/config-panel.tsx`** (new)

Top-level panel that:

1. Calls `useSafeConfig()` to load config.
2. Renders `RoutingSection` (Phase 5), `ModelsSection` (Phase 6), `BudgetsSection` (Phase 6).
3. Shows `MutationErrorBanner` for top-level errors.
4. Shows "Config unavailable — daemon unreachable" on 503.
5. Redirects to login on 401 (deferred to `useSession` guard).

Phase 5 renders `RoutingSection` with stubs for `ModelsSection` and `BudgetsSection`.

**`apps/web/src/features/mutations/__tests__/config-panel.browser.spec.tsx`** (new)

- Renders routing, models, and budget sections from a mocked `SafeConfigView`.
- No rendered text contains the substrings `key`, `secret`, `hash`, or `password` (SC-010).
- Shows "daemon unreachable" message on 503 mock.

**`apps/web/src/features/mutations/__tests__/confirm-dialog.browser.spec.tsx`** (new)

- Cancel does not call `onConfirm`.
- Confirm calls `onConfirm` exactly once.
- Confirm button disabled when `isLoading=true`.
- Dialog renders `from` and `to` values in its body.

#### 4.5.2 Acceptance criteria

- Config panel renders without crashing on a valid `SafeConfigView` mock.
- No secret-adjacent field names appear in rendered output (SC-010 check in browser spec).
- Routing section: selecting the current mode does not open the confirm dialog.
- Routing section: confirm dialog cancel sends no network request.

#### 4.5.3 Entry-point wiring

The `ConfigPanel` component must be rendered in an existing entry point. The natural home is as
a new tab or section within the existing
`apps/web/src/features/operations-panels/components/workspace-operations-panel.tsx`. This avoids
creating a new top-level route and integrates config mutations alongside the existing operations
controls. An explicit wiring task in Phase 6 (when `ModelsSection` and `BudgetsSection` are live)
ensures the `MutationsPanel` is rendered in the workspace layout. The `onBudgetMutated` callback
must trigger a re-fetch of the operations-panels budget gauge data.

---

### Phase 6 — Browser P2: Model, Budget, Workflow Launch UI

**Track: browser**  
**Priority stories enabled: US3, US4, US5, partial US7**  
**Prerequisite: Phase 5**  
**Exit gate: browser specs pass; `npm run quality` on `apps/web/`**

#### 4.6.1 Deliverables

**`apps/web/src/features/mutations/components/models-section.tsx`** (new)

Per-agent tier selector row for agents with `models` config entries (typically `gemini`, `codex`,
`claude`; agents like `local`, `copilot`, and custom `cli`-type agents without `models` config
are shown as read-only). Each row:

- Displays agent name and current tier.
- `<select>` for `default`|`fast`|`cheap`.
- Confirm button disabled if selected tier equals current tier (US3 AC-2).
- On confirm: calls `postModelTier` with `agent` and new `tier` + `revision`.
- On stale-revision error: shows non-blocking toast (distinct from blocking error banner).
- On success: calls `refetch`.

**`apps/web/src/features/mutations/components/budgets-section.tsx`** (new)

Per-model budget row (one row per model key in `SafeConfigView.usage.budgets`):

- Numeric input for `dailyLimit` and `weeklyLimit`.
- Inline validation: disables confirm button on non-positive or non-integer values.
- Advisory warning (not blocking) when `dailyLimit > weeklyLimit` (US4 AC-3).
- On confirm: calls `postBudget` with `modelId`, limits, and `revision`.
- On success: calls both `refetch` (config panel) and a separate callback to invalidate
  the `operations-panels` budget gauge (integration point per spec §6.4).

**`apps/web/src/features/mutations/components/destructive-confirm-dialog.tsx`** (new)

Two-step confirm wrapper. Step 1: wraps `ConfirmDialog` as-is.
Step 2: modal with a text input and the required phrase displayed:

- Submit button disabled until `input.value === requiredPhrase` (strict equality, SEC-09).
- Near-match (`"confirm"` vs `"CONFIRM"`, trailing space) keeps button disabled.
- Cancel at step 2 closes the entire flow; no request is sent.
- Re-initiating the flow starts at step 1.

**`apps/web/src/features/mutations/components/workflow-launch-panel.tsx`** (new)

- Radio group or `<select>` for `evolve`|`tasks`|`nightly`.
- Launch button → opens `ConfirmDialog` for `tasks` or `DestructiveConfirmDialog` for
  `evolve` and `nightly` (hardcoded destructive set, SEC-09).
- On confirm (or typed-phrase confirm): calls `postWorkflowLaunch`.
- On success: displays "Workflow launched — Task #`<taskId>`" with link to queue panel.
- On `409 workflow-conflict`: shows "Workflow already running" inline.
- On dismiss without confirm: no request sent (US5 AC-3).

**`apps/web/src/features/mutations/__tests__/destructive-confirm-dialog.browser.spec.tsx`** (new)

- Submit button disabled before phrase is typed (SC-006).
- Submit button disabled with wrong case (`"confirm"` vs `"CONFIRM"`).
- Submit button disabled with trailing space (`"CONFIRM "`).
- Submit button enabled on exact match only.
- Cancel at step 2: `onConfirm` never called.

**`apps/web/src/features/mutations/__tests__/workflow-launch-panel.browser.spec.tsx`** (new)

- `evolve` selection opens `DestructiveConfirmDialog`.
- `tasks` selection opens standard `ConfirmDialog`.
- Dismissing dialog: no request sent.
- Successful launch: task ID displayed.

#### 4.6.2 Acceptance criteria

- Model tier selector: selecting already-active tier keeps confirm button disabled.
- Budget input: non-integer value keeps confirm button disabled and shows inline error.
- `evolve` workflow launch shows the two-step typed-phrase dialog (not single-step confirm).
- Typed-phrase confirmation: `"CONFIRM"` enables submit; `"confirm"` does not.

---

### Phase 7 — Browser P3: Audit Trail Panel

**Track: browser**  
**Priority stories enabled: US6, US7 (audit visibility)**  
**Prerequisite: Phase 6**  
**Exit gate: browser specs pass; `npm run quality` on `apps/web/`**

#### 4.7.1 Deliverables

**`apps/web/src/features/mutations/model/use-audit-page.ts`** (new)

Cursor-based paginated audit hook:

```typescript
export function useAuditPage(): {
  records: MutationAuditRecord[];
  isLoading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
};
```

`loadMore` appends the next page to `records` using the `nextCursor` from the previous
response. Does not lose the current page (append-only, not replace).

**`apps/web/src/features/mutations/components/audit-row.tsx`** (new)

Single audit record row:

- Actor display name (`operatorId` resolved to display name if available, else raw ID)
- Timestamp (formatted locale string)
- Event type badge (colour-coded: `success` green, `failure` red)
- `targetField` as monospace label
- Before/after values (formatted as token counts for budget events)
- Outcome badge + rejection reason (if failure)

**`apps/web/src/features/mutations/components/audit-panel.tsx`** (new)

Paginated audit table:

- Calls `useAuditPage()`.
- Renders `AuditRow` for each record.
- "Load more" button disabled when `!hasMore` or `isLoading`.
- Empty state: "No mutations recorded yet." when records array is empty (US6 AC-4).

**`apps/web/src/features/mutations/__tests__/audit-panel.browser.spec.tsx`** (new)

- 25 mocked records → first 20 rendered, "Load more" visible.
- "Load more" fetches next cursor and appends records (total 25 visible after second fetch).
- Empty records array → empty state message shown, not a blank element.
- Each row shows actor, timestamp, event type, before/after, and outcome.

#### 4.7.2 Acceptance criteria

- Audit panel renders 20 records on first load.
- "Load more" appends without replacing; total grows to full count.
- Empty state message shown when records is empty.
- Failed mutation row shows rejection reason text.

---

### Phase 8 — Integration + Quality Gate

**All tracks**  
**Prerequisites: Phase 4 (full gateway) + Phase 7 (full browser)**  
**Exit gate: `npm run quality` passes project-wide; all integration tests pass**

#### 4.8.1 Integration tests

**Gateway → daemon stub (full round-trip)**

For each of the six mutation/read endpoints, one integration test verifying:

1. CSRF cookie + header present → 2xx + correct response shape
2. Body forwarded verbatim to daemon (no mutation by gateway)
3. Audit service is invoked with correct `eventType` before response is sent

**Concurrent optimistic-concurrency test**

Two simultaneous `POST /config/routing/mode` requests, both carrying the same
`expectedRevision`. Verify exactly one receives 200 and one receives 409. Must be deterministic
(serialize with `Promise.all` against a live or in-process test daemon).

**Audit cursor pagination round-trip**

Seed 45 `MutationAuditRecord` entries in the test daemon's mutation audit store.
Call `GET /audit?limit=20` → verify 20 records + non-null `nextCursor`.
Call `GET /audit?limit=20&cursor=<nextCursor>` → verify 20 records + non-null `nextCursor`.
Call `GET /audit?limit=20&cursor=<secondCursor>` → verify 5 records + null `nextCursor`.
No records appear in more than one page.

#### 4.8.2 Quality gate checklist

- [ ] `npm run quality` exits 0 on all packages and apps
- [ ] `npm run quality` covers: `lint`, `format:check`, `typecheck`, `lint:cycles`
- [ ] No `lib/` imports from any `apps/` or `packages/web*` package (ESLint boundary rules)
- [ ] No `any` types in new files (`typecheck` enforces)
- [ ] Each new `lib/*.ts` file has a matching `test/<path>/<name>.test.ts` (new-file test policy)
- [ ] All new Zod schemas in `packages/web-contracts/` pass strip-on-parse test for `SafeConfigView`
- [ ] SC-004: zero mutations applied without a `MutationAuditRecord` entry (covered by
      integration tests)
- [ ] SC-007: `SafeConfigView` uses `.strip()` and test asserts extra fields are stripped
- [ ] SC-008: `npm run quality` passes project-wide

---

## 5. Risk Areas

### R-1 — Optimistic Concurrency Race (HIGH)

**Risk**: Two concurrent mutation requests with the same `expectedRevision` both succeed because
the daemon reads the config file, starts processing, and both reads complete before either write.

**Mitigation**: In-repo Promise-chain mutex in `lib/daemon/mutation-lock.ts` (single-writer lock
per mutation handler, no external dependency). All POST mutation and workflow-launch handlers
acquire the lock before reading the config. The lock is held for the read-hash-write-audit cycle
only, not the entire HTTP connection.

**Test coverage**: Phase 1 exit gate includes the two-concurrent-mutation determinism test.

---

### R-2 — Audit Write Failure Masking Mutation (MEDIUM)

**Risk**: The mutation succeeds (config written) but the audit write fails (file error).
The operator cannot tell the mutation happened.

**Mitigation**: Mutation handlers write config first, then audit. Audit failure is logged as a
structured error but does NOT roll back the mutation or suppress the 200 response (SEC-06).
The gateway also writes its own audit record (SEC-06: "A failed audit write MUST NOT silently
suppress the mutation"). The gateway audit is independent of the daemon audit.

**Test coverage**: Phase 2 route test: mock audit service to throw; verify 200 is still
returned and the error is present in the structured log (spy on logger).

---

### R-3 — SafeConfigView Schema Drift (MEDIUM)

**Risk**: A future change to `hydra.config.json` adds a field with a name like `apiKey` or
`secretToken` to the mutable sections. The `SafeConfigView` schema permits it through if the
superRefine key-name guard is not in place.

**Mitigation**: `SafeConfigView` uses `.strip()` (extra fields silently removed) plus a
`.superRefine()` that walks all keys recursively and rejects any matching `/(key|secret|hash|password)/i`.
Phase 0 test SC-010 asserts this guard is live.

---

### R-4 — Destructive Typed-Phrase Bypass (LOW)

**Risk**: A bug in `DestructiveConfirmDialog` allows submission before the phrase matches
(e.g., a whitespace-trimmed comparison or Unicode normalisation).

**Mitigation**: Phrase check uses `===` (strict identity, no `.trim()`, no `.normalize()`).
Phase 6 browser spec tests exact match, wrong case, trailing space, and leading space — all
must keep the button disabled.

---

### R-5 — Workflow Launch Conflict Race (LOW)

**Risk**: Two operators launch the same workflow concurrently. Both pass the "already running"
check before either enqueues the task.

**Mitigation**: The same in-repo Promise-chain mutex used for config mutations (R-1) is acquired by
`POST /workflows/launch`. The conflict check + idempotency dedup + enqueue cycle is inside the lock.

---

### R-6 — Browser Import Boundary Violation (LOW)

**Risk**: A browser component imports directly from `lib/` (e.g., `lib/hydra-config.ts`),
violating the ESLint boundary rule and coupling the browser bundle to Node-only code.

**Mitigation**: ESLint boundary rule already enforced in `eslint.config.mjs`. Phase 8
quality gate runs `lint:cycles` which will surface any cross-boundary import. No manual
remediation required — the lint step is the gate.

---

## 6. Validation Gates

| Phase | Gate                                                | Check                                       |
| ----- | --------------------------------------------------- | ------------------------------------------- |
| 0     | `npm run quality` on `packages/web-contracts/`      | Lint, typecheck, format, cycles             |
| 0     | `config-mutation.test.ts` pass                      | `.strip()` + forbidden key guards           |
| 1     | Daemon unit tests pass                              | All P1 handler cases                        |
| 1     | Concurrent mutation determinism                     | One 200, one 409 guaranteed                 |
| 1     | `mutation-lock.test.ts` pass                        | In-repo mutex correctness                   |
| 2     | Gateway unit tests pass                             | All P1 route + client cases                 |
| 2     | `npm run quality` on `apps/web-gateway/`            | Lint, typecheck                             |
| 3     | Daemon unit tests pass                              | All P2/P3 handler cases                     |
| 3     | `npm run quality` on `lib/`                         | 0 TS errors, 0 lint errors for new handlers |
| 4     | Gateway unit tests pass                             | All P2/P3 route cases                       |
| 5     | Browser specs pass                                  | P1 component specs                          |
| 5     | SC-010 assertion in `config-panel.browser.spec.tsx` | No secret-adjacent text rendered            |
| 6     | Browser specs pass                                  | P2 + destructive dialog specs               |
| 6     | Typed-phrase spec: near-match disabled              | SEC-09 verified                             |
| 7     | Browser specs pass                                  | Audit panel specs                           |
| 8     | `npm run quality` exits 0 project-wide              | All lint, typecheck, format, cycles         |
| 8     | Integration tests pass                              | Round-trips, concurrency, pagination        |

---

## 7. Track Assignment Summary

| Track           | Phases                    | Can parallelise with                                              |
| --------------- | ------------------------- | ----------------------------------------------------------------- |
| **Contracts**   | Phase 0                   | — (must land first)                                               |
| **Daemon**      | Phase 1, Phase 3          | Gateway Phase 2 (stubs); Browser Phase 5–7 (mocks)                |
| **Gateway**     | Phase 2, Phase 4          | Daemon Phase 3 (stubs in Phase 2; real daemon needed for Phase 4) |
| **Browser**     | Phase 5, Phase 6, Phase 7 | Daemon + Gateway (mocked API layer throughout)                    |
| **Integration** | Phase 8                   | — (requires Phase 4 + Phase 7 both complete)                      |

Recommended parallel execution after Phase 0:

- **Sprint A**: Daemon Phase 1 ‖ Gateway Phase 2 ‖ Browser Phase 5
- **Sprint B**: Daemon Phase 3 ‖ Gateway Phase 4 ‖ Browser Phase 6
- **Sprint C**: Browser Phase 7 → Phase 8

---

## 8. Next Steps

1. **Generate task list** — run `/sdd.tasks` against this plan.
2. **Resolve Open Questions** before coding begins:
   - Confirm `evolve` + `nightly` are the complete destructive workflow set (OQ-2).
   - Confirm `mutation-audit.jsonl` as the mutation audit persistence filename (OQ-3).
3. **Branch**: all work on `feat/web-controlled-mutations`; each phase merges to `main`
   independently after its exit gate passes.
