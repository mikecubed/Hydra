# Contract Notes: Web Hydra Operations Panels

## Purpose

This feature needs new browser-safe contracts because the existing shared packages cover conversations, turns, approvals, artifacts, activities, auth, and sessions, but not workspace-wide Hydra operations visibility and controls.

The contracts in this slice should let the browser consume authoritative operations state without depending on raw daemon/core payloads.

## Contract Families

### 1. Operations Read Contracts

Suggested file: `packages/web-contracts/src/contracts/operations-read.ts`

#### A. Workspace Operations Snapshot

**Gateway route**: `GET /operations/snapshot`

Returns the top-level operations surface for the workspace.

**Response shape (conceptual):**

- `queue: WorkQueueItemView[]`
- `health: DaemonHealthView | null`
- `budget: BudgetStatusView | null`
- `availability: 'ready' | 'empty' | 'partial' | 'unavailable'`
- `lastSynchronizedAt: string | null`

This is the main polling endpoint used to keep the queue, health, and budget panels current. The `queue` represents daemon-projected Hydra task/work items, not the existing per-conversation instruction queue.

#### B. Work Item Detail

**Gateway route**: `GET /operations/work-items/:workItemId`

Returns detail for the currently selected work item.

**Response shape (conceptual):**

- `item: WorkQueueItemView`
- `checkpoints: CheckpointRecordView[]`
- `routing: RoutingDecisionView | null`
- `assignments: AgentAssignmentView[]`
- `council: CouncilExecutionView | null`
- `controls: OperationalControlView[]`
- `itemBudget: BudgetStatusView | null`
- `availability: 'ready' | 'partial' | 'unavailable'`

This avoids many fine-grained browser calls and keeps cross-panel detail synchronized. The `routing`, `assignments`, and `council` records must come from a daemon-owned operations projection/history rather than raw passthrough of existing config or activity routes.

#### C. Optional Focused Detail Routes

If the combined detail payload becomes too large, split routes may be introduced without changing the browser-owned entity vocabulary:

- `GET /operations/work-items/:workItemId/checkpoints`
- `GET /operations/work-items/:workItemId/execution`
- `GET /operations/work-items/:workItemId/controls`

The plan prefers one detail route first unless implementation pressure proves splitting is necessary.

### 2. Operations Control Contracts

Suggested file: `packages/web-contracts/src/contracts/operations-control.ts`

#### A. Update Operational Control

**Gateway route**: `POST /operations/work-items/:workItemId/controls/:controlId`

Used only for daemon-authorized routing/mode/agent/council-related changes.

**Request shape (conceptual):**

- `requestedOptionId: string`
- `expectedRevision: string`
- `requestId?: string` (idempotency / tracing aid)

**Response shape (conceptual):**

- `outcome: 'accepted' | 'rejected' | 'stale' | 'superseded'`
- `control: OperationalControlView`
- `workItemId: string`
- `resolvedAt: string`
- `message?: string`

The response must represent the authoritative outcome, not merely acceptance of receipt. The paired read/detail surface must also expose control discovery, current eligibility, and operator authority so the browser never decides actionability on its own.

## Reused Existing Contracts

This slice reuses, but does not redefine:

- conversation ids and relationship hints from existing conversation contracts
- activity and artifact semantics from existing multi-agent/activity contracts
- session/daemon availability signals already delivered through current session + WebSocket infrastructure
- structured gateway errors already used by the browser workspace

## Transport Decision

No new public WebSocket contract family is introduced in this slice.

Why:

- operations state is broader than per-conversation streaming;
- the existing gateway/socket layer already covers connection/session/daemon status;
- REST snapshot/detail contracts plus targeted refetch are sufficient for Phase 3 convergence requirements.

A later slice can add operations streaming if the polling model proves insufficient, but that is intentionally deferred.

## Contract Design Rules

1. **Daemon-authored vocabulary only** — browser/gateway must not invent hidden status mappings.
2. **Explicit availability states** — never encode empty vs partial vs unavailable with null alone.
3. **No raw core payload leakage** — avoid passing through daemon `state`, `self`, or `stats` shapes directly.
4. **Optimistic concurrency required for controls** — actionable control mutations need an authoritative version token.
5. **Control discovery is part of the contract** — actionable status, operator authority, and stale/superseded behavior must be daemon-authored.
6. **Append-only shared exports** — update `packages/web-contracts/src/index.ts` and `CONTRACTS.md` without breaking existing consumers.

## Testing Expectations

- schema validation tests in `packages/web-contracts/src/__tests__/operations-contracts.test.ts`
- gateway route tests for validation, auth/session enforcement, and structured error translation
- daemon route/projection tests for status normalization and control outcome semantics
- browser integration tests proving snapshot/detail/control flows converge to authoritative state
