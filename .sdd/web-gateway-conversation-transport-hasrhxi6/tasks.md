# Tasks: Web Gateway Conversation Transport

**Generated**: 2026-03-16
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Feature directory**: `.sdd/web-gateway-conversation-transport-hasrhxi6/`

> **Scope guard.** These tasks implement the narrowed transport slice only:
> gateway REST mediation, WebSocket transport, session binding,
> reconnect/resume, daemon event bridge amendments, tests, docs, and
> validation. The following are **deferred** and must NOT be introduced:
> bidirectional WS commands, polling fallback, browser UI,
> multi-operator ownership, shared error contracts in `packages/web-contracts/`,
> snapshot endpoints, fork/queue management, command catalog, or
> transport degraded mode.

## User Stories Reference

| ID  | Title                                                        | Priority |
| --- | ------------------------------------------------------------ | -------- |
| US1 | Operator exchanges conversation messages through the gateway | P1       |
| US2 | Operator receives streaming updates over WebSocket           | P1       |
| US3 | WebSocket connection bound to authenticated session          | P1       |
| US4 | Operator recovers connection and resumes after disconnection | P2       |
| US5 | Operator responds to approvals and controls work via gateway | P2       |
| US6 | Gateway communicates errors and boundaries clearly           | P2       |

## Dependency Legend

- **Depends**: task IDs that must be completed first
- **Validates**: FR/SC identifiers from spec.md
- All tasks follow **TDD**: write failing test → implement → green → refactor

---

## Phase 0 — Gateway Error Shape & Daemon Client Foundation

_Shared plumbing that every subsequent phase imports. No external dependencies._

- [x] T001 [P1] [US6] **TDD: `GatewayErrorResponse` type and `ErrorCategory` enum** — define the five-category structured error shape (`auth`, `session`, `validation`, `daemon`, `rate-limit`) and extend `ErrorCode` union with conversation codes (`CONVERSATION_NOT_FOUND`, `TURN_NOT_FOUND`, `VALIDATION_FAILED`, `WS_INVALID_MESSAGE`, `WS_BUFFER_OVERFLOW`). Write tests asserting category discrimination, `ok: false` literal, and optional fields (`conversationId`, `turnId`, `retryAfterMs`). Implement `apps/web-gateway/src/shared/gateway-error-response.ts`. Extend `apps/web-gateway/src/shared/errors.ts` with new error codes.
  - **Depends**: —
  - **Validates**: FR-026, FR-027

- [x] T002 [P1] [US6] **TDD: `response-translator.ts`** — translate daemon HTTP responses (status codes, `ErrorResponse` bodies from `@hydra/web-contracts`) into `GatewayErrorResponse`. Map every daemon error code to the correct gateway category. Translate fetch failures (network error, timeout) into `{ category: 'daemon', code: 'DAEMON_UNREACHABLE' }`. Write tests for each daemon error code mapping and for daemon-unreachable path. Implement `apps/web-gateway/src/conversation/response-translator.ts`.
  - **Depends**: T001
  - **Validates**: FR-028

- [x] T003 [P1] [US1, US4] **TDD: `daemon-client.ts`** — typed HTTP client wrapping `fetch()` for all daemon conversation endpoints (19 routes: lifecycle, turns, approvals, work control, artifacts, activities, **plus the per-turn stream replay route** `GET /conversations/:convId/turns/:turnId/stream?lastAcknowledgedSeq=N`). The stream replay method is critical for reconnect — it is the daemon-side surface that T032's fallback path consumes. Each method accepts validated request params, calls the daemon, and returns parsed response or translated `GatewayErrorResponse`. Include configurable timeout (default 5s). Write tests with stubbed `fetch` covering success, daemon 4xx/5xx, timeout, and network failure for representative endpoints **including the stream replay route**. Implement `apps/web-gateway/src/conversation/daemon-client.ts`.
  - **Depends**: T001, T002
  - **Validates**: FR-018, FR-019, FR-022

- [x] T004 [P1] [US1, US6] **Quality gate: Phase 0** — run `npm run quality` and `npm test` from monorepo root. Confirm zero regressions, TypeScript strict passes, lint clean.
  - **Depends**: T001, T002, T003
  - **Validates**: SC-011

---

## Phase 1 — Daemon Event Bridge (Daemon-Side Amendment)

_Minimal daemon change enabling push delivery. Must land before any gateway
streaming code. Existing daemon tests must remain green._

- [x] T005 [P1] [US2] **TDD: `event-bridge.ts`** — typed `EventEmitter` wrapper emitting `stream-event` with `{ conversationId: string, event: StreamEvent }` payload. Write tests asserting: events emitted with correct shape, multiple listeners receive the same event, `removeListener`/`removeAllListeners` stops delivery, no event leaks after cleanup. Implement `lib/daemon/event-bridge.ts`. Tests in `test/event-bridge.test.ts`.
  - **Depends**: —
  - **Validates**: FR-020

