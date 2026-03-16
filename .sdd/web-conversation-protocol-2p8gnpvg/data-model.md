# Data Model: Web Conversation Protocol Slice

**Date**: 2025-07-14
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)

## Entity Relationship Overview

```
Conversation 1──* Turn 1──* StreamEvent
     │                │
     │ (fork)         ├──* Artifact
     │                │
     └── Conversation ├──* ApprovalRequest
                      │
                      └──* ActivityEntry
```

A Conversation contains an ordered sequence of Turns. Each Turn represents one operator instruction and all resulting system work. During execution, a Turn may produce StreamEvents (incremental updates), generate Artifacts, trigger ApprovalRequests, and contain ActivityEntries for multi-agent work. Approvals, agent activity, errors, and cancellation are nested events within the turn — not separate top-level turns. A Conversation may be forked from another Conversation at a specific Turn, creating a parent-child lineage.

## Entities

### Conversation

The top-level container for operator-system interaction. Persists across browser sessions and survives disconnection.

| Attribute               | Description                                                      | Constraints                           |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| id                      | Unique conversation identifier                                   | Required, immutable, system-generated |
| title                   | Human-readable label, may be auto-generated or operator-provided | Optional, mutable                     |
| status                  | Current lifecycle state                                          | Required: `active`, `archived`        |
| createdAt               | Timestamp of creation                                            | Required, immutable                   |
| updatedAt               | Timestamp of last turn appended                                  | Required, updated on each turn        |
| turnCount               | Total number of turns                                            | Required, derived                     |
| parentConversationId    | If forked, the source conversation                               | Optional, immutable                   |
| forkPointTurnId         | If forked, the turn in the parent where the fork occurred        | Optional, immutable                   |
| pendingInstructionCount | Number of queued but unexecuted operator instructions            | Required, derived                     |

**Validation rules**:

- A forked conversation MUST reference both `parentConversationId` and `forkPointTurnId` or neither.
- `forkPointTurnId` MUST reference an existing turn in the parent conversation.
- Status transitions: `active` → `archived`. Archived conversations are read-only.

---

### Turn

A single interaction cycle within a conversation: one operator instruction together with all resulting system work and response. Immutable once finalized. Ordered by position within the conversation. Approvals, agent activity, errors, and cancellation are nested events within the turn (via StreamEvent and ApprovalRequest), not separate top-level turns.

| Attribute      | Description                                                            | Constraints                                                                                 |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| id             | Unique turn identifier                                                 | Required, immutable, system-generated                                                       |
| conversationId | Parent conversation                                                    | Required, immutable                                                                         |
| position       | Ordinal position within the conversation (1-based)                     | Required, immutable, monotonically increasing                                               |
| kind           | The initiator of the turn                                              | Required: `operator` (instruction + resulting work) or `system` (unsolicited notice — rare) |
| attribution    | Who initiated this turn                                                | Required (see Attribution below)                                                            |
| instruction    | The operator's instruction text (for `operator` turns)                 | Required when kind is `operator`                                                            |
| response       | The finalized system response (consolidated from stream on completion) | Optional, populated when status becomes terminal                                            |
| status         | Lifecycle state of the turn                                            | Required: `submitted`, `executing`, `completed`, `failed`, `cancelled`                      |
| parentTurnId   | For retries: the turn being retried                                    | Optional                                                                                    |
| createdAt      | Timestamp of creation                                                  | Required, immutable                                                                         |
| completedAt    | Timestamp of finalization                                              | Optional, set when status becomes terminal                                                  |

**Validation rules**:

- Position MUST be unique within a conversation and strictly increasing.
- An `operator` turn's status progresses: `submitted` → `executing` → `completed` or `failed` or `cancelled`.
- A `system` turn is immediately `completed` upon creation.
- `parentTurnId` MUST reference an existing turn in the same conversation (for retries).
- Response content is immutable once the turn status is terminal (`completed`, `failed`, `cancelled`).
- Approvals, agent activity, errors, and cancellation during execution are represented as StreamEvents and ApprovalRequest entities nested within the turn, not as separate turns.

---

### Attribution

Identifies who produced a turn or activity entry. Not a standalone entity — embedded in Turns and ActivityEntries.

| Attribute | Description                                     | Constraints                             |
| --------- | ----------------------------------------------- | --------------------------------------- |
| type      | Source category                                 | Required: `operator`, `system`, `agent` |
| agentId   | If type is `agent`, the specific agent identity | Required when type is `agent`           |
| label     | Human-readable display name                     | Required                                |

---

### StreamEvent

An incremental update produced during a streaming turn. Ephemeral during execution, persisted as part of the finalized turn content upon completion.

| Attribute | Description                                             | Constraints                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| seq       | Daemon-global event sequence number (`EventRecord.seq`) | Required, monotonically increasing, reused from daemon event log                                                                                                                                                               |
| turnId    | The turn this event belongs to                          | Required                                                                                                                                                                                                                       |
| kind      | Type of stream event                                    | Required: `stream-started`, `stream-completed`, `stream-failed`, `text-delta`, `status-change`, `activity-marker`, `approval-prompt`, `approval-response`, `artifact-notice`, `checkpoint`, `warning`, `error`, `cancellation` |
| payload   | Event-specific data                                     | Required, structure varies by kind                                                                                                                                                                                             |
| timestamp | When the event was produced                             | Required                                                                                                                                                                                                                       |

**Validation rules**:

