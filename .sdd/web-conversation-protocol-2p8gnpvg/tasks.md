# Tasks: Web Conversation Protocol Slice

**Execution Status**: 🔄 In progress on worktree branch `feat/web-conversation-protocol`.
**Latest Worktree Commit**: `62351b6`
**Tracking Note**: This slice is still under active repair/review and is not merged yet.

**Input**: Design documents from `.sdd/web-conversation-protocol-2p8gnpvg/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

## Format: `- [ ] T### [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## External Dependencies (must be completed before this slice begins)

- **web-repl-foundation** — establishes `packages/web-contracts/` workspace, `apps/` directories, root workspace config, and baseline quality gates. Without this, T001–T004 cannot execute.
- **web-session-and-auth** — owns browser session lifecycle, auth, operator identity, WebSocket termination, and session registry. This slice uses opaque `operatorId`/`sessionId` values in contract inputs; it does not create or validate them.

---

## Phase 1: Foundational — Shared Entity Types

**Purpose**: Define ALL entity types and validation schemas that every subsequent phase depends on. Tests lead implementation (red-green-refactor).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. Assumes `packages/web-contracts/` workspace already exists (web-repl-foundation prerequisite).

- [ ] T001 [P] Create test fixture directory `test/fixtures/conversation/` for conversation-related test data
- [ ] T002 [P] Write unit tests for all entity Zod schemas — valid data passes, invalid data fails with correct errors — in `test/web-contracts/entities.test.ts` (tests written FIRST, expect red)
- [ ] T003 [P] Define Attribution type (`operator | system | agent`, agentId, label) with Zod schema in `packages/web-contracts/src/attribution.ts`
- [ ] T004 [P] Define Conversation entity type (id, title, status, timestamps, fork references, pendingInstructionCount) with Zod schema in `packages/web-contracts/src/conversation.ts`
- [ ] T005 [P] Define Turn entity type (id, conversationId, position, kind: `operator`|`system`, attribution, instruction, response, status: `submitted`|`executing`|`completed`|`failed`|`cancelled`, parentTurnId, timestamps) with Zod schema in `packages/web-contracts/src/turn.ts`
- [ ] T006 [P] Define StreamEvent type (seq, turnId, kind enum including `stream-started`, `stream-completed`, `stream-failed`, `text-delta`, `status-change`, `activity-marker`, `approval-prompt`, `approval-response`, `artifact-notice`, `checkpoint`, `warning`, `error`, `cancellation`, payload union, timestamp) with Zod schema in `packages/web-contracts/src/stream.ts`
- [ ] T007 [P] Define ApprovalRequest type (id, turnId, status lifecycle: `pending`→`responded`|`expired`|`stale`, prompt, context, contextHash, responseOptions, response, respondedBy, timestamps) with Zod schema in `packages/web-contracts/src/approval.ts`
- [ ] T008 [P] Define Artifact type (id, turnId, kind enum, label, summary, size, timestamp) with Zod schema in `packages/web-contracts/src/artifact.ts`
- [ ] T009 [P] Define ActivityEntry type (id, attribution, kind enum, summary, detail, parentActivityId, timestamp) with Zod schema in `packages/web-contracts/src/activity.ts`
- [ ] T010 Update barrel export `packages/web-contracts/src/index.ts` to re-export all entity types and schemas
- [ ] T011 Verify T002 tests pass (green) — all entity schemas validate correctly

**Checkpoint**: All 7 entity types defined, validated, exported. Tests pass. `npm run typecheck` passes.

---

## Phase 2: Foundational — Contract Request/Response Types

**Purpose**: Define typed request/response pairs for all 6 owned contract families. Tests first.