- [x] T006 [P1] [US2] **TDD: Amend `StreamManager` to emit through event bridge** — add optional `EventBridge` injection to `StreamManager` constructor (default: no-op). After every `state.events.push(event)` in `createStream()`, `emitEvent()`, `completeStream()`, `failStream()`, `cancelStream()`: emit through the bridge with `{ conversationId, event }` (requires `ConversationStore.getTurn(turnId).conversationId` lookup or passing conversationId through stream state). Write tests asserting bridge emission for each event-producing method, including terminal events. Amend `lib/daemon/stream-manager.ts`. Tests in `test/event-bridge.test.ts` or co-located.
  - **Depends**: T005
  - **Validates**: FR-020, SC-012

- [x] T007 [P1] [US2] **Verify zero daemon regressions** — run the full daemon test suite: `test/conversation-routes.test.ts`, `test/conversation-store.test.ts`, `test/conversation-executor.test.ts`, `test/conversation-protocol.integration.test.ts`, `test/stream-manager.test.ts`. All must pass unchanged. The bridge injection is optional so existing tests that don't inject a bridge are unaffected.
  - **Depends**: T006
  - **Validates**: SC-011, SC-012

- [x] T008 [P1] [US2] **Quality gate: Phase 1** — `npm run quality` and `npm test` from monorepo root. Zero regressions.
  - **Depends**: T007
  - **Validates**: SC-011

---

## Phase 2 — Request Validation & Gateway REST Conversation Routes

_REST mediation layer. Delivers US1 (P1). Every route: authenticate → validate →
mediate → translate → respond._

- [x] T009 [P1] [US1] **TDD: `request-validator.ts`** — Hono middleware that runs Zod `.safeParse()` on request bodies/query params against the appropriate `@hydra/web-contracts` schema. Returns `GatewayErrorResponse` with `category: 'validation'` and HTTP 400 on failure. Write tests for valid and invalid payloads for representative contracts (CreateConversationRequest, SubmitInstructionRequest, RespondToApprovalRequest). Implement `apps/web-gateway/src/conversation/request-validator.ts`.
  - **Depends**: T001
  - **Validates**: FR-006, SC-008

- [x] T010 [P1] [US1] **TDD: Conversation lifecycle routes** — `POST /conversations`, `GET /conversations`, `GET /conversations/:id`, `POST /conversations/:id/resume`, `POST /conversations/:id/archive`. Each test creates a gateway app, sends requests with/without valid sessions, asserts correct daemon mediation via `daemon-client` and response shapes conforming to `@hydra/web-contracts`. Implement `apps/web-gateway/src/conversation/conversation-routes.ts` (lifecycle section).
  - **Depends**: T003, T009
  - **Validates**: FR-001, FR-007

- [x] T011 [P1] [US1] **TDD: Turn submission and history routes** — `POST /conversations/:convId/turns`, `GET /conversations/:convId/turns`. Tests assert instruction submission mediates to daemon, turn history returns paginated results, session-to-operator mapping is passed via `X-Session-Id` header. Implement in `apps/web-gateway/src/conversation/conversation-routes.ts` (turns section).
  - **Depends**: T003, T009
  - **Validates**: FR-002, FR-007

- [x] T012 [P2] [US5] **TDD: Approval routes** — `GET /conversations/:convId/approvals`, `POST /approvals/:approvalId/respond`. Tests assert session validation and that mediated approval calls preserve daemon context correctly: operator identity on approval routes, and `X-Session-Id`/session identity on `POST /approvals/:approvalId/respond` for daemon-side conflict attribution. Implement in `apps/web-gateway/src/conversation/conversation-routes.ts` (approvals section).
  - **Depends**: T003, T009
  - **Validates**: FR-003

- [x] T013 [P2] [US5] **TDD: Work control routes** — `POST /conversations/:convId/turns/:turnId/cancel`, `POST /conversations/:convId/turns/:turnId/retry`. Tests assert mediation and correct daemon endpoint targeting. Implement in `apps/web-gateway/src/conversation/conversation-routes.ts` (work-control section).
  - **Depends**: T003, T009
  - **Validates**: FR-004

- [x] T014 [P1] [US1] **TDD: Artifact and activity routes** — `GET /turns/:turnId/artifacts`, `GET /conversations/:convId/artifacts`, `GET /artifacts/:artifactId`, `GET /turns/:turnId/activities`. Tests assert correct path mapping and response forwarding. Implement in `apps/web-gateway/src/conversation/conversation-routes.ts` (artifacts/activities section).
  - **Depends**: T003, T009
  - **Validates**: FR-005

- [x] T015 [P1] [US1] **Wire P1 conversation routes into `createGatewayApp`** — add `conversation/` routes under a protected sub-router with `createAuthMiddleware` + `createCsrfMiddleware` (same pattern as `/session` routes in `apps/web-gateway/src/index.ts`). Wire lifecycle (T010), turn (T011), and artifact/activity (T014) routes. Confirm all wired routes require authenticated sessions. Update `apps/web-gateway/src/index.ts`.
  - **Depends**: T010, T011, T014
  - **Validates**: FR-007, FR-017

