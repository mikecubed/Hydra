# Feature Specification: Web-Controlled Mutations

**Created**: 2026-03-27
**Status**: Draft
**Feature directory**: `.sdd/web-controlled-mutations-ba5vj46w/`
**Branch**: `feat/web-controlled-mutations`
**Phase**: 4 of the Hydra web initiative

---

## 1. Feature Description

`web-controlled-mutations` adds a browser-side surface through which authenticated operators can
safely mutate Hydra's runtime configuration and trigger operational workflows — all mediated through
daemon-owned APIs that enforce mandatory confirmation gates, CSRF protection, optimistic-concurrency
checks, and a persistent audit trail.

No prior web phase exposed mutation surfaces. Every write originates in the browser, passes through
the authenticated gateway (which enforces CSRF validation, rate limiting, and session binding), is
forwarded to the daemon, and is only applied if the daemon's own validation succeeds. The gateway
never writes configuration directly.

### Goals

1. Give operators a structured, read-safe view of the mutable subset of runtime configuration.
2. Allow targeted, confirmed mutations to routing mode, active model tiers, and token budget limits.
3. Provide a gated surface for launching named daemon workflows.
4. Surface a paginated, immutable audit trail of all mutations and workflow launches.
5. Enforce two-step typed confirmation for any action with irreversible or large-blast-radius effects.

### Relationship to Preceding Phases

| Phase | Spec                                 | Provides for this phase                                   |
| ----- | ------------------------------------ | --------------------------------------------------------- |
| 1     | `web-repl-foundation`                | Package layout, `web-contracts`, gateway scaffolding      |
| 2     | `web-session-auth`                   | Auth, CSRF double-submit, `useSession`, `SessionProvider` |
| 3     | `web-conversation-protocol`          | Zod contract patterns                                     |
| 3b    | `web-gateway-conversation-transport` | Gateway Hono patterns, daemon-client pattern              |
| 4a    | `web-chat-workspace`                 | Composer, approval flow UI patterns                       |
| 4b    | `web-hydra-operations-panels`        | Task queue, routing/mode/model/budget panels (read-only)  |
| **5** | **this spec**                        | Config mutations, workflow launch, audit trail            |

---

## 2. User Scenarios & Testing

### User Story 1 — Config Read Panel (Priority: P1)

An authenticated operator opens the operations panel and sees a structured, read-only view of the
currently active config: global routing mode, each agent's active model tier, and the daily/weekly
token budget limits. No secrets, API keys, or internal implementation details appear.

**Why this priority**: Every mutation surface depends on first showing the operator the current
state they are about to change. This story is the foundational read that makes US2–US4 safe.

**Independent Test**: Render the config panel with a mocked `GET /config/safe` response; verify all
three sections (routing, models, budgets) display correct values and no secret data is present.

**Acceptance Scenarios**:

1. **Given** an authenticated session and a responsive daemon, **When** the operator opens the
   config panel, **Then** the routing mode, each agent's active tier (`default`|`fast`|`cheap`),
   and daily/weekly budget limits are displayed and no API key or hashed credential appears in any
   visible field.

2. **Given** the daemon returns a `503`, **When** the panel attempts to load, **Then** a
   "Config unavailable — daemon unreachable" message is shown and no stale data is rendered.

3. **Given** the operator has no active session, **When** the config panel URL is accessed directly,
   **Then** the operator is redirected to the login surface without revealing config data.

---

### User Story 2 — Routing Mode Mutation (Priority: P1)

An operator selects a new global routing mode (`economy`|`balanced`|`performance`) from a control
in the config panel. A confirm dialog shows the current mode and the new mode. The operator
confirms, and the panel immediately reflects the new mode after a successful daemon acknowledgement.

**Why this priority**: Routing mode affects every in-flight and future task. A safe, confirmed
mutation path is the highest-value write operation in this phase.

**Independent Test**: Submit a `PATCH /config/routing/mode` with valid CSRF headers and a known
session; verify the daemon receives the correct payload and the panel reflects the acknowledged mode.

**Acceptance Scenarios**:

1. **Given** the current routing mode is `balanced` and the operator selects `economy`,
   **When** the confirm dialog is submitted, **Then** the gateway forwards a CSRF-verified
   `PATCH /config/routing/mode` to the daemon, the daemon persists the change, and the panel
   refreshes to show `economy` as the active mode.

2. **Given** the operator opens the confirm dialog but clicks Cancel, **When** the dialog closes,
   **Then** no request is sent to the gateway and the panel remains unchanged.