- [ ] T012 Write unit tests for all contract Zod schemas in `test/web-contracts/contracts.test.ts` (red)
- [ ] T013 [P] Define Conversation Lifecycle contract types (CreateConversation, OpenConversation, ResumeConversation, ArchiveConversation, ListConversations — request + response for each) in `packages/web-contracts/src/contracts/conversation-lifecycle.ts`
- [ ] T014 [P] Define Turn Submission contract types (SubmitInstruction, SubscribeToStream, LoadTurnHistory — request + response) in `packages/web-contracts/src/contracts/turn-submission.ts`
- [ ] T015 [P] Define Approval Flow contract types (GetPendingApprovals, RespondToApproval — request + response) in `packages/web-contracts/src/contracts/approval-flow.ts`
- [ ] T016 [P] Define Work Control contract types (CancelWork, RetryTurn, ForkConversation, ManageInstructionQueue — request + response) in `packages/web-contracts/src/contracts/work-control.ts`
- [ ] T017 [P] Define Artifact Access contract types (ListArtifactsForTurn, GetArtifactContent, ListArtifactsForConversation — request + response) in `packages/web-contracts/src/contracts/artifact-access.ts`
- [ ] T018 [P] Define Multi-Agent Activity contract types (GetActivityEntries, FilterActivityByAgent — request + response) in `packages/web-contracts/src/contracts/multi-agent-activity.ts`
- [ ] T019 [P] Define shared Error Response type (error code, message, conversationId, turnId) in `packages/web-contracts/src/contracts/error.ts`
- [ ] T020 Update barrel export `packages/web-contracts/src/index.ts` to re-export all contract types
- [ ] T021 Verify T012 tests pass (green) — all contract schemas validate correctly

**Checkpoint**: All 6 owned contract families typed and validated. Full `packages/web-contracts` package is complete.

---

## Phase 3: User Story 1 — Open and Continue a Conversation (Priority: P1) 🎯 MVP

**Goal**: An operator can create a conversation, add turns, close the browser, reopen it, and see full history in order. A turn = one operator instruction + resulting system work.

**Independent Test**: Create conversation → add turns → "reconnect" → verify all turns present and ordered.

**Delivers**: FR-001, FR-002, FR-006 | SC-001

- [ ] T022 [US1] Create test fixtures: sample conversations with varying turn counts (0, 1, 10, 100) in `test/fixtures/conversation/sample-conversations.ts`
- [ ] T023 [US1] Write unit tests for ConversationStore (red): create, append turns, retrieve ordered, retrieve windowed range, persistence round-trip in `test/conversation-store.test.ts`
- [ ] T024 [US1] Implement ConversationStore class with event-sourced persistence in `lib/daemon/conversation-store.ts` — createConversation, getConversation, listConversations methods
- [ ] T025 [US1] Implement Turn persistence in ConversationStore — appendTurn (kind: `operator`|`system`), getTurns (full), getTurnsByRange (windowed per FR-014) methods in `lib/daemon/conversation-store.ts`
- [ ] T026 [US1] Integrate ConversationStore with daemon event log — conversation mutations emit EventRecords with category `conversation` to existing event persistence in `lib/daemon/conversation-store.ts`
- [ ] T027 [US1] Implement snapshot support for ConversationStore — conversations are included in daemon state snapshots for fast recovery, extending `lib/daemon/state.ts`
- [ ] T028 [US1] Verify T023 unit tests pass (green)
- [ ] T029 [US1] Write failing integration test: create conversation → add 5 turns → restart daemon → verify all turns present and ordered in `test/conversation-protocol.integration.test.ts`
- [ ] T030 [US1] Add conversation read routes to daemon — `GET /conversations`, `GET /conversations/:id`, `GET /conversations/:id/turns` with windowed pagination, in `lib/daemon/conversation-routes.ts`
- [ ] T031 [US1] Add conversation write routes to daemon — `POST /conversations` (create), `POST /conversations/:id/turns` (submit instruction), in `lib/daemon/conversation-routes.ts`
- [ ] T032 [US1] Verify T029 integration test passes (green)

**Checkpoint**: US1 fully functional — conversations persist across daemon restarts, turns are ordered, windowed retrieval works.

---

## Phase 4: User Story 2 — Stream Progress During Active Work (Priority: P1)

**Goal**: Operator sees live incremental streaming while work executes — partial text, status changes, activity markers. Events are nested within the active turn.

