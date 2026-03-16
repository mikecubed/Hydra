# Interface Contracts: Web Conversation Protocol Slice

**Date**: 2025-07-14
**Spec**: [spec.md](../spec.md)
**Data Model**: [data-model.md](../data-model.md)

## Overview

This document defines the public interface contracts that the web conversation protocol exposes. These are the interaction boundaries between the browser, the gateway, and the daemon. They describe **what** can be asked and **what** comes back — not wire format, transport mechanism, or serialization details.

## Contract Family 1: Conversation Lifecycle

### Create Conversation

**Input**: Optional title, optional parent conversation reference (for forking).
**Output**: The created Conversation entity with its unique id, initial status, and metadata.
**Postcondition**: The conversation exists in the daemon's persistent state and is addressable by id.

### Open Conversation

**Input**: Conversation id.
**Output**: Conversation metadata + the most recent N turns (windowed), total turn count, and any pending approval requests.
**Postcondition**: The browser has enough state to render the current conversation and begin interacting.

### Resume Conversation (Reconnect)

**Input**: Conversation id + last-acknowledged event sequence number.
**Output**: All events since the acknowledged sequence (may include completed turns, partial streaming output, new approval requests, artifacts). Current conversation status.
**Postcondition**: The browser can catch up to authoritative state without reloading the full conversation.

### Archive Conversation

**Input**: Conversation id.
**Output**: Confirmation of archival.
**Postcondition**: The conversation is read-only. No new turns can be appended.

### List Conversations

**Input**: Optional filters (status, date range). Pagination cursor.
**Output**: Paginated list of conversation summaries (id, title, status, last activity, turn count).
**Postcondition**: None — read-only.

---

## Contract Family 2: Turn Submission and Streaming

### Submit Instruction

**Input**: Conversation id, instruction content, optional metadata (e.g., routing hints).
**Output**: Acknowledgement with the created Turn id and the stream identity for subscribing to incremental updates.
**Precondition**: Conversation is active. If work is already in progress, the instruction is queued (see FR-013 / Research Decision 4).
**Postcondition**: The instruction turn is recorded. Execution begins (or is queued).

### Subscribe to Stream

**Input**: Conversation id, turn id (or "current"), last-acknowledged sequence number.
**Output**: An ordered sequence of StreamEvents as they occur, until the turn reaches a terminal status.
**Postcondition**: The browser receives incremental updates and can render them progressively.

### Load Turn History (Windowed)

**Input**: Conversation id, range (e.g., positions 1–50, or "latest 50").
**Output**: The requested turns with their content, attribution, status, artifact references, and activity entries.
**Postcondition**: None — read-only.

---

## Contract Family 3: Approval and Follow-Up

### Get Pending Approvals

**Input**: Conversation id.
**Output**: List of ApprovalRequests with status `pending` or `stale`, including their context and response options.
**Postcondition**: None — read-only.

### Respond to Approval

**Input**: Approval request id, operator's response, browser session identifier.
**Output**: Confirmation of acceptance, or conflict notification if another session already responded.
**Precondition**: Approval request is in `pending` or `stale` state. If `stale`, the response must include an explicit acknowledgement of staleness.
**Postcondition**: Approval status transitions to `responded`. Work resumes. The response is recorded as a stream event (`approval-response`) within the active turn — not as a separate top-level turn. All browser sessions viewing this conversation are notified.

---

## Contract Family 4: Work Control

### Cancel In-Progress Work

**Input**: Conversation id, turn id of the in-progress work.
**Output**: Confirmation of cancellation.
**Precondition**: The referenced turn is in `executing` or `submitted` status.
**Postcondition**: Work stops. Turn status becomes `cancelled`. A cancellation event is recorded. The conversation is ready for new instructions. Any queued instructions remain in the queue.

### Retry Turn

**Input**: Conversation id, turn id to retry.
**Output**: The new Turn id and stream identity for the retry.
**Precondition**: The referenced turn is in a terminal status (`completed`, `failed`, `cancelled`).
**Postcondition**: A new turn is created with a `parentTurnId` referencing the original. Execution begins.

### Fork Conversation

**Input**: Conversation id, turn id to fork from.
**Output**: The new Conversation entity with its id and the inherited turn history.
**Precondition**: The fork-point turn exists in the conversation.
**Postcondition**: A new conversation is created referencing the parent and fork point. Turns 1..N are accessible in the forked conversation. The operator can submit new instructions in the fork.