- Sequence numbers within a turn are strictly ordered but may contain gaps (daemon-global `seq` is shared across all event sources). Gap-free semantics apply only to full-conversation replay on reconnect.
- A `text-delta` payload contains partial text to append.
- A `status-change` payload contains the new status and a reason.
- An `activity-marker` payload contains agent attribution and a description of the activity.
- An `approval-prompt` payload references the ApprovalRequest entity.
- An `approval-response` payload records the operator's response to an approval (the response is an event within the turn, not a separate turn).
- An `artifact-notice` payload references the Artifact entity.

---

### ApprovalRequest

A system-initiated pause requiring operator input. Exists within the context of a specific turn.

| Attribute       | Description                                              | Constraints                                             |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| id              | Unique approval request identifier                       | Required, immutable, system-generated                   |
| turnId          | The turn during which this request was raised            | Required, immutable                                     |
| status          | Current state of the request                             | Required: `pending`, `responded`, `expired`, `stale`    |
| prompt          | The question or action requiring approval                | Required, immutable                                     |
| context         | Structured context the operator needs to make a decision | Required                                                |
| contextHash     | A fingerprint of the referenced context at request time  | Required, used for staleness detection                  |
| responseOptions | The set of valid response types                          | Required (e.g., approve/reject, free-text, choice list) |
| response        | The operator's response once provided                    | Optional, set when status becomes `responded`           |
| respondedBy     | Attribution of who responded (for multi-tab tracking)    | Optional                                                |
| respondedAt     | Timestamp of response                                    | Optional                                                |
| createdAt       | Timestamp of creation                                    | Required, immutable                                     |

**Validation rules**:

- Status transitions: `pending` → `responded` | `expired` | `stale`.
- `stale` can transition to `responded` (operator acknowledges staleness and proceeds) or `expired`.
- Response MUST match one of the declared `responseOptions` types.
- Only one response is accepted per request (first-write-wins for multi-tab conflicts).

---

### Artifact

A discrete output produced by a turn. Permanently associated with its producing turn.

| Attribute | Description                                                                  | Constraints                                                                        |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| id        | Unique artifact identifier, stable across sessions                           | Required, immutable, system-generated                                              |
| turnId    | The turn that produced this artifact                                         | Required, immutable                                                                |
| kind      | Type of artifact                                                             | Required: `file`, `diff`, `patch`, `test-result`, `log`, `plan`, `structured-data` |
| label     | Human-readable name or title                                                 | Required                                                                           |
| summary   | Brief description of the artifact's content                                  | Optional                                                                           |
| size      | Content size indicator (for UI decisions about inline vs. on-demand loading) | Required                                                                           |
| createdAt | Timestamp of creation                                                        | Required, immutable                                                                |

**Validation rules**:

- Artifact content is retrievable by `id` independently of the conversation transcript (supporting FR-014 — large conversations don't require loading all artifact content inline).
- Kind determines rendering strategy in the browser but is not prescriptive of format.

---

### ActivityEntry

A structured record of agent-level work within a multi-agent turn. Nested inside a Turn, not a top-level entity. Preserves the multi-agent structure required by User Story 7.

| Attribute        | Description                                           | Constraints                                                                                                            |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| id               | Unique identifier within the turn                     | Required                                                                                                               |
| attribution      | Which agent performed this activity                   | Required (Attribution type)                                                                                            |
| kind             | Type of activity                                      | Required: `task-started`, `task-completed`, `task-failed`, `proposal`, `vote`, `consensus`, `delegation`, `checkpoint` |
| summary          | Human-readable description                            | Required                                                                                                               |
| detail           | Extended content (expandable in UI)                   | Optional                                                                                                               |
| parentActivityId | For nested activities (sub-tasks, deliberation steps) | Optional                                                                                                               |
| timestamp        | When this activity occurred                           | Required                                                                                                               |

**Validation rules**:

- ActivityEntries within a turn are ordered by timestamp.
- Council deliberation activities (`proposal`, `vote`, `consensus`) MUST have `attribution` identifying the participating agent.
- `parentActivityId` MUST reference an existing ActivityEntry within the same turn.

---

## Relationships Summary

| From         | To              | Cardinality  | Description                                                                                     |
| ------------ | --------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| Conversation | Turn            | 1 to many    | A conversation contains an ordered sequence of turns                                            |
| Conversation | Conversation    | 0..1 to many | A conversation may be forked from a parent                                                      |
| Turn         | StreamEvent     | 1 to many    | An executing turn produces ordered events (including approvals, activity, errors, cancellation) |
| Turn         | Artifact        | 1 to many    | A turn may produce artifacts                                                                    |
| Turn         | ApprovalRequest | 1 to many    | A turn may trigger approval requests (nested, not separate turns)                               |
| Turn         | ActivityEntry   | 1 to many    | A multi-agent turn contains structured activity                                                 |
| Turn         | Turn            | 0..1 (retry) | A retried turn references its predecessor                                                       |

## Sequence Number Alignment

The conversation protocol's sequence numbers align with the daemon's existing event-sourcing sequence:

- Each StreamEvent's `seq` corresponds to the daemon's `EventRecord.seq` (a daemon-global monotonically increasing integer).
- On reconnect, the browser provides the last-acknowledged `seq` and receives all conversation-relevant events with higher sequence numbers. This replay is gap-free at the conversation level.
- When events are filtered to a single turn, `seq` values remain strictly ordered but may contain gaps because the daemon interleaves events from all sources into one global sequence.
- This alignment means the conversation protocol does not invent a parallel ordering system — it reuses the daemon's authoritative event log.