**Independent Test**: Submit instruction → observe incremental StreamEvents before final result → verify stream terminates cleanly.

**Delivers**: FR-003, FR-004 | SC-002

- [ ] T033 [US2] Write unit tests for StreamManager (red): create stream, emit events, complete, fail, subscribe from midpoint in `test/stream-manager.test.ts`
- [ ] T034 [US2] Implement StreamManager class in `lib/daemon/stream-manager.ts` — createStream, emitEvent, completeStream, failStream methods with sequence number assignment
- [ ] T035 [US2] Implement stream subscription in StreamManager — subscribe(turnId, lastSeq) returns an async iterable of StreamEvents from the given sequence onward in `lib/daemon/stream-manager.ts`
- [ ] T036 [US2] Integrate StreamManager with daemon event log — each StreamEvent is persisted as an EventRecord so streams survive daemon restart in `lib/daemon/stream-manager.ts`
- [ ] T037 [US2] Implement stream lifecycle signals — emit `stream-started`, `stream-completed`, `stream-failed` events as StreamEvent kind values in `lib/daemon/stream-manager.ts`
- [ ] T038 [US2] Finalize turn content on stream completion — consolidate streamed text-delta events into the turn's `response` field in `lib/daemon/stream-manager.ts`
- [ ] T039 [US2] Verify T033 unit tests pass (green)
- [ ] T040 [US2] Write failing integration test: submit instruction → collect all stream events → verify ordering, completeness, and sub-second delivery in `test/conversation-protocol.integration.test.ts`
- [ ] T041 [US2] Add stream routes to daemon — `GET /conversations/:id/turns/:turnId/stream?since=SEQ` for stream subscription in `lib/daemon/conversation-routes.ts`
- [ ] T042 [US2] Verify T040 integration test passes (green)

**Checkpoint**: US2 functional — streams deliver incremental events, lifecycle signals work, events persist, turn `response` is populated on completion.

---

## Phase 5: User Story 3 — Respond to Approvals and Follow-Up Requests (Priority: P1)

**Goal**: System pauses for operator input during work; operator responds inline; work resumes. Approval responses are recorded as events within the active turn, NOT as separate turns.

**Independent Test**: Trigger approval → verify prompt appears → submit response → verify work resumes and response is recorded within the turn.

**Delivers**: FR-005 | SC-003

- [ ] T043 [US3] Write unit tests for ApprovalStore (red): create, respond, staleness detection, lifecycle transitions in `test/conversation-store.test.ts`
- [ ] T044 [US3] Implement ApprovalStore in `lib/daemon/conversation-store.ts` — createApprovalRequest, getPendingApprovals, respondToApproval methods with status lifecycle (pending → responded | expired | stale)
- [ ] T045 [US3] Implement context-hash staleness detection — on view or respond, compare current context hash to stored hash; transition to `stale` if mismatched in `lib/daemon/conversation-store.ts`
- [ ] T046 [US3] Integrate approval events into stream — emit `approval-prompt` StreamEvent when an approval is created; emit `approval-response` StreamEvent when operator responds (response is a nested event, not a separate turn) in `lib/daemon/stream-manager.ts`
- [ ] T047 [US3] Verify T043 unit tests pass (green)
- [ ] T048 [US3] Write failing integration test: trigger approval during streaming → respond → verify work continuation, response recorded within turn, no separate approval-response turn created in `test/conversation-protocol.integration.test.ts`
- [ ] T049 [US3] Add approval routes to daemon — `GET /conversations/:id/approvals` (pending), `POST /approvals/:id/respond` (accepts opaque sessionId for conflict attribution) in `lib/daemon/conversation-routes.ts`
- [ ] T050 [US3] Verify T048 integration test passes (green)

**Checkpoint**: US3 functional — approvals pause work, operator responds, response is recorded as event within turn, work resumes, staleness detected.

---

## Phase 6: User Story 4 — Recover from Refresh, Reconnect, and Interruption (Priority: P2)

**Goal**: Browser reconnects and sees authoritative state including output produced during disconnection. Browser session management itself is owned by web-session-and-auth; this phase covers only the conversation-level resume/catch-up contract.