- [x] T015b [P2] [US5] **Wire approval & work-control routes into gateway app** — extend the conversation sub-router created in T015 with approval (T012) and work-control (T013) routes under the same auth/CSRF middleware. Update `apps/web-gateway/src/index.ts`.
  - **Depends**: T015, T012, T013
  - **Validates**: FR-003, FR-004, FR-017

- [x] T016 [P1] [US1] **Quality gate: Phase 2** — `npm run quality` and `npm test` from monorepo root. Verify REST mediation is end-to-end functional for P1 lifecycle, turn, and artifact routes (approval & work-control routes land in Phase 6 via T015b).
  - **Depends**: T015
  - **Validates**: SC-001 (REST path), SC-004, SC-008, SC-011

---

## Phase 3 — WebSocket Server, Session Binding & Connection Registry

_WebSocket infrastructure with full session security. Delivers US3 (P1) and the
foundation for US2 streaming. Requires `ws` dependency._

- [x] T017 [P1] [US3] **Add `ws` dependency** — `npm install ws` and `npm install -D @types/ws` in `apps/web-gateway/`. Verify `npm run quality` passes. Update `apps/web-gateway/package.json`.
  - **Depends**: —
  - **Validates**: —

- [x] T018 [P1] [US2, US3] **TDD: `ws-protocol.ts`** — define Zod schemas for all client→server messages (`subscribe`, `unsubscribe`, `ack`) and server→client messages (`stream-event`, `subscribed`, `unsubscribed`, `session-terminated`, `session-expiring-soon`, `daemon-unavailable`, `daemon-restored`, `error`). Write round-trip parse/serialize tests asserting schema validation accepts valid messages and rejects malformed ones. Implement `apps/web-gateway/src/transport/ws-protocol.ts`.
  - **Depends**: T001
  - **Validates**: FR-013

- [x] T019 [P1] [US3] **TDD: `connection-registry.ts`** — `register(connection)`, `unregister(connectionId)`, `getBySession(sessionId)`, `getByConversation(conversationId)`, `addSubscription(connectionId, conversationId)`, `removeSubscription(connectionId, conversationId)`, `closeAllForSession(sessionId)`. Write tests for: indexing correctness, cleanup on disconnect, multi-tab scenarios (multiple connections per session), `closeAllForSession` cleans all indices. Implement `apps/web-gateway/src/transport/connection-registry.ts`.
  - **Depends**: —
  - **Validates**: FR-014

- [x] T020 [P1] [US3] **TDD: `ws-connection.ts`** — per-connection lifecycle model: creation (binds `sessionId` from upgrade request, generates `connectionId` via `crypto.randomUUID()`), state machine (`open` → `closing` → `closed`), message dispatch, close handling with registry cleanup. Write tests for session-binding immutability, state transitions, graceful close. Implement `apps/web-gateway/src/transport/ws-connection.ts`.
  - **Depends**: T019
  - **Validates**: FR-014

- [x] T021 [P1] [US3] **TDD: `ws-server.ts`** — `ws.WebSocketServer` setup with `noServer: true`, attached to Node.js `http.Server` via `upgrade` event on `/ws` path. Upgrade handler: parse `__session` cookie, validate session via `SessionService.validate()`, validate Origin header against `allowedOrigin`, reject with 401/403 on failure, register connection on success. Write tests for: valid session → connection established, expired session → 401, missing cookie → 401, wrong origin → 403, non-`/ws` upgrade → socket destroyed. Implement `apps/web-gateway/src/transport/ws-server.ts`.
  - **Depends**: T017, T019, T020
  - **Validates**: FR-008, FR-009, SC-006

- [x] T022 [P1] [US3] **TDD: Session & daemon lifecycle → WS bridge** — wire the existing `SessionStateBroadcaster` and `DaemonHeartbeat` primitives into WS connection lifecycle. **Plumbing required** (these are not pre-wired — the gateway currently has the building blocks but no WS integration):
  1. On WS connection open: call `SessionStateBroadcaster.register(sessionId, callback)` with a callback that translates session state-change events into WS protocol messages. On connection close: call `SessionStateBroadcaster.unregister(sessionId, callback)`.
  2. The `DaemonHeartbeat` already transitions sessions to `daemon-unreachable` / back to `active` via `SessionService`, which should trigger `SessionStateBroadcaster` callbacks. Verify this end-to-end chain: `DaemonHeartbeat.tick()` → `sessionService.markDaemonDown()` → session state change → `SessionStateBroadcaster.broadcast()` → WS callback → send `daemon-unavailable` message. If any link in this chain is missing (e.g., `SessionService` does not call the broadcaster on state transition), add the missing bridge here.
  3. Map session states to WS messages: terminal states (`expired`, `invalidated`, `logged-out`) → `session-terminated` + close all connections via `ConnectionRegistry.closeAllForSession()`; `expiring-soon` → `session-expiring-soon`; `daemon-unreachable` → `daemon-unavailable`; recovery from `daemon-unreachable` → `daemon-restored`.
     Write tests asserting: session expiry terminates connections within ≤ 5s (SC-005), logout terminates immediately, expiring-soon notification delivered, **daemon-unavailable and daemon-restored messages reach all open connections when `DaemonHeartbeat` transitions session state**. Implement within `apps/web-gateway/src/transport/ws-server.ts` or a dedicated `session-ws-bridge.ts`.
  - **Depends**: T019, T021
  - **Validates**: FR-015, FR-016, FR-021, SC-005