3. **Given** the daemon rejects the mutation (e.g., stale revision), **When** the confirm dialog
   submission resolves, **Then** an inline error banner explains the rejection and the panel
   reloads the current state.

4. **Given** the operator submits without a valid CSRF token (e.g., expired cookie),
   **When** the gateway receives the request, **Then** the gateway returns `403 Forbidden` and
   the panel surface shows a "Session expired — please refresh" message.

---

### User Story 3 — Active Model Selection per Agent (Priority: P2)

An operator selects a model tier (`default`|`fast`|`cheap`) for a named agent (`gemini`, `codex`,
`claude`) via a dropdown in the config panel. A confirm dialog shows the agent name, the current
tier, and the new tier before submission.

**Why this priority**: Model tier selection directly affects cost and quality of agent responses.
It must be explicit and confirmed but is less globally impactful than routing mode.

**Independent Test**: Render the model tier selector with a mocked agent list; submit a tier
change for `claude` and verify the `PATCH /config/models/claude/active` request is formed with
the correct body and CSRF headers.

**Acceptance Scenarios**:

1. **Given** `claude` is on `default` tier, **When** the operator selects `fast` and confirms,
   **Then** `PATCH /config/models/claude/active` is sent with `{"tier":"fast","expectedRevision":"<token>"}`,
   the daemon persists the change, and the panel reflects `fast` for `claude`.

2. **Given** the operator tries to select the tier that is already active, **Then** the confirm
   button is disabled and no request is sent.

3. **Given** the daemon responds with a stale-revision error, **When** the mutation is rejected,
   **Then** the panel reloads the current config and presents a non-blocking toast explaining
   the conflict.

---

### User Story 4 — Budget Limit Mutation (Priority: P2)

An operator adjusts the daily or weekly token budget for a specific model identifier via a numeric
input in the config panel. A confirm dialog shows current and new values. On acceptance, the
operations panel's budget gauges update to reflect the new limits immediately.

**Why this priority**: Budget limits directly control cost and safety of sustained operation.
Mutations must be confirmed and immediately visible across all budget-display surfaces.

**Independent Test**: Submit a budget mutation for `claude-opus-4-6` daily limit; verify
`PATCH /config/usage/budget` receives the correct model key and new limit value; verify the
operations panel budget gauge refetches and reflects the updated ceiling.

**Acceptance Scenarios**:

1. **Given** the daily budget for `claude-opus-4-6` is `5_000_000`, **When** the operator
   sets it to `3_000_000` and confirms, **Then** `PATCH /config/usage/budget` is sent, the daemon
   persists the change, and both the config panel and the operations-panel budget gauge show the
   new limit.

2. **Given** the operator enters a non-positive or non-integer value, **When** the input is
   validated, **Then** the confirm button remains disabled and an inline error message is shown.

3. **Given** the operator sets a daily budget value higher than the corresponding weekly budget,
   **When** the confirm dialog renders, **Then** a warning is displayed noting the inconsistency,
   but submission is not blocked (the daemon enforces its own cross-field rules).

---

### User Story 5 — Workflow Launch (Priority: P2)

An operator selects a named workflow (`evolve`|`tasks`|`nightly`) from a launch panel and triggers
it through an approval-gated surface. The daemon assigns a task ID and the task appears in the
work queue panel.

**Why this priority**: Workflow launch has significant operational impact. The approval gate
ensures intent; the task-ID linkage ensures the operator can track progress in the existing queue
panel.

**Independent Test**: Submit `POST /workflows/launch` with workflow `tasks` and valid session/CSRF;
verify the gateway forwards to the daemon, the daemon returns a `taskId`, and the launch panel
displays the task ID with a link to the queue entry.

**Acceptance Scenarios**:

1. **Given** a valid session and CSRF token, **When** the operator selects `evolve`, clicks
   Launch, and confirms in the approval dialog, **Then** `POST /workflows/launch` is sent with
   `{"workflow":"evolve"}`, the daemon returns a task ID, and the launch surface displays
   "Workflow launched — Task #<id>".

2. **Given** a workflow is already active in the daemon task queue, **When** the operator attempts
   to launch the same workflow, **Then** the gateway or daemon returns a conflict response and the
   launch surface shows "Workflow already running".

3. **Given** the operator dismisses the approval dialog without confirming, **Then** no request
   is sent.

4. **Given** the daemon is unreachable, **When** the launch request is sent, **Then** the launch
   panel shows a daemon-unreachable error without leaving an orphaned task in the queue.

---

### User Story 6 — Audit Trail Panel (Priority: P3)

