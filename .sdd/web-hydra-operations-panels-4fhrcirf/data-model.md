# Data Model: Web Hydra Operations Panels

## Overview

This feature introduces a browser-facing operational read model that sits beside the existing chat workspace. The browser owns only transient view state. The daemon owns the authoritative entities, normalization rules, control eligibility, and mutation outcomes.

## Entities

### 1. OperationsWorkspaceState

Top-level browser-owned state for the operations companion surface.

| Field                    | Type                                         | Notes                                                      |
| ------------------------ | -------------------------------------------- | ---------------------------------------------------------- |
| `snapshotStatus`         | `idle \| loading \| ready \| error`          | Overall state for the latest workspace operations snapshot |
| `selectedWorkItemId`     | `string \| null`                             | Item currently expanded in detail panels                   |
| `lastSynchronizedAt`     | `string \| null`                             | ISO timestamp from authoritative snapshot                  |
| `freshness`              | `live \| refreshing \| stale`                | Operator-facing freshness signal                           |
| `availability`           | `ready \| empty \| partial \| unavailable`   | Distinguishes no work from missing visibility              |
| `queue`                  | `readonly WorkQueueItemView[]`               | Ordered queue/recent work list                             |
| `health`                 | `DaemonHealthView \| null`                   | Global daemon-health projection                            |
| `budget`                 | `BudgetStatusView \| null`                   | Global budget projection                                   |
| `pendingControlRequests` | `ReadonlyMap<string, PendingControlRequest>` | Local pending control bookkeeping only                     |

### 2. WorkQueueItemView

Browser-safe projection of one operator-visible work item.

| Field                   | Type                                                                         | Validation / meaning                               |
| ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `id`                    | `string`                                                                     | Stable authoritative identifier                    |
| `title`                 | `string`                                                                     | Non-empty operator label                           |
| `status`                | `waiting \| active \| paused \| blocked \| completed \| failed \| cancelled` | Normalized daemon-authored status                  |
| `position`              | `number \| null`                                                             | Queue ordering when meaningful                     |
| `relatedConversationId` | `string \| null`                                                             | Link to workspace conversation when known          |
| `relatedSessionId`      | `string \| null`                                                             | Link to active daemon session when known           |
| `ownerLabel`            | `string \| null`                                                             | Operator/agent/council owner summary               |
| `lastCheckpointSummary` | `string \| null`                                                             | Most recent visible progress label                 |
| `updatedAt`             | `string`                                                                     | Authoritative update marker                        |
| `riskSignals`           | `readonly RiskSignal[]`                                                      | Budget/health/waiting warnings scoped to this item |
| `detailAvailability`    | `ready \| partial \| unavailable`                                            | Whether item detail panels can fully hydrate       |

### 3. CheckpointRecordView

Ordered checkpoint history for a work item.

| Field       | Type                                                    | Meaning                                                   |
| ----------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `id`        | `string`                                                | Stable checkpoint identifier or synthesized projection id |
| `sequence`  | `number`                                                | Ordered display position                                  |
| `label`     | `string`                                                | Operator-facing checkpoint text                           |
| `status`    | `reached \| waiting \| resumed \| recovered \| skipped` | Browser-safe status                                       |
| `timestamp` | `string`                                                | When this checkpoint state became authoritative           |
| `detail`    | `string \| null`                                        | Optional explanatory text                                 |

### 4. DaemonHealthView

Authoritative daemon health for the workspace.

| Field                 | Type                                               | Meaning                               |
| --------------------- | -------------------------------------------------- | ------------------------------------- |
| `status`              | `healthy \| degraded \| unavailable \| recovering` | Explicit global status                |
| `scope`               | `'global'`                                         | Health is always global in this slice |
| `observedAt`          | `string`                                           | Latest authoritative observation      |
| `message`             | `string \| null`                                   | Operator-facing summary               |
| `detailsAvailability` | `ready \| partial \| unavailable`                  | Makes missing data explicit           |

### 5. BudgetStatusView

Authoritative budget posture for global or item-local scope.

| Field      | Type                                           | Meaning                                 |
| ---------- | ---------------------------------------------- | --------------------------------------- |
| `status`   | `normal \| warning \| exceeded \| unavailable` | Severity tier                           |
| `scope`    | `global \| work-item \| session`               | Affected scope                          |
| `scopeId`  | `string \| null`                               | Item/session identifier when non-global |
| `summary`  | `string`                                       | Operator-facing summary                 |
| `used`     | `number \| null`                               | Best-known current usage                |
| `limit`    | `number \| null`                               | Best-known limit                        |
| `unit`     | `string \| null`                               | e.g. tokens, budget points              |
| `complete` | `boolean`                                      | Whether the projection is complete      |

### 6. RoutingDecisionView

Current and recent routing/mode history for a work item.

| Field          | Type                             |
| -------------- | -------------------------------- |
| `currentMode`  | `string \| null`                 |
| `currentRoute` | `string \| null`                 |
| `changedAt`    | `string \| null`                 |
| `history`      | `readonly RoutingHistoryEntry[]` |

### 7. AgentAssignmentView

Current and historical participant assignment for a work item.