- [x] T023 [P1] [US2, US3] **Wire WebSocket server into gateway app** — extend `createGatewayApp` to accept `server: http.Server` parameter, attach `ws.WebSocketServer`, export connection registry for test access. Update `apps/web-gateway/src/index.ts`. Write integration test: create gateway with HTTP server, establish WebSocket connection with valid session, verify connection appears in registry.
  - **Depends**: T015, T021, T022
  - **Validates**: FR-008

- [x] T024 [P1] [US3] **Quality gate: Phase 3** — `npm run quality` and `npm test`. WebSocket handshake, session binding, and lifecycle all passing.
  - **Depends**: T023
  - **Validates**: SC-004, SC-005, SC-006, SC-011

---

## Phase 4 — Stream Event Forwarding (Daemon → Gateway → Browser)

_Wires daemon event bridge to WebSocket connections. Delivers US2 (P1). Introduces
the event buffer and subscription message handling._

- [x] T025 [P1] [US2, US4] **TDD: `event-buffer.ts`** — bounded per-conversation ring buffer. `push(conversationId, event)`: append, evict oldest if at capacity. `getEventsSince(conversationId, sinceSeq)`: return events with `seq > sinceSeq` in order. `getHighwaterSeq(conversationId)`: return newest seq or 0. `hasEventsSince(conversationId, sinceSeq)`: check buffer coverage. `evictConversation(conversationId)`: remove buffer. Default capacity 1000, configurable. Write tests for: insertion, eviction at boundary, retrieval correctness, empty buffer, seq-based filtering, gap-free ordering guarantee, capacity enforcement. Implement `apps/web-gateway/src/transport/event-buffer.ts`. Tests in `apps/web-gateway/src/__tests__/event-buffer.test.ts`.
  - **Depends**: —
  - **Validates**: FR-022

- [x] T026 [P1] [US2] **TDD: `ws-message-handler.ts`** — handle `subscribe`, `unsubscribe`, and `ack` messages. On `subscribe`: validate conversationId exists via `daemon-client` existence check, add to `ConnectionRegistry`, respond with `subscribed` + `currentSeq`. **Replay barrier**: if `lastAcknowledgedSeq` is provided and the buffer covers the range, set `replayState.set(conversationId, 'replaying')` before sending buffered events. While the conversation's replay state is `'replaying'`, the event forwarder (T027) MUST queue live events for that conversation in the per-conversation pending queue (`pendingEvents.get(conversationId)`) rather than sending immediately; events for other conversations on the same connection are unaffected. After buffer replay completes, flush the per-conversation pending queue (deduplicate by `seq`, discard any `seq ≤ lastReplayedSeq`), set `replayState.set(conversationId, 'live')`, and resume normal forwarding. On `unsubscribe`: remove from registry, delete `replayState` and `pendingEvents` entries for the conversation, respond `unsubscribed`. On `ack`: update connection's `lastAckSeq`. On invalid message: respond `type: 'error'` without closing connection (FR-013). Write tests for each flow including malformed messages, subscribe-with-seq buffer-hit replay, **concurrent live event arrival during replay (assert held back, then flushed in order)**, **and simultaneous replay on one conversation while another conversation remains live on the same connection**. Implement `apps/web-gateway/src/transport/ws-message-handler.ts`.
  - **Depends**: T003, T018, T019, T025
  - **Validates**: FR-010, FR-013, FR-022, FR-024

- [x] T027 [P1] [US2] **TDD: `event-forwarder.ts`** — subscribe to daemon `EventBridge` `stream-event` emissions. For each event: (a) push to `EventBuffer`, (b) look up connections subscribed to `conversationId` via `ConnectionRegistry.getByConversation()`, (c) **check each connection's per-conversation replay state**: if `replayState.get(conversationId)` is `'replaying'` (set by T026's replay barrier), append the event to `pendingEvents.get(conversationId)` instead of sending immediately; if the conversation's state is `'live'` (or has no entry), serialize as `stream-event` WS message per `ws-protocol` and send. Write tests asserting: single subscriber receives event, multiple subscribers all receive, unsubscribed connections excluded, event payload matches daemon `StreamEvent` shape, buffer is populated on every forward, **a conversation in `replaying` state does NOT receive live events until replay completes (events are queued and flushed in order)**, **and a connection replaying conversation A still delivers live events for conversation B without delay**. Implement `apps/web-gateway/src/transport/event-forwarder.ts`.
  - **Depends**: T005, T018, T019, T025
  - **Validates**: FR-010, FR-011, FR-024, SC-012