**Independent Test**: Start streaming → disconnect → reconnect with last seq → verify no conversation-relevant events are missing.

**Delivers**: FR-006, FR-007 | SC-004

- [ ] T051 [US4] Write unit tests for Resume Conversation handler (red): accept (conversationId, lastAcknowledgedSeq), verify all events since that seq are returned in `test/conversation-routes.test.ts`
- [ ] T052 [US4] Implement Resume Conversation contract handler — accept (conversationId, lastAcknowledgedSeq), return all events since that seq plus current conversation status in `lib/daemon/conversation-routes.ts`
- [ ] T053 [US4] Verify T051 unit tests pass (green)
- [ ] T054 [US4] Write failing integration test: start streaming → simulate disconnect (stop reading) → reconnect with last seq → verify all missed conversation-relevant events arrive in order in `test/conversation-protocol.integration.test.ts`
- [ ] T055 [US4] Write failing integration test: approval issued during disconnection → reconnect → verify approval is still pending and actionable (SC-003 end-to-end) in `test/conversation-protocol.integration.test.ts`
- [ ] T056 [US4] Verify T054 and T055 integration tests pass (green)

**Checkpoint**: US4 functional — reconnect resumes from correct point, no data loss, pending approvals survive disconnection.

---

## Phase 7: User Story 5 — Cancel, Retry, and Fork Work (Priority: P2)

**Goal**: Operator can cancel in-progress work, retry failed turns, and fork conversations.

**Independent Test**: Cancel mid-stream, retry a failed turn, fork from turn N, verify all behaviors.

**Delivers**: FR-008, FR-009, FR-010, FR-013 | SC-005, SC-006

- [ ] T057 [US5] Write unit tests for cancel, retry, fork, and instruction queue (red) in `test/conversation-store.test.ts`
- [ ] T058 [US5] Implement cancel handler in StreamManager — stop active stream, transition turn to `cancelled`, emit `cancellation` StreamEvent in `lib/daemon/stream-manager.ts`
- [ ] T059 [US5] Implement retry handler in ConversationStore — create new turn linked to original via parentTurnId, trigger re-execution in `lib/daemon/conversation-store.ts`
- [ ] T060 [US5] Implement fork handler in ConversationStore — create child conversation with parentConversationId and forkPointTurnId, implement reference-based turn reading for pre-fork history in `lib/daemon/conversation-store.ts`
- [ ] T061 [US5] Implement instruction queue in ConversationStore — queue instructions when work is in progress, dequeue on completion/cancellation, support reorder and remove in `lib/daemon/conversation-store.ts`
- [ ] T062 [US5] Verify T057 unit tests pass (green)
- [ ] T063 [US5] Write failing integration tests in `test/conversation-protocol.integration.test.ts`:
  - cancel mid-stream → verify stream stops within 5 seconds and conversation accepts new instruction (SC-005)
  - fork from turn N → verify child has exactly turns 1..N (SC-006)
  - submit instruction while work in progress → verify it is queued → complete first work → verify queued instruction executes
- [ ] T064 [US5] Add work control routes to daemon — `POST /conversations/:id/turns/:turnId/cancel`, `POST /conversations/:id/turns/:turnId/retry`, `POST /conversations/:id/fork`, `GET/POST /conversations/:id/queue` in `lib/daemon/conversation-routes.ts`
- [ ] T065 [US5] Verify T063 integration tests pass (green)

**Checkpoint**: US5 functional — cancel/retry/fork/queue all work, forked conversations have correct lineage.

---

## Phase 8: User Story 6 — View Artifacts Produced by Work (Priority: P2)

**Goal**: Artifacts are associated with turns and accessible in conversation history.

**Independent Test**: Produce artifact → view in turn → refresh → verify still accessible.

**Delivers**: FR-011 | SC-007