| Field           | Type                                                    |
| --------------- | ------------------------------------------------------- |
| `participantId` | `string`                                                |
| `label`         | `string`                                                |
| `role`          | `string \| null`                                        |
| `state`         | `active \| waiting \| completed \| failed \| cancelled` |
| `startedAt`     | `string \| null`                                        |
| `endedAt`       | `string \| null`                                        |

### 8. CouncilExecutionView

Browser-safe multi-agent/council execution summary.

| Field          | Type                                                    |
| -------------- | ------------------------------------------------------- |
| `status`       | `active \| waiting \| completed \| failed \| cancelled` |
| `participants` | `readonly AgentAssignmentView[]`                        |
| `transitions`  | `readonly CouncilTransitionView[]`                      |
| `finalOutcome` | `string \| null`                                        |

### 9. OperationalControlView

Authoritative description of one browser-visible control.

| Field              | Type                                                                                 | Meaning                                                 |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `controlId`        | `string`                                                                             | Stable identifier                                       |
| `kind`             | `routing \| mode \| agent \| council`                                                | Supported control family in this slice                  |
| `label`            | `string`                                                                             | Operator-facing label                                   |
| `availability`     | `actionable \| pending \| read-only \| unavailable \| stale \| accepted \| rejected` | Required spec vocabulary                                |
| `reason`           | `string \| null`                                                                     | Why not actionable, or why a request was rejected/stale |
| `options`          | `readonly ControlOptionView[]`                                                       | Allowed daemon-authored choices                         |
| `expectedRevision` | `string \| null`                                                                     | Optimistic concurrency token                            |
| `lastResolvedAt`   | `string \| null`                                                                     | Latest authoritative result timestamp                   |

### 10. PendingControlRequest

Browser-local transient record used only while awaiting the authoritative outcome.

| Field               | Type     |
| ------------------- | -------- |
| `requestId`         | `string` |
| `workItemId`        | `string` |
| `controlId`         | `string` |
| `submittedAt`       | `string` |
| `requestedOptionId` | `string` |

## Supporting Value Types

These are small contract-level value objects used by the primary entities above.

| Type                    | Key fields                                     | Purpose                                                                         |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `RiskSignal`            | `kind`, `severity`, `summary`, `scope`         | Item-scoped warning badge for budget, health, waiting, or stale-risk conditions |
| `RoutingHistoryEntry`   | `id`, `route`, `mode`, `changedAt`, `reason`   | Preserves visible routing/mode history when Hydra changes execution path        |
| `CouncilTransitionView` | `id`, `label`, `status`, `timestamp`, `detail` | Timeline entry for major multi-agent/council transitions                        |
| `ControlOptionView`     | `optionId`, `label`, `selected`, `available`   | Daemon-authored choice rendered inside an operational control                   |

## Relationships

- `OperationsWorkspaceState` 1→\* `WorkQueueItemView`
- `WorkQueueItemView` 1→\* `CheckpointRecordView`
- `WorkQueueItemView` 1→\* `OperationalControlView`
- `WorkQueueItemView` 0..1 → `RoutingDecisionView`
- `WorkQueueItemView` 0..\* → `AgentAssignmentView`
- `WorkQueueItemView` 0..1 → `CouncilExecutionView`
- `WorkQueueItemView` 0..\* → `BudgetStatusView` (item-local risk signals)
- `OperationsWorkspaceState` 0..1 → `DaemonHealthView`
- `OperationsWorkspaceState` 0..1 → global `BudgetStatusView`

## Normalization Rules

### Queue/work status normalization

The daemon projection layer, not the browser or gateway, maps core state into browser statuses.

Examples of source inputs likely used together:

- `TaskEntry.status` (`todo`, `in_progress`, `blocked`, `done`, `cancelled`)
- session pause state / `pauseReason`
- checkpoint progression
- task/runtime failure metadata
- recent completion/failure records

Output must always be one of:

- `waiting`
- `active`
- `paused`
- `blocked`
- `completed`
- `failed`
- `cancelled`

### Availability normalization

Every read model must distinguish:

- `empty` — no work / no data by design
- `partial` — some authoritative data available, some unavailable
- `unavailable` — authoritative surface cannot currently provide data
- `ready` — complete enough for normal rendering

### Control concurrency

Each control mutation request carries an `expectedRevision` (or equivalent authoritative version token).

Possible authoritative outcomes:

- `accepted`
- `rejected`
- `stale`
- `superseded`

The browser may show `pending` locally while waiting, but final UI state must come from authoritative response + refetched snapshot/detail state.

## Validation Rules

- Non-empty ids and labels for all visible records
- Ordered checkpoint sequences must be monotonic
- `scopeId` is required when `BudgetStatusView.scope !== 'global'`
- `expectedRevision` is required for actionable controls
- `participants` and `transitions` may be empty only when execution detail availability is `unavailable` or the work item is not multi-agent
- Browser-local pending control records must be purged on authoritative resolution or full snapshot replacement

## Notes for Later Task Generation

1. Treat the daemon projection layer as the owner of normalization tests.
2. Keep browser reducers pure; polling/refetch belongs in controllers/query hooks.
3. Ensure every component consumes the explicit availability fields instead of inferring from nulls.
4. Preserve linkages back to existing conversation ids rather than duplicating transcript state in operations models.