- [x] T028 [P1] [US2] **TDD: Multi-tab event forwarding** — write tests asserting that multiple connections (different tabs, same session) subscribed to the same conversation all receive the same stream events. One tab submits instruction via REST, both tabs see events. Tests in `apps/web-gateway/src/__tests__/event-forwarder.test.ts`.
  - **Depends**: T027
  - **Validates**: FR-010 (edge case)

- [x] T029 [P1] [US2] **TDD: Buffer overflow / backpressure handling** — when a connection's WebSocket send buffer backs up (slow client), the gateway closes the connection with `WS_BUFFER_OVERFLOW` structured error so the browser can reconnect via resume flow. Write tests with artificial backpressure. Implement in `apps/web-gateway/src/transport/event-forwarder.ts`.
  - **Depends**: T027
  - **Validates**: FR-013 (edge case)

- [x] T030 [P1] [US2] **Integration test: end-to-end streaming** — create full gateway app with daemon + event bridge, authenticate, open WebSocket, subscribe to conversation, submit instruction via REST, assert stream events (`stream-started`, `text-delta`, `stream-completed`) arrive through WebSocket as daemon produces them. Verify sequence numbers are monotonic. Implement `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T015, T023, T026, T027
  - **Validates**: SC-001 (full path), SC-002, SC-012

- [x] T031 [P1] [US2] **Quality gate: Phase 4** — `npm run quality` and `npm test`. Full streaming pipeline functional.
  - **Depends**: T030
  - **Validates**: SC-011

---

## Phase 5 — Reconnect/Resume (Daemon Fallback & Ordering Guarantees)

_Completes reconnect protocol with daemon fallback for buffer misses. Delivers US4 (P2)._

- [x] T032 [P2] [US4] **TDD: Daemon fallback replay** — when `subscribe` with `lastAcknowledgedSeq` arrives and `EventBuffer.hasEventsSince()` returns false (requested seq < buffer's `oldestSeq`), fall back to daemon per-turn replay: (a) list active/recent turns for the conversation via `daemon-client`, (b) call the daemon-client's stream replay method (wrapping `GET /conversations/:convId/turns/:turnId/stream?lastAcknowledgedSeq=N` — coverage established in T003) for each relevant turn, (c) merge and deduplicate per-turn results into single ordered replay stream keyed by `seq`, (d) forward replayed events to client while maintaining the T026 per-conversation replay barrier (`replayState.get(conversationId)` stays `'replaying'`; live events for this conversation queued by T027), (e) after all daemon-fetched events are sent, flush `pendingEvents.get(conversationId)` and set `replayState.set(conversationId, 'live')`. Write tests for fallback path including multi-turn conversations, turns with no missed events, **and concurrent live event arrival during daemon-sourced replay**. Implement in `apps/web-gateway/src/transport/ws-message-handler.ts` (extend subscribe handler).
  - **Depends**: T003 (stream replay route coverage), T025, T026 (replay barrier)
  - **Validates**: FR-022, FR-024

- [x] T033 [P2] [US4] **TDD: End-to-end reconnect flow** — test full reconnect cycle: (a) authenticate + establish WS + subscribe, (b) receive some events, (c) disconnect mid-stream, (d) reconnect with new WS on same session, (e) send `subscribe` with `lastAcknowledgedSeq`, (f) assert all missed events replayed in order, (g) live streaming resumes seamlessly. Test both buffer-hit path and daemon-fallback path. Implement in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T030, T032
  - **Validates**: FR-022, FR-023, SC-003

- [x] T034 [P2] [US4] **TDD: Replay ordering guarantees** — write tests asserting FR-024: replayed events preserve original ordering and sequence numbers with zero reordering, zero gaps, zero duplicates. Include tests where events arrive during the replay window and where daemon fallback merges events from multiple turns. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T033
  - **Validates**: FR-024

- [x] T035 [P2] [US4] **TDD: Reconnect with invalid session** — reconnect attempt with expired or invalidated session is rejected before any events are replayed (FR-025). Write negative tests: expired session → 401 on WS upgrade, invalidated session → 401 on WS upgrade. Tests in `apps/web-gateway/src/__tests__/ws-connection.test.ts`.
  - **Depends**: T021, T032
  - **Validates**: FR-025, SC-004

- [x] T036 [P2] [US4] **TDD: Page refresh scenario** — simulate full page refresh: establish connection, receive events, close connection (page unload), create new connection with same session, subscribe with last ack seq, assert replay + live resume. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T033
  - **Validates**: FR-023

- [x] T037 [P2] [US4] **Quality gate: Phase 5** — `npm run quality` and `npm test`. Reconnect/resume fully functional.
  - **Depends**: T036
  - **Validates**: SC-003, SC-011

---

## Phase 6 — Approval, Work Control & Artifact Mediation Round-Trips

_Verifies control operations via REST produce correct WebSocket events. Delivers US5 (P2)._

- [x] T038 [P2] [US5] **TDD: Approval round-trip** — submit instruction that triggers approval (via daemon executor mock), assert `approval-prompt` stream event arrives through WebSocket, submit approval response via REST `POST /approvals/:approvalId/respond`, assert daemon resumes work and resume events flow through WebSocket. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T030, T012, T015b
  - **Validates**: FR-003, FR-010

- [x] T039 [P2] [US5] **TDD: Cancel round-trip** — submit instruction, start receiving stream events, send `POST /conversations/:convId/turns/:turnId/cancel` via REST, assert `cancellation` stream event arrives through WebSocket and stream stops cleanly. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T030, T013, T015b
  - **Validates**: FR-004

- [x] T040 [P2] [US5] **TDD: Retry round-trip** — fail a turn, send `POST /conversations/:convId/turns/:turnId/retry` via REST, assert new stream starts and events flow through WebSocket. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T030, T013, T015b
  - **Validates**: FR-004

- [x] T041 [P2] [US5] **TDD: Artifact notice forwarding** — daemon emits `artifact-notice` stream event during work, assert it arrives through WebSocket with correct typed payload. Tests in `apps/web-gateway/src/transport/__tests__/event-forwarder.test.ts`.
  - **Depends**: T027
  - **Validates**: FR-005, FR-010

- [x] T042 [P2] [US5] **Quality gate: Phase 6** — `npm run quality` and `npm test`. Control round-trips verified.
  - **Depends**: T038, T039, T040, T041
  - **Validates**: SC-001 (complete lifecycle), SC-011

---

## Phase 7 — Error Boundaries & Edge Cases

_Systematic verification of every error category and spec edge case. Delivers US6 (P2)._

- [x] T043 [P2] [US6] **TDD: Daemon unavailable — REST path** — stub daemon as unreachable, send conversation requests to each REST route category, assert `GatewayErrorResponse` with `category: 'daemon'`, HTTP 503, `code: 'DAEMON_UNREACHABLE'`. Tests in `apps/web-gateway/src/__tests__/conversation-routes.test.ts`.
  - **Depends**: T015
  - **Validates**: FR-021, SC-007

- [x] T044 [P2] [US6] **TDD: Daemon unavailable — WebSocket path** — establish WebSocket connection, trigger daemon heartbeat failure (mock `DaemonHeartbeat`), assert `daemon-unavailable` event arrives through WebSocket via the `DaemonHeartbeat` → `SessionStateBroadcaster` → WS bridge wired in T022. Connection stays open for grace period. Trigger heartbeat recovery, assert `daemon-restored` event arrives through the same bridge. **Precondition**: T022 must have wired the full chain from `DaemonHeartbeat.tick()` through session state transitions to WS message delivery; this task validates that chain end-to-end, not just the WS message shape. Tests in `apps/web-gateway/src/__tests__/ws-connection.test.ts`.
  - **Depends**: T022, T023
  - **Validates**: FR-021, SC-007

- [x] T045 [P2] [US6] **TDD: Validation errors on every REST route** — send malformed request bodies to each conversation REST route, assert `GatewayErrorResponse` with `category: 'validation'`, HTTP 400, `code: 'VALIDATION_FAILED'`. Tests in `apps/web-gateway/src/__tests__/request-validator.test.ts`.
  - **Depends**: T015
  - **Validates**: FR-006, SC-008

- [x] T046 [P2] [US6] **TDD: Rate limit errors** — exceed mutating rate limit on conversation REST routes, assert `GatewayErrorResponse` with `category: 'rate-limit'`, HTTP 429, `retryAfterMs` present. Tests in `apps/web-gateway/src/__tests__/conversation-routes.test.ts`.
  - **Depends**: T015
  - **Validates**: FR-017, FR-027

- [x] T047 [P2] [US6] **TDD: Auth/session errors on REST** — send requests without session cookie, with expired session, with invalidated session to conversation REST routes. Assert `GatewayErrorResponse` with `category: 'auth'` or `category: 'session'` as appropriate. Tests in `apps/web-gateway/src/__tests__/conversation-routes.test.ts`.
  - **Depends**: T015
  - **Validates**: FR-007, SC-004

- [x] T048 [P2] [US6] **TDD: Malformed WebSocket messages** — send invalid JSON, unknown message types, messages with missing required fields, and oversized messages through WebSocket. Assert structured `type: 'error'` response with `category: 'validation'` for each, WITHOUT terminating the connection (SC-010). Tests in `apps/web-gateway/src/__tests__/ws-message-handler.test.ts`.
  - **Depends**: T026
  - **Validates**: FR-013, SC-010

- [x] T049 [P2] [US2] **TDD: Multi-tab edge case** — two tabs connected to same conversation via same session, one tab submits instruction via REST, both tabs receive all stream events identically. Verify no event duplication or omission. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T030
  - **Validates**: FR-010 (edge case)

- [x] T050 [P2] [US2] **TDD: Idle WebSocket connection** — connection established and authenticated but no `subscribe` messages sent. Assert connection stays alive and valid, receives session lifecycle notifications (`session-expiring-soon`, `daemon-unavailable`) but no stream events. Tests in `apps/web-gateway/src/__tests__/ws-connection.test.ts`.
  - **Depends**: T022
  - **Validates**: FR-014 (edge case)

- [x] T051 [P2] [US6] **TDD: Conversation not found on subscribe** — send `subscribe` with non-existent `conversationId` through WebSocket. Assert `CONVERSATION_NOT_FOUND` error via `type: 'error'` message without leaking daemon internals. Connection remains open. Tests in `apps/web-gateway/src/__tests__/ws-message-handler.test.ts`.
  - **Depends**: T026
  - **Validates**: FR-028 (edge case)

- [x] T052 [P2] [US4] **TDD: Gateway restart contract** — document and test that all WebSocket connections are lost on gateway restart. Browser treats this as disconnection and uses reconnect/resume flow. Test asserts no state survives process restart. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T033
  - **Validates**: FR-022 (edge case)

- [x] T053 [P2] [US6] **Quality gate: Phase 7** — `npm run quality` and `npm test`. All error boundaries and edge cases verified.
  - **Depends**: T052
  - **Validates**: SC-007, SC-008, SC-010, SC-011

---

## Phase 8 — Integration Tests, Quality Gates & Documentation

_End-to-end verification of all success criteria and final documentation._

- [x] T054 [P1] [US1, US2] **End-to-end transport test** — single comprehensive test exercising the full US1+US2 path: authenticate → create conversation → submit instruction → receive stream events through WebSocket → load turn history via REST → verify zero direct browser-to-daemon communication. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T031, T037
  - **Validates**: SC-001

- [x] T055 [P1] [US2] **Latency measurement test** — verify SC-002: timestamp stream events at daemon production and browser receipt; assert ≤ 500ms delta under loopback conditions. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T030
  - **Validates**: SC-002

- [x] T056 [P2] [US4] **Disconnect-resume stress test** — verify SC-003: disconnect at random points during multi-event streaming, reconnect with last ack seq, assert 100% event replay with zero gaps/duplicates. Run multiple iterations. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T033
  - **Validates**: SC-003

- [x] T057 [P1] [US3] **Session-bypass comprehensive test** — verify SC-004: every REST conversation route AND every WebSocket message type rejects unauthenticated access. Enumerate all 15 REST routes and all 3 WS message types. Tests in `apps/web-gateway/src/__tests__/transport-integration.test.ts`.
  - **Depends**: T016, T024
  - **Validates**: SC-004

- [x] T058 [P1] **Final quality gate** — run `npm run quality` (ESLint, TypeScript strict, coverage thresholds) and `npm test` from monorepo root. Zero regressions across all packages. Assert all SC-011 criteria pass.
  - **Depends**: T054, T055, T056, T057
  - **Validates**: SC-011

- [x] T059 [P2] **Documentation: WebSocket transport protocol** — document the WebSocket protocol (endpoint, message types, subscribe/unsubscribe/ack flow, reconnect/resume protocol, error handling) in `docs/web-interface/`. Include sequence diagrams for: initial connection, subscription, streaming, reconnect/resume, session expiry.
  - **Depends**: T053
  - **Validates**: —

- [x] T060 [P2] **Documentation: Gateway transport architecture** — update architecture docs with the transport layer: daemon event bridge, connection registry, event buffer, event forwarder pipeline. Document configuration knobs (buffer capacity, daemon client timeout, backpressure threshold). Update `docs/web-interface/` or relevant architecture files.
  - **Depends**: T053
  - **Validates**: —

- [x] T061 [P2] **Documentation: Gateway configuration reference** — document all configurable parameters added by this slice: event buffer capacity (default 1000), daemon client timeout (default 5s), WebSocket backpressure threshold, session-termination grace period. Add to gateway config documentation.
  - **Depends**: T053
  - **Validates**: —

---

## Summary

| Metric                      | Count |
| --------------------------- | ----- |
| **Total tasks**             | 62    |
| **P1 tasks**                | 33    |
| **P2 tasks**                | 29    |
| **Phase 0 (Foundation)**    | 4     |
| **Phase 1 (Daemon Bridge)** | 4     |
| **Phase 2 (REST Routes)**   | 9     |
| **Phase 3 (WebSocket)**     | 8     |
| **Phase 4 (Streaming)**     | 7     |
| **Phase 5 (Reconnect)**     | 6     |
| **Phase 6 (Control Ops)**   | 5     |
| **Phase 7 (Edge Cases)**    | 11    |
| **Phase 8 (Integration)**   | 8     |

### Per-Story Breakdown

| Story | Tasks                                   | Count |
| ----- | --------------------------------------- | ----- |
| US1   | T003, T009–T016, T030, T054             | 12    |
| US2   | T005–T008, T018, T025–T031, T049, T055  | 16    |
| US3   | T017, T019–T024, T057                   | 9     |
| US4   | T032–T037, T052, T056                   | 8     |
| US5   | T012, T013, T015b, T038–T042            | 8     |
| US6   | T001, T002, T043–T048, T050, T051, T053 | 11    |

_(Some tasks serve multiple stories — counted under each.)_

### Phasing & Deployment Notes

**Phases 0–3 (T001–T024)** are now complete on `main` and provide the deployed
transport foundation:

1. ✅ **US1** — REST mediation for P1 conversation operations (lifecycle, turns,
   artifacts/activities; approval & work-control routes deferred to Phase 6)
2. ✅ **US3** — WebSocket session binding with full security enforcement
3. ✅ **US2 foundation** — authenticated WebSocket transport, connection
   registry, and session/daemon lifecycle notifications are in place

**Phase 4 (T025–T031)** is now complete on `feat/web-gateway-transport-phase4`.
It landed the missing P1 streaming path by wiring daemon stream events through
the gateway to subscribed browser connections, including buffering,
replay-barrier handling, backpressure protection, bounded replay retention,
bounded inbound WebSocket backlog, and the first end-to-end streaming
integration tests.

This completed Phase 4 batch is the transport surface the
`web-chat-workspace` slice needs before browser UI work can rely on live daemon
output.

**Phases 5–8 (T032–T061) are required for spec compliance** — they are not optional
follow-ons. The spec mandates reconnect/resume (FR-022–025, SC-003), structured
error boundaries (FR-026–028, SC-007–010), and control mediation round-trips
(FR-003–004) as part of the transport surface. The next slice (`web-chat-workspace`)
will consume reconnect, structured errors, and approval/cancel flows; deferring
them risks rework or a broken integration boundary. Phases 5–8 should land before
the transport slice is considered complete, even if implementation proceeds
incrementally after Phases 0–4 are deployed.

### Critical Path

```
T001 → T002 → T003 ─────────────────────────────────────┐
                                                          ├→ T015 → T023 → T030