- [ ] T066 [US6] Create artifact test fixtures: sample artifacts of each kind (file, diff, test-result, log, plan, structured-data) in `test/fixtures/conversation/sample-artifacts.ts`
- [ ] T067 [US6] Write unit tests for ArtifactStore (red): create, retrieve by turn, retrieve content by id, list by conversation with pagination in `test/conversation-store.test.ts`
- [ ] T068 [P] [US6] Implement ArtifactStore in `lib/daemon/conversation-store.ts` — createArtifact, getArtifactsForTurn, getArtifactContent, listArtifactsForConversation methods with on-demand content loading
- [ ] T069 [US6] Integrate artifact creation into stream — emit `artifact-notice` StreamEvent when an artifact is produced during turn execution in `lib/daemon/stream-manager.ts`
- [ ] T070 [US6] Verify T067 unit tests pass (green)
- [ ] T071 [US6] Write failing integration test: produce artifact during turn → retrieve → refresh → retrieve again (SC-007) in `test/conversation-protocol.integration.test.ts`
- [ ] T072 [US6] Add artifact routes to daemon — `GET /turns/:turnId/artifacts`, `GET /artifacts/:id`, `GET /conversations/:id/artifacts` in `lib/daemon/conversation-routes.ts`
- [ ] T073 [US6] Verify T071 integration test passes (green)

**Checkpoint**: US6 functional — artifacts persist, are associated with turns, load on demand.

---

## Phase 9: User Story 7 — Understand Multi-Agent and Council Activity (Priority: P3)

**Goal**: Multi-agent work is representable with per-agent attribution and structured council entries. Activity entries are nested within turns.

**Independent Test**: Trigger multi-agent work → verify per-agent attribution → verify council deliberation is structured.

**Delivers**: FR-012 | SC-008

- [ ] T074 [US7] Create activity test fixtures: sample multi-agent and council deliberation scenarios in `test/fixtures/conversation/sample-activities.ts`
- [ ] T075 [US7] Write unit tests for activity storage (red): append, retrieve, filter by agent, nesting via parentActivityId in `test/conversation-store.test.ts`
- [ ] T076 [P] [US7] Implement ActivityEntry storage in ConversationStore — appendActivity, getActivitiesForTurn, filterByAgent methods in `lib/daemon/conversation-store.ts`
- [ ] T077 [US7] Integrate activity markers into stream — emit `activity-marker` StreamEvents with agent attribution during multi-agent execution in `lib/daemon/stream-manager.ts`
- [ ] T078 [US7] Verify T075 unit tests pass (green)
- [ ] T079 [US7] Write failing integration test: multi-agent turn → query by agent identity → verify correct attribution (SC-008) in `test/conversation-protocol.integration.test.ts`
- [ ] T080 [US7] Add multi-agent activity routes — `GET /turns/:turnId/activities`, `GET /turns/:turnId/activities?agent=NAME` in `lib/daemon/conversation-routes.ts`
- [ ] T081 [US7] Verify T079 integration test passes (green)

**Checkpoint**: US7 functional — multi-agent activity is structured, attributable, and queryable.

---

## Phase 10: Multi-Session Consistency (Cross-Cutting)

**Purpose**: Ensure multiple browser sessions see the same authoritative state (FR-015, SC-009). Uses opaque sessionId from web-session-and-auth — does NOT own session registration or heartbeat.

- [ ] T082 Write unit tests for conflict resolution (red): first-write-wins with notification to other sessions in `test/conversation-store.test.ts`
- [ ] T083 Implement conflict resolution in ApprovalStore — first-write-wins with notification payload for other sessions when a conflicting response arrives in `lib/daemon/conversation-store.ts`
- [ ] T084 Verify T082 unit tests pass (green)
- [ ] T085 Write integration test: two sessions (identified by opaque sessionId) view same conversation → one responds to approval → verify first-write-wins and conflict notification payload (SC-009) in `test/conversation-protocol.integration.test.ts`
- [ ] T086 Verify T085 integration test passes (green)

**Checkpoint**: Multi-session consistency verified. Session lifecycle is owned by web-session-and-auth; this phase only validates daemon-side conflict resolution.

---

## Phase 11: Polish

**Purpose**: Documentation, cleanup, and hardening