### Manage Instruction Queue

**Input**: Conversation id. Actions: list queued instructions, reorder, or remove a queued instruction.
**Output**: Current queue state after the action.
**Precondition**: Conversation is active.
**Postcondition**: Queue reflects the requested change.

---

## Contract Family 5: Artifacts

### List Artifacts for Turn

**Input**: Turn id.
**Output**: List of Artifact metadata (id, kind, label, summary, size) without full content.
**Postcondition**: None — read-only.

### Get Artifact Content

**Input**: Artifact id.
**Output**: The full artifact content, with kind-appropriate structure.
**Postcondition**: None — read-only. Content is loaded on demand, not as part of the conversation transcript.

### List Artifacts for Conversation

**Input**: Conversation id. Optional filters (kind, date range). Pagination cursor.
**Output**: Paginated list of artifact metadata across all turns in the conversation.
**Postcondition**: None — read-only.

---

## Contract Family 6: Multi-Agent Activity

### Get Activity Entries for Turn

**Input**: Turn id.
**Output**: Ordered list of ActivityEntries with agent attribution, kind, summary, detail, and nesting structure.
**Postcondition**: None — read-only.

### Filter Activity by Agent

**Input**: Turn id, agent identity.
**Output**: ActivityEntries within the turn attributed to the specified agent.
**Postcondition**: None — read-only.

---

## Contract Family 7: Session Synchronization — ⚠️ DEPENDENCY

> **This family is NOT owned by this slice.** Browser session lifecycle (registration, heartbeat, WebSocket termination, transport-level session tracking) belongs to `apps/web-gateway` and the `web-session-and-auth` slice per the architecture docs (`03-architecture.md`).

This slice consumes opaque `operatorId` and `sessionId` values in contract inputs for attribution and conflict resolution. It does not define how those identifiers are issued, validated, or refreshed, and it does not require the daemon to add dedicated browser-facing conflict-notification fields that simply echo raw transport session identifiers.

**Integration point**: The gateway passes `operatorId` and `sessionId` as context when proxying browser requests to daemon conversation contracts. The daemon uses them for attribution and conflict resolution only.

---

## Follow-On Protocol Families (Out of Scope)

The authoritative protocol docs (`docs/web-interface/04-protocol.md`) identify six required daemon contract families. This slice fully covers family 1 (conversation messaging) and partially covers family 3 (council/multi-agent eventing). The following families are NOT covered and should be specified as separate SDD slices:

1. **Command Catalog and Execution** — discover supported Hydra commands and their argument shapes; execute command-style workflows through typed backend contracts.
2. **Task Live Output** — stream task progress, checkpoints, and live stdout/stderr-equivalent output in browser-safe form.
3. **Config and Controlled Mutations** — read masked config; write only allowlisted settings through audited, concurrency-safe endpoints.
4. **Operational Intelligence** — agent availability/health, budgets, usage, affinity, suggestions, and knowledge surfaces.

**Extension hooks provided by this slice**: Follow-on families can extend the conversation protocol by:

- Adding new StreamEvent `kind` values (the kind enum is designed to be extensible).
- Adding new contract families that reference existing Conversation and Turn entities.
- Emitting domain-specific events into the existing conversation event stream.

---

## Cross-Cutting Concerns

### Error Responses

All contracts return structured errors with:

- A machine-readable error code.
- A human-readable message.
- The conversation id and turn id (when applicable) so the browser can display the error in context.

### Ordering Guarantees

- StreamEvents within a turn are strictly ordered by daemon-global sequence number (`seq`). Because `seq` is shared across all daemon event sources, per-turn sequences may contain gaps.
- Turns within a conversation are strictly ordered by position.
- Events across a reconnect are gap-free from the last-acknowledged sequence at the conversation level (no conversation-relevant events are skipped).

### Idempotency

- Submit Instruction, Respond to Approval, and Cancel are idempotent when retried with the same request identifier. Duplicate submissions return the same result without side effects.

### Consistency Model

- The daemon is the single source of truth. The browser's displayed state is always a potentially-stale projection.
- The Resume Conversation contract is the mechanism for the browser to converge to authoritative state.
- Conflict resolution for multi-session scenarios follows first-write-wins semantics with notification (see Research Decision 8).