T009 → T010/T011/T012/T013/T014 ────────────────────────┘        ↑
                                                                   │
T005 → T006 → T007 → T008                                        │
                                                                   │
T017 → T021 → T022 → T023 ───────────────────────────────────────┘
       T019 → T020 ──┘    ↑
                           │
T018 ──────────────────────┘
T025 → T026 → T027 ──────────────────→ T032 → T033 → T034/T036
```

### Ready Parallel Batch After Phase 4

- **Coordinator branch** — keep the active feature branch/PR as the integration
  surface for any new transport batch. If Phase 4 lands on `main` first, cut a
  fresh Phase 5 coordinator branch from `main`; otherwise target the current
  coordinator branch instead of opening track work directly against `main`.
- **Track A — reconnect/replay critical path** (`T032`–`T037`) — owns
  `ws-message-handler.ts`, replay helpers, and the reconnect sections of
  `transport-integration.test.ts`. Keep this track serial because `T032`
  establishes the daemon-fallback replay contract that `T033`–`T037` build on.
- **Track B — control round-trips** (`T038`–`T040`) — owns the approval/cancel/
  retry additions in `transport-integration.test.ts`. Keep these together in one
  worktree because they share the same integration harness and daemon-control
  fixtures.
- **Track C — artifact forwarding** (`T041`) — owns
  `event-forwarder.test.ts` and any minimal forwarding changes needed for
  `artifact-notice` coverage. This is safe to run separately once Track A is not
  changing the event envelope.
- **Track D — error and edge-case coverage**, grouped by shared test-file
  ownership so parallel work does not collide:
  - `T043`, `T046`, `T047` in `conversation-routes.test.ts`
  - `T045` in `request-validator.test.ts`
  - `T044`, `T050` in `ws-connection.test.ts`
  - `T048`, `T051` in `ws-message-handler.test.ts`
  - `T049`, `T052` in `transport-integration.test.ts`
- **Blocked final batch** — `T054`–`T061` stay blocked until reconnect/resume
  (`T037`) and edge/error coverage (`T053`) are complete.

## Next Steps

1. **Phase 7 is complete on `feat/web-gateway-transport-phase7`** — `T043`
   through `T053` now verify REST and WebSocket error boundaries, malformed
   message handling, idle/multi-tab edge cases, and restart behavior on top of
   the completed transport foundation from Phases 4–6.
2. **Start Phase 8 from the integrated transport harness** — the next ready
   tasks are the end-to-end and success-criteria sweeps already grouped above:
   `T054/T055/T056/T057` in `transport-integration.test.ts`, followed by the
   final quality gate `T058` and the transport documentation tasks `T059–T061`.
3. **Keep using real composed gateway/runtime paths in tests** — Phase 7
   confirmed that the most valuable coverage comes from driving actual auth,
   rate-limit, session, and WS wiring where feasible and reserving fakes for
   true external boundaries only.
4. **Treat transport state as ephemeral across process boundaries** — restart
   and reconnect tests now codify that connection registries, event buffers, and
   stale session state must not survive gateway restarts; Phase 8 should extend
   this verified behavior rather than reintroducing implicit persistence.