- [ ] T087 [P] Update `docs/web-interface/04-protocol.md` to reference the implemented contract types in `packages/web-contracts`
- [ ] T088 [P] Add JSDoc comments to all exported types and functions in `packages/web-contracts/src/`
- [ ] T089 [P] Add JSDoc comments to all exported functions in `lib/daemon/conversation-store.ts`, `lib/daemon/stream-manager.ts`, `lib/daemon/conversation-routes.ts`
- [ ] T090 [P] Run `npm run quality` (lint + format + typecheck) and fix any violations
- [ ] T091 [P] Run `npm run test:coverage:check` and verify conversation-related code meets the repository's configured c8 coverage threshold (80% — see `npm run test:coverage:check`)
- [ ] T092 [P] Update `docs/ARCHITECTURE.md` to include conversation protocol module descriptions
- [ ] T093 Verify all 9 success criteria (SC-001 through SC-009) pass via integration test suite in `test/conversation-protocol.integration.test.ts`

**Checkpoint**: All quality gates pass. Feature complete.

---

## Dependencies & Execution Order

```
External Prerequisites:
  web-repl-foundation ─────────────────────────────────┐
  web-session-and-auth (opaque IDs only) ──────────────┤
                                                        │
Phase 1 (Entity Types) ──┐                             │
                          ├─► Phase 2 (Contract Types)  │
                          │     └─► Phase 3 (US1: Conversations) 🎯 MVP
                          │           └─► Phase 4 (US2: Streaming)
                          │                 ├─► Phase 5 (US3: Approvals)
                          │                 │     └─► Phase 6 (US4: Reconnect)
                          │                 ├─► Phase 7 (US5: Cancel/Retry/Fork)
                          │                 ├─► Phase 8 (US6: Artifacts)
                          │                 └─► Phase 9 (US7: Multi-Agent)
                          │
                          └─► (all phases) ─► Phase 10 (Multi-Session)
                                                 └─► Phase 11 (Polish)
```

### Parallel Execution Opportunities

**Within Phase 1**: T003–T009 are fully parallel (independent entity type files).
**Within Phase 2**: T013–T019 are fully parallel (independent contract family files).
**After Phase 4 (Streaming)**: Phases 5, 7, 8, and 9 can run in parallel — they depend on conversations + streaming but not on each other.
**Within Phase 11**: T087–T092 are fully parallel (independent documentation/quality tasks).

### TDD Cadence

Every user story phase follows red-green-refactor:

1. **Red**: Write failing tests (unit + integration) that codify the acceptance criteria.
2. **Green**: Implement the minimum code to make tests pass.
3. **Refactor**: Clean up, add JSDoc, verify quality gates.

### Suggested MVP Scope

**User Story 1 alone** (Phases 1–3, tasks T001–T032) delivers a functional conversation model with persistence and windowed retrieval.

**User Stories 1+2** (add Phase 4, tasks T033–T042) adds streaming, making the conversation feel alive. This is the recommended minimum for meaningful demonstration.

---

## Summary

| Metric                             | Count                                         |
| ---------------------------------- | --------------------------------------------- |
| **Total tasks**                    | 93                                            |
| **Foundational types & contracts** | 21 (T001–T021)                                |
| **US1 — Conversations (P1)**       | 11 (T022–T032)                                |
| **US2 — Streaming (P1)**           | 10 (T033–T042)                                |
| **US3 — Approvals (P1)**           | 8 (T043–T050)                                 |
| **US4 — Reconnect (P2)**           | 6 (T051–T056)                                 |
| **US5 — Cancel/Retry/Fork (P2)**   | 9 (T057–T065)                                 |
| **US6 — Artifacts (P2)**           | 8 (T066–T073)                                 |
| **US7 — Multi-Agent (P3)**         | 8 (T074–T081)                                 |
| **Multi-Session**                  | 5 (T082–T086)                                 |
| **Polish**                         | 7 (T087–T093)                                 |
| **Explicit TDD checkpoints**       | 12 (verify-green tasks)                       |
| **External dependencies**          | 2 (web-repl-foundation, web-session-and-auth) |