An operator opens the audit trail panel and views a paginated log of all mutations and workflow
launches performed through the web surface. Each entry shows: actor (operator display name),
timestamp, event type, before-value, after-value, and outcome (`success`|`failure`).

**Why this priority**: Auditability is a compliance and operational safety requirement. It is
lower priority than mutation surfaces because it reads existing records rather than enabling
new operations.

**Independent Test**: Mount the audit panel with a mocked paginated `GET /audit` response
containing 25 entries; verify the first page renders 20 entries, the next-page button loads
more, and each row shows actor, timestamp, event type, before/after, and outcome.

**Acceptance Scenarios**:

1. **Given** 45 audit records exist, **When** the operator opens the audit panel, **Then** the
   first 20 records are displayed in reverse-chronological order and a "Load more" control
   enables fetching subsequent pages.

2. **Given** an audit entry records a budget mutation, **When** the row is rendered, **Then**
   the before-value and after-value for the affected budget key are both visible and formatted
   as token counts.

3. **Given** an audit entry records a failed mutation attempt, **When** the row is rendered,
   **Then** the outcome indicator shows `failure` and the detail column shows the rejection reason.

4. **Given** no mutations have been performed yet, **When** the panel opens, **Then** an empty
   state message is shown rather than a blank list.

---

### User Story 7 — Destructive Action Safeguards (Priority: P3)

Any mutation or workflow launch that the daemon classifies as destructive (irreversible, or with
potential to clear persistent state such as budget history or agent context) requires a two-step
confirmation: a standard confirm dialog followed by a typed-confirmation input where the operator
must type a specific phrase (e.g., the workflow name or "CONFIRM") before the submit button
becomes enabled.

**Why this priority**: A mistaken destructive action cannot be undone. The two-step gate raises
the operator's conscious intent bar above what a single click can provide.

**Independent Test**: Render the destructive-action confirmation surface for a destructive
workflow; verify the submit button remains disabled until the exact typed phrase matches;
verify a near-match (e.g., "confirm" vs "CONFIRM") does not enable submission.

**Acceptance Scenarios**:

1. **Given** the operator initiates a destructive workflow launch, **When** the first confirm
   dialog is accepted, **Then** a second dialog appears with an input field and the required
   phrase displayed; the submit button remains disabled until the phrase matches exactly.

2. **Given** the operator types the correct phrase in the typed-confirmation input,
   **When** the input value equals the required phrase, **Then** the submit button becomes
   enabled and can be activated.

3. **Given** the typed phrase is a case-insensitive or whitespace-padded near-match,
   **When** the submit button state is evaluated, **Then** the button remains disabled.

4. **Given** the operator cancels at the typed-confirmation step, **When** the dialog is
   dismissed, **Then** no request is sent and neither step is re-entered without explicitly
   re-initiating the flow.

---

### Edge Cases

- What happens when two operators submit conflicting mutations concurrently? → The daemon's
  optimistic-concurrency revision token causes the second submission to receive a `409 Conflict`
  stale-revision response. The losing panel reloads the current config.
- What happens when the config file on disk is modified externally while the panel is open?
  → The next `GET /config/safe` poll or post-mutation refresh reflects the external change.
  No silent merge occurs.
- What if a named workflow (`evolve`, `tasks`, `nightly`) does not exist in the daemon?
  → The daemon returns a `404 Not Found` and the launch surface shows an inline error.
- What if a budget mutation results in a value that would immediately exceed current usage?
  → The daemon enforces its own budget-check rules. The gateway surfaces the rejection message
  verbatim (sanitized); no client-side enforcement of this rule is required.
- What if the CSRF cookie is absent (not just expired) on a mutation submission? → The gateway
  middleware returns `403 Forbidden` before reaching any route handler.
- What if a model identifier in the budget keys is not present in the current `models` config?
  → The daemon rejects the mutation with a `400 Bad Request`; the panel surfaces the validation
  message without crashing.

---

## 3. Requirements

### Functional Requirements

- **FR-001**: The system MUST expose a read endpoint that returns the safe-read subset of Hydra
  runtime config (routing mode, agent model tiers, budget limits) with no secret material.

- **FR-002**: The system MUST provide a mutation endpoint for global routing mode, accepting one
  of the three valid mode values and rejecting unknown values.

- **FR-003**: The system MUST provide a per-agent model-tier mutation endpoint, accepting the
  agent identifier as a path parameter and the new tier as the request body.

- **FR-004**: The system MUST provide a budget mutation endpoint that accepts a model identifier
  and new budget value for daily and/or weekly limits, validating that values are positive
  integers.

- **FR-005**: The system MUST provide a workflow-launch endpoint that accepts a workflow name
  from the allowed set, returns a daemon-assigned task ID on success, and rejects unknown names.

- **FR-006**: The system MUST provide a paginated audit query endpoint returning mutation and
  workflow-launch records in reverse-chronological order.

- **FR-007**: Every mutation endpoint (routing mode, model tier, budget, workflow launch) MUST
  require a CSRF token verified by the double-submit cookie pattern before the gateway forwards
  the request to the daemon.

- **FR-008**: Every mutation endpoint MUST require a valid authenticated session; unauthenticated
  requests MUST receive a `401 Unauthorized` response.

- **FR-009**: Every mutation endpoint MUST include an optimistic-concurrency `expectedRevision`
  token in the request body; the daemon MUST reject stale tokens with a `409 Conflict` response.

- **FR-010**: The config read panel MUST display current routing mode, per-agent active tier, and
  budget limits, and MUST NOT display any field that contains a secret or API key.

- **FR-011**: All mutation browser surfaces MUST require explicit operator confirmation before
  submitting a request (single-step confirm dialog for non-destructive mutations).

- **FR-012**: Mutations classified as destructive MUST require a two-step confirmation where the
  second step involves a typed-match phrase before the submit control is enabled.

- **FR-013**: The audit trail panel MUST display at minimum: actor display name, timestamp, event
  type, before-value, after-value, and outcome for each record.

- **FR-014**: The audit trail panel MUST support cursor-based pagination; the operator MUST be
  able to load older records without losing the current page.

- **FR-015**: After a successful mutation, the config panel and any related operations-panel
  surfaces (e.g., budget gauges) MUST refresh to reflect the new values without requiring a
  full page reload.

- **FR-016**: The gateway MUST record an audit entry for every mutation attempt (success or
  failure) before returning the response to the browser.

- **FR-017**: The system MUST enforce rate limiting on all mutation endpoints to prevent
  accidental or scripted abuse.

### Key Entities

- **SafeConfigView**: The browser-safe projection of Hydra runtime config. Contains routing mode,
  a map of agent → active tier, and a budget map (model identifier → daily/weekly limit). Contains
  no API keys, hashed credentials, or internal paths. Carries a `revision` token for optimistic
  concurrency.

- **ConfigMutationRequest**: The body sent for any config mutation. Contains the target field
  value and the `expectedRevision` token from the most recent `SafeConfigView` read.

- **ConfigMutationResponse**: The daemon's acknowledgement after a successful mutation. Contains
  the new `SafeConfigView` snapshot, the applied revision, and a timestamp.

- **WorkflowLaunchRequest**: Body for a workflow launch. Contains the workflow name (from the
  allowed enum), an optional operator-supplied label, and the `expectedRevision` token.

- **WorkflowLaunchResponse**: The daemon's acknowledgement. Contains the daemon-assigned `taskId`,
  the workflow name, and the launch timestamp.

- **MutationAuditRecord**: An append-only audit entry. Contains: `id`, `timestamp`, `eventType`
  (from the extended `AuditEventType` enum), `operatorId`, `sessionId`, `targetField`
  (e.g., `config.routing.mode`), `beforeValue`, `afterValue`, `outcome` (`success`|`failure`),
  `rejectionReason` (nullable), and `sourceIp`.

- **AuditPageRequest**: Cursor-based pagination parameters for the audit query: `limit` (max 100)
  and `cursor` (opaque string from the previous page's `nextCursor`).

- **AuditPageResponse**: The paginated audit response: `records` (array of `MutationAuditRecord`),
  `nextCursor` (nullable), and `totalCount` (nullable — may be omitted for performance).

---

## 4. API Contract Definitions

### 4.1 Gateway Routes (new, in `apps/web-gateway/src/mutations/`)

All routes require:

- Valid authenticated session (`Authorization` / session cookie)
- `X-CSRF-Token` header matching `__csrf` cookie value (POST/PATCH/DELETE)
- JSON `Content-Type` on request bodies

| Method  | Path                           | Description                                  | Auth | CSRF |
| ------- | ------------------------------ | -------------------------------------------- | ---- | ---- |
| `GET`   | `/config/safe`                 | Returns `SafeConfigView`                     | ✓    | —    |
| `PATCH` | `/config/routing/mode`         | Mutates global routing mode                  | ✓    | ✓    |
| `PATCH` | `/config/models/:agent/active` | Mutates active model tier for `:agent`       | ✓    | ✓    |
| `PATCH` | `/config/usage/budget`         | Mutates daily/weekly budget limits           | ✓    | ✓    |
| `POST`  | `/workflows/launch`            | Launches a named workflow                    | ✓    | ✓    |
| `GET`   | `/audit`                       | Returns paginated `MutationAuditRecord` list | ✓    | —    |

#### `GET /config/safe`

- **Response 200**: `SafeConfigView`
- **Response 401**: Session absent or expired
- **Response 503**: Daemon unreachable

#### `PATCH /config/routing/mode`

- **Request body**: `{ "mode": "economy"|"balanced"|"performance", "expectedRevision": string }`
- **Response 200**: `ConfigMutationResponse`
- **Response 400**: Invalid mode value or missing fields
- **Response 403**: CSRF validation failure
- **Response 409**: Stale `expectedRevision`
- **Response 503**: Daemon unreachable

#### `PATCH /config/models/:agent/active`

- **Path param** `:agent`: one of `gemini`|`codex`|`claude` (validated; 400 on unknown value)
- **Request body**: `{ "tier": "default"|"fast"|"cheap", "expectedRevision": string }`
- **Response 200**: `ConfigMutationResponse`
- **Response 400**: Invalid tier or unknown agent
- **Response 403**: CSRF validation failure
- **Response 409**: Stale revision
- **Response 503**: Daemon unreachable

#### `PATCH /config/usage/budget`

- **Request body**:
  ```
  {
    "modelId": string,            // e.g., "claude-opus-4-6"
    "dailyLimit": integer | null, // null = unchanged
    "weeklyLimit": integer | null,// null = unchanged
    "expectedRevision": string
  }
  ```
- **Response 200**: `ConfigMutationResponse`
- **Response 400**: Non-positive value, unknown modelId, or both limits null
- **Response 403**: CSRF failure
- **Response 409**: Stale revision
- **Response 503**: Daemon unreachable

#### `POST /workflows/launch`

- **Request body**: `{ "workflow": "evolve"|"tasks"|"nightly", "label": string | null, "expectedRevision": string }`
- **Response 202**: `WorkflowLaunchResponse`
- **Response 400**: Unknown workflow name
- **Response 403**: CSRF failure
- **Response 409**: Workflow already running (conflict)
- **Response 503**: Daemon unreachable

#### `GET /audit`

- **Query params**: `limit` (default 20, max 100), `cursor` (opaque string, optional)
- **Response 200**: `AuditPageResponse`
- **Response 401**: Unauthenticated
- **Response 503**: Daemon unreachable

### 4.2 Daemon Endpoints (new, in `lib/daemon/write-routes.ts` or a new `mutation-routes.ts`)

| Method  | Path                           | Description                                    |
| ------- | ------------------------------ | ---------------------------------------------- |
| `GET`   | `/config/safe`                 | Returns safe config subset with revision token |
| `PATCH` | `/config/routing/mode`         | Persists routing mode change                   |
| `PATCH` | `/config/models/:agent/active` | Persists agent model tier change               |
| `PATCH` | `/config/usage/budget`         | Persists budget limit change                   |
| `POST`  | `/workflows/launch`            | Launches workflow, returns task ID             |
| `GET`   | `/audit`                       | Returns paginated mutation audit log           |

The daemon is authoritative for:

- Generating and validating `revision` tokens (content hash or monotonic counter of the mutable
  config sections)
- Persisting all mutations to `hydra.config.json`
- Assigning task IDs for workflow launches
- Appending `MutationAuditRecord` entries to the audit log on every mutation attempt

### 4.3 `packages/web-contracts/src/` Schema Additions

**New file: `config-mutation.ts`**

- `RoutingMode` enum (`economy`|`balanced`|`performance`)
- `ModelTier` enum (`default`|`fast`|`cheap`)
- `AgentId` enum (`gemini`|`codex`|`claude`)
- `SafeConfigView` Zod schema
- `RoutingModeMutationRequest` / `ModelTierMutationRequest` / `BudgetMutationRequest` Zod schemas
- `ConfigMutationResponse` Zod schema

**New file: `workflow-launch.ts`**

- `WorkflowName` enum (`evolve`|`tasks`|`nightly`)
- `WorkflowLaunchRequest` Zod schema
- `WorkflowLaunchResponse` Zod schema

**Extended file: `audit-schemas.ts`**

- Extend `AuditEventType` enum with:
  - `config.routing.mode.changed`
  - `config.models.active.changed`
  - `config.usage.budget.changed`
  - `workflow.launched`
  - `config.mutation.rejected`
  - `workflow.launch.rejected`
- Add `MutationAuditRecord` Zod schema
- Add `AuditPageRequest` / `AuditPageResponse` Zod schemas

**New file: `contracts/config-mutation.ts`** (gateway request/response contracts following the
pattern of `contracts/operations-control.ts`)

**New file: `contracts/workflow-launch.ts`** (gateway workflow launch contracts)

**New file: `contracts/audit-read.ts`** (gateway audit query contracts)

---

## 5. Security Requirements

- **SEC-01 — CSRF**: All `PATCH` and `POST` mutation routes at the gateway MUST validate the
  double-submit CSRF token (X-CSRF-Token header vs. `__csrf` cookie) before forwarding any
  request body to the daemon. The existing CSRF middleware in `apps/web-gateway/src/security/`
  MUST be applied to the mutations router.

- **SEC-02 — Session binding**: Every mutation request MUST be associated with a valid, active
  session. The gateway MUST reject requests with no session or an expired session before reaching
  the daemon.

- **SEC-03 — No direct config writes**: The gateway MUST NOT write to `hydra.config.json` or any
  daemon-managed file. All writes are forwarded to the daemon. This boundary MUST be enforced by
  ESLint import rules (web packages cannot import from `lib/`).

- **SEC-04 — Output sanitization**: `SafeConfigView` MUST be validated against a strict Zod
  schema (`.strict()`) before being returned to the browser. Any fields not explicitly included
  in the schema MUST be stripped by the schema parse.

- **SEC-05 — Rate limiting**: Mutation endpoints MUST be subject to a stricter rate-limit tier
  than read endpoints. A suggested ceiling is 30 mutation requests per minute per session. The
  exact threshold is a daemon or gateway configuration value, not hard-coded in client code.

- **SEC-06 — Audit completeness**: Every mutation attempt (including rejected ones) MUST produce
  an `MutationAuditRecord` entry before the gateway returns any response. A failed audit write
  MUST NOT silently suppress the mutation; it MUST be logged as an error in the gateway's
  structured log.

- **SEC-07 — Optimistic concurrency**: All mutation requests MUST carry an `expectedRevision`
  token. The daemon MUST reject mutations where the token does not match the current revision.
  This prevents lost-update races between concurrent operator sessions.

- **SEC-08 — Input validation**: All request bodies on mutation routes MUST be parsed with Zod
  schemas at the gateway layer before forwarding. Gateway validation failures MUST return `400`
  and never reach the daemon.

- **SEC-09 — Destructive action phrase**: The two-step typed-confirmation phrase MUST be
  evaluated with a strict equality check (case-sensitive, no trimming). No fallback partial
  match is acceptable.

- **SEC-10 — Audit read authorization**: The `GET /audit` endpoint MUST require a valid session.
  Audit records MUST NOT be accessible to unauthenticated callers.

---

## 6. Component Breakdown

### 6.1 `packages/web-contracts/src/` (schema layer)

| File                           | New / Extended | Contents                                                                                   |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------ |
| `config-mutation.ts`           | New            | `RoutingMode`, `ModelTier`, `AgentId`, `SafeConfigView`, mutation request/response schemas |
| `workflow-launch.ts`           | New            | `WorkflowName`, `WorkflowLaunchRequest`, `WorkflowLaunchResponse`                          |
| `audit-schemas.ts`             | Extended       | New `AuditEventType` values, `MutationAuditRecord`, `AuditPageRequest/Response`            |
| `contracts/config-mutation.ts` | New            | Gateway request/response contracts for config mutations                                    |
| `contracts/workflow-launch.ts` | New            | Gateway contracts for workflow launch                                                      |
| `contracts/audit-read.ts`      | New            | Gateway contracts for audit query                                                          |
| `index.ts`                     | Extended       | Re-export all new schemas                                                                  |

### 6.2 `apps/web-gateway/src/mutations/` (new module)

| File                                        | Responsibility                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `mutations-routes.ts`                       | Hono router mounting all mutation + audit + config-read routes                                           |
| `daemon-mutations-client.ts`                | Typed HTTP client for the six new daemon endpoints; follows the pattern of `daemon-operations-client.ts` |
| `request-validator.ts`                      | Zod-based validation helpers for mutation request bodies and path params                                 |
| `response-translator.ts`                    | Maps daemon error shapes to `GatewayErrorResponse` categories                                            |
| `__tests__/mutations-routes.test.ts`        | Unit tests (Node `node:test`)                                                                            |
| `__tests__/daemon-mutations-client.test.ts` | Unit tests                                                                                               |

The `mutations-routes.ts` router is registered in `apps/web-gateway/src/index.ts` under the
authenticated middleware group alongside the existing operations router.

### 6.3 `apps/web/src/features/mutations/` (new feature module)

#### API layer

| File                      | Responsibility                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `api/mutations-client.ts` | Typed `fetch` wrappers for all six gateway mutation/audit/read endpoints; injects CSRF header from the existing `useSession` cookie |

#### Components

| Component                                   | Description                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `components/config-panel.tsx`               | Top-level panel: renders `RoutingSection`, `ModelsSection`, `BudgetsSection` from `SafeConfigView`; triggers refetch after mutation |
| `components/routing-section.tsx`            | Displays current mode; renders mode selector with confirm dialog trigger                                                            |
| `components/models-section.tsx`             | Per-agent row showing current tier; renders tier dropdown + confirm dialog trigger                                                  |
| `components/budgets-section.tsx`            | Per-model-id row showing daily/weekly limits; renders numeric input + confirm dialog trigger                                        |
| `components/confirm-dialog.tsx`             | Reusable single-step confirm dialog: shows "from → to" summary, Cancel and Confirm buttons                                          |
| `components/destructive-confirm-dialog.tsx` | Two-step confirm: wraps `confirm-dialog.tsx` with a second phase requiring typed-phrase match                                       |
| `components/workflow-launch-panel.tsx`      | Workflow selector + launch button; wires to approval-gate dialog                                                                    |
| `components/audit-panel.tsx`                | Paginated audit table: fetches `GET /audit`, renders rows, handles load-more                                                        |
| `components/audit-row.tsx`                  | Single audit record row: actor, timestamp, event type, before/after, outcome badge                                                  |
| `components/mutation-error-banner.tsx`      | Inline dismissible error banner for mutation rejections                                                                             |

#### Model / hooks

| File                       | Responsibility                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `model/use-safe-config.ts` | Hook: fetches and caches `SafeConfigView`; exposes `revision` for optimistic concurrency          |
| `model/use-mutation.ts`    | Generic mutation hook: manages loading/error state, injects CSRF header, calls refetch on success |
| `model/use-audit-page.ts`  | Hook: cursor-based paginated fetch of audit records                                               |

### 6.4 Integration points with existing features

| Existing surface                                                             | Integration                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/operations-panels/components/health-budget-panel.tsx` | After a successful budget mutation, the mutations feature triggers a refetch of the budget panel's data source |
| `apps/web/src/features/operations-panels/components/routing-panel.tsx`       | After a routing mode mutation, the routing panel's mode indicator reflects the change on its next poll         |
| `apps/web-gateway/src/audit/`                                                | Audit-write calls from `mutations-routes.ts` use the existing audit infrastructure                             |
| `apps/web-gateway/src/security/`                                             | CSRF middleware is applied to the mutations router without modification                                        |

---

## 7. Test Requirements

### Unit tests (Node `node:test` + `node:assert/strict`)

- `apps/web-gateway/src/mutations/__tests__/mutations-routes.test.ts`
  - Valid CSRF + session → request forwarded to daemon client stub
  - Missing CSRF header → `403` before daemon is called
  - Unknown routing mode value → `400` before daemon is called
  - Unknown agent id in path → `400`
  - Non-positive budget value → `400`
  - Unknown workflow name → `400`
  - Stale revision response from daemon stub → `409` forwarded to caller
  - Daemon unavailable stub → `503` forwarded
  - Successful mutation → audit write called before response returned

- `apps/web-gateway/src/mutations/__tests__/daemon-mutations-client.test.ts`
  - Correct HTTP method and path for each of the six daemon endpoints
  - Request body serialization for each mutation type
  - Daemon `4xx` / `5xx` mapped to the correct `GatewayErrorResponse` category

- `packages/web-contracts/src/__tests__/config-mutation.test.ts`
  - `SafeConfigView.parse` rejects objects with unknown/extra fields (strict schema)
  - `SafeConfigView.parse` rejects objects containing fields named `apiKey`, `secret`, or `hash`
  - Each mutation request schema rejects invalid enum values
  - Budget request rejects non-integer and non-positive values

### Browser specs (Vitest, `*.browser.spec.tsx`)

- `apps/web/src/features/mutations/__tests__/config-panel.browser.spec.tsx`
  - Renders routing, models, and budget sections from a mocked `SafeConfigView`
  - No secret-adjacent field text appears in the rendered output

- `apps/web/src/features/mutations/__tests__/confirm-dialog.browser.spec.tsx`
  - Cancel does not call submit handler
  - Confirm calls submit handler exactly once with correct payload

- `apps/web/src/features/mutations/__tests__/destructive-confirm-dialog.browser.spec.tsx`
  - Submit button disabled before phrase is typed
  - Submit button disabled with near-match (wrong case, trailing space)
  - Submit button enabled only on exact match

- `apps/web/src/features/mutations/__tests__/workflow-launch-panel.browser.spec.tsx`
  - Workflow selection renders expected approval dialog
  - Dismissing dialog does not trigger request

- `apps/web/src/features/mutations/__tests__/audit-panel.browser.spec.tsx`
  - Renders first page of records in reverse-chronological order
  - "Load more" fetches next cursor and appends records
  - Empty state shown when records array is empty

### Integration tests

- Gateway → daemon stub: full round-trip for each mutation type verifying CSRF, session,
  body forwarding, and audit-write invocation
- Gateway `GET /audit` cursor pagination: verify `nextCursor` forwarded correctly and response
  schema validated
- Optimistic concurrency race: two concurrent `PATCH /config/routing/mode` requests with the
  same `expectedRevision`; verify exactly one succeeds and one receives `409`

---

## 8. Out-of-Scope Items

The following are explicitly excluded from this feature:

- **Bulk config reset / import**: Uploading a new `hydra.config.json` wholesale is not in scope.
  Only targeted field mutations are supported.
- **Role-based access control (RBAC)**: All authenticated operators have the same mutation
  privileges. Fine-grained per-field or per-role permissions are deferred.
- **Config history / rollback**: Viewing a diff history or reverting to a previous config snapshot
  is out of scope. The audit trail records before/after values but does not provide a restore
  mechanism.
- **Real-time audit streaming**: The audit panel uses polling/cursor pagination only. A live
  WebSocket feed of audit events is out of scope.
- **Daemon internals mutation** (e.g., clearing task queue, resetting agent conversation state):
  The `web-controlled-mutations` scope covers `routing`, `models`, and `usage` config sections
  plus named-workflow launch only. Direct task-queue manipulation is out of scope.
- **Secret/API-key management**: Updating API keys or credentials through the web surface is
  explicitly out of scope and blocked by the `SafeConfigView` schema design.
- **Workflow scheduling**: Scheduling recurring workflow runs is out of scope. Only immediate
  one-shot launches are supported.
- **Mobile / responsive layout**: The mutations panel is designed for desktop/operator viewport
  widths consistent with the existing operations panels.

---

## 9. Open Questions

1. **Revision token strategy**: Should the `revision` token be a content hash of the mutable
   config sections (deterministic, survives restart) or a monotonic counter stored in daemon
   memory (simpler, reset on restart)? The choice affects behaviour when the daemon restarts
   between a read and a mutation attempt. A content hash is recommended for resilience.

2. **Destructive action classification**: Which specific mutation values or workflow names does
   the daemon classify as destructive? The spec defines the two-step confirmation mechanism but
   defers the definitive list to the daemon contract. The planning phase should enumerate
   the destructive set and codify it in the `WorkflowLaunchRequest` or a daemon response flag.

3. **Audit log storage**: Is the audit log stored in-memory (lost on daemon restart), written to
   a local append-only file, or forwarded to an external sink? The spec treats it as an opaque
   daemon-owned store, but the persistence strategy affects the `GET /audit` total-count field
   and restart behaviour.

---

## 10. Success Criteria

### Measurable Outcomes

- **SC-001**: An authenticated operator can view the current routing mode, per-agent model tier,
  and all configured budget limits within 2 seconds of opening the config panel on a local
  daemon connection.

- **SC-002**: A routing mode mutation completes (browser submit → daemon acknowledgement → panel
  refresh) within 3 seconds on a local daemon connection under nominal load.

- **SC-003**: A budget mutation is immediately reflected in the operations-panel budget gauge
  without a full page reload.

- **SC-004**: Zero config mutations are applied without a corresponding `MutationAuditRecord`
  entry being written.

- **SC-005**: A CSRF-missing mutation request receives a `403` response and does not reach the
  daemon, verified by the gateway unit tests.

- **SC-006**: A destructive workflow launch cannot be submitted unless the operator has typed the
  exact required phrase; verified by the `destructive-confirm-dialog` browser spec.

- **SC-007**: All new Zod schemas in `packages/web-contracts/` use `.strict()` and pass a
  test asserting that extra fields are stripped on parse.

- **SC-008**: `npm run quality` (lint + format:check + typecheck + lint:cycles) passes with zero
  new violations after the feature is fully implemented.

- **SC-009**: The audit panel renders 1 000 records across 50 paginated loads without memory
  leaks or layout breakage, verified by the pagination integration test.

- **SC-010**: No field containing the substring `key`, `secret`, `hash`, or `password` appears
  in any rendered output of the config panel, verified by the `config-panel` browser spec.
