# Tasks: Web Chat Workspace

**Generated**: 2026-03-20
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Feature directory**: `.sdd/web-chat-workspace-10bh3ksf/`

> **Scope guard.** These tasks implement the browser workspace slice only:
> `apps/web/` application bootstrap, transcript + composer UX, inline
> streaming, approvals/follow-up prompts, reconnect-aware synchronization,
> cancel/retry/branch/follow-up controls, artifact views, browser-safe
> rendering, and browser-side tests/docs. The following are **deferred** and
> must NOT be introduced here: operational panels, controlled mutations,
> new daemon-owned conversation semantics, alternate transports, direct imports
> from `lib/`, or early extraction to `packages/web-ui/` unless implementation
> pressure proves it is necessary.

## User Stories Reference

| ID  | Title                                                          | Priority |
| --- | -------------------------------------------------------------- | -------- |
| US1 | Operator reads and continues a conversation in the workspace   | P1       |
| US2 | Operator watches live work unfold in the transcript            | P1       |
| US3 | Operator handles approvals and follow-up prompts inline        | P1       |
| US4 | Operator recovers workspace context after refresh or reconnect | P2       |
| US5 | Operator controls and branches work from the transcript        | P2       |
| US6 | Operator inspects artifacts without leaving the workspace      | P2       |
| US7 | Operator keeps orientation in large or multi-session flows     | P3       |

## Dependency Legend

- **[P]**: Can run in parallel with other `[P]` tasks that do not touch the same files
- **[US#]**: User story ownership for the task
- All tasks follow **TDD**: failing test first where behavior changes, then implementation, then green validation

---

## Phase 0 — Browser App Bootstrap & Shared Workspace Foundations

_Create the real browser app shell in `apps/web/` and establish the shared browser-side primitives every story will use._

- [ ] T001 [P] Add browser runtime and testing dependencies plus workspace scripts in `apps/web/package.json`.
- [ ] T002 [P] Create the browser/Vite scaffold in `apps/web/index.html`, `apps/web/vite.config.ts`, and `apps/web/src/main.tsx`.
- [ ] T003 [P] Create the top-level app shell and route/provider scaffolding in `apps/web/src/app/router.tsx`, `apps/web/src/app/providers.tsx`, and `apps/web/src/app/app-shell.tsx`.
- [ ] T004 [P] Create browser-side gateway error and session status vocabularies in `apps/web/src/shared/gateway-errors.ts` and `apps/web/src/shared/session-state.ts`.
- [ ] T005 [US1, US2, US3, US4, US5, US6, US7] **TDD:** create the initial workspace state container and test harness in `apps/web/src/features/chat-workspace/model/workspace-store.ts` and `apps/web/src/features/chat-workspace/__tests__/workspace-store.test.ts`.
- [ ] T006 [US1, US2, US3, US4, US5, US6, US7] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after the `apps/web/` bootstrap lands.

**Checkpoint**: `apps/web/` is a real browser workspace scaffold with typed entrypoints, providers, and shared state primitives.

---

## Phase 1 — User Story 1: Conversation Transcript + Composer (Priority: P1) 🎯 MVP

**Goal**: The operator can open the workspace, select a conversation, read transcript history, and submit a new instruction from the active conversation context.

**Independent Test**: Open an existing conversation, verify ordered transcript rendering, submit a new instruction, and confirm the new turn appears in the correct conversation with no context mix-ups.

- [x] T007 [P] [US1] **TDD:** implement gateway conversation list/detail/history/create/submit client methods in `apps/web/src/features/chat-workspace/api/gateway-client.ts` and `apps/web/src/features/chat-workspace/__tests__/gateway-client.test.ts`.
- [x] T008 [P] [US1] **TDD:** implement per-conversation draft ownership and derived selectors in `apps/web/src/features/chat-workspace/model/composer-drafts.ts` and `apps/web/src/features/chat-workspace/model/selectors.ts`.
- [x] T009 [P] [US1] Build the main workspace route and layout shell in `apps/web/src/routes/index.tsx`, `apps/web/src/routes/workspace.tsx`, and `apps/web/src/features/chat-workspace/components/workspace-layout.tsx`.
- [x] T010 [US1] Implement conversation browsing and selection in `apps/web/src/features/chat-workspace/components/conversation-list.tsx` and `apps/web/src/features/chat-workspace/model/workspace-store.ts`.
- [ ] T011 [US1] Implement historical transcript rendering in `apps/web/src/features/chat-workspace/components/transcript-pane.tsx` and `apps/web/src/features/chat-workspace/components/transcript-turn.tsx`.
- [ ] T012 [US1] Implement composer submit/create/continue flow in `apps/web/src/features/chat-workspace/components/composer-panel.tsx` and `apps/web/src/features/chat-workspace/model/workspace-store.ts`.
- [ ] T013 [US1] Add route and transcript coverage in `apps/web/src/features/chat-workspace/__tests__/workspace-route.test.ts` and `apps/web/src/features/chat-workspace/__tests__/transcript-pane.test.ts`.
- [ ] T014 [US1] Run the phase quality gate from the repo root with `npm run quality` and `npm test` once the MVP transcript + composer flow is green.

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 2 — User Story 2: Inline Live Streaming (Priority: P1)

**Goal**: The workspace renders authoritative stream updates inline within the active turn rather than behaving like a static request/response page.

**Independent Test**: Submit an instruction that emits multiple streaming updates and verify the transcript updates incrementally, in order, before the turn completes.

- [ ] T015 [P] [US2] **TDD:** implement the WebSocket stream adapter for connect/subscribe/ack lifecycle in `apps/web/src/features/chat-workspace/api/stream-client.ts` and `apps/web/src/features/chat-workspace/__tests__/stream-client.test.ts`.
- [ ] T016 [P] [US2] **TDD:** implement authoritative stream reconciliation and duplicate-safe merge logic in `apps/web/src/features/chat-workspace/model/reconciler.ts` and `apps/web/src/features/chat-workspace/__tests__/reconciler.test.ts`.
- [ ] T017 [P] [US2] Implement safe stream content blocks in `apps/web/src/features/chat-workspace/render/safe-text.tsx` and `apps/web/src/features/chat-workspace/components/stream-event-block.tsx`.
- [ ] T018 [US2] Wire active conversation subscriptions and live turn updates through `apps/web/src/features/chat-workspace/model/workspace-store.ts`, `apps/web/src/routes/workspace.tsx`, and `apps/web/src/features/chat-workspace/components/transcript-turn.tsx`.
- [ ] T019 [US2] Add live-stream browser workflow coverage in `apps/web/src/features/chat-workspace/__tests__/workspace-e2e.test.ts`.
- [ ] T020 [US2] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after inline streaming is green.

**Checkpoint**: User Stories 1 and 2 work together as a basic REPL-grade chat flow.

---

## Phase 3 — User Story 3: Inline Approvals & Follow-Up Prompts (Priority: P1)

**Goal**: Pending approvals and follow-up questions appear inside the transcript, can be answered safely in place, and resolve visibly in the owning turn.

**Independent Test**: Trigger a prompt, answer it from within the workspace, and verify the prompt resolves and the resumed work remains visible in the same conversation.

- [ ] T021 [P] [US3] **TDD:** extend the gateway client for prompt retrieval and response submission in `apps/web/src/features/chat-workspace/api/gateway-client.ts` and `apps/web/src/features/chat-workspace/__tests__/gateway-client.test.ts`.
- [ ] T022 [P] [US3] **TDD:** implement prompt lifecycle state handling in `apps/web/src/features/chat-workspace/model/workspace-store.ts` and `apps/web/src/features/chat-workspace/model/reconciler.ts`.
- [ ] T023 [US3] Implement inline prompt presentation in `apps/web/src/features/chat-workspace/components/prompt-card.tsx` and `apps/web/src/features/chat-workspace/components/transcript-turn.tsx`.
- [ ] T024 [US3] Wire prompt actions and resolved-state visibility in `apps/web/src/features/chat-workspace/components/control-bar.tsx` and `apps/web/src/features/chat-workspace/components/prompt-card.tsx`.
- [ ] T025 [US3] Add prompt lifecycle coverage in `apps/web/src/features/chat-workspace/__tests__/prompt-card.test.ts` and `apps/web/src/features/chat-workspace/__tests__/workspace-e2e.test.ts`.
- [ ] T026 [US3] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after inline prompt handling is green.

**Checkpoint**: User Stories 1–3 provide the minimum supervised chat workspace.

---

## Phase 4 — User Story 4: Refresh/Reconnect Recovery UX (Priority: P2)

**Goal**: The browser workspace visibly reconnects and resynchronizes to authoritative state without duplicate or missing transcript entries.

**Independent Test**: Disconnect or refresh during an active turn, recover, and verify the transcript converges to authoritative state with clear reconnect/sync visibility.

- [ ] T027 [P] [US4] **TDD:** model operator-visible connection and synchronization states in `apps/web/src/shared/session-state.ts` and `apps/web/src/features/chat-workspace/model/workspace-store.ts`.
- [ ] T028 [P] [US4] **TDD:** extend reconnect, resubscribe, and replay-aware recovery behavior in `apps/web/src/features/chat-workspace/api/stream-client.ts` and `apps/web/src/features/chat-workspace/__tests__/stream-client.test.ts`.
- [ ] T029 [US4] Implement reconnect and sync visibility in `apps/web/src/features/chat-workspace/components/connection-banner.tsx` and `apps/web/src/app/app-shell.tsx`.
- [ ] T030 [US4] Tighten authoritative refresh merge and duplicate suppression in `apps/web/src/features/chat-workspace/model/reconciler.ts` and `apps/web/src/features/chat-workspace/model/selectors.ts`.
- [ ] T031 [US4] Add refresh/reconnect workflow coverage in `apps/web/src/features/chat-workspace/__tests__/workspace-e2e.test.ts`.
- [ ] T032 [US4] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after reconnect recovery is green.

**Checkpoint**: The workspace remains trustworthy across refresh and transient disconnects.

---

## Phase 5 — User Story 5: Cancel / Retry / Branch / Follow-Up Controls (Priority: P2)

**Goal**: The operator can control work directly from transcript context with visible lineage and durable state changes.

**Independent Test**: Cancel a running turn, retry an eligible turn, branch from a prior turn, and submit a follow-up instruction while preserving visible lineage and authoritative convergence.

- [ ] T033 [P] [US5] **TDD:** extend control-action gateway methods for cancel, retry, branch, and follow-up in `apps/web/src/features/chat-workspace/api/gateway-client.ts` and `apps/web/src/features/chat-workspace/__tests__/gateway-client.test.ts`.
- [ ] T034 [P] [US5] **TDD:** implement lineage and stale-control modeling in `apps/web/src/features/chat-workspace/model/workspace-store.ts`, `apps/web/src/features/chat-workspace/model/selectors.ts`, and `apps/web/src/features/chat-workspace/components/lineage-badge.tsx`.
- [ ] T035 [US5] Implement transcript control surfaces in `apps/web/src/features/chat-workspace/components/control-bar.tsx` and `apps/web/src/features/chat-workspace/components/lineage-badge.tsx`.
- [ ] T036 [US5] Wire cancel/retry/branch/follow-up actions into transcript and composer flow in `apps/web/src/features/chat-workspace/components/transcript-turn.tsx`, `apps/web/src/features/chat-workspace/components/composer-panel.tsx`, and `apps/web/src/routes/workspace.tsx`.
- [ ] T037 [US5] Add control-flow browser workflow coverage in `apps/web/src/features/chat-workspace/__tests__/workspace-e2e.test.ts`.
- [ ] T038 [US5] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after transcript controls are green.

**Checkpoint**: User Stories 1–5 support a real interactive Hydra workflow in the browser.

---

## Phase 6 — User Story 6: Artifact Inspection (Priority: P2)

**Goal**: The operator can inspect turn-associated artifacts from inside the workspace without losing conversation context.

**Independent Test**: Open artifacts from a turn, refresh, reopen the conversation, and confirm the artifacts remain accessible from the same turn context.

- [ ] T039 [P] [US6] **TDD:** extend the gateway client for artifact listing and content retrieval in `apps/web/src/features/chat-workspace/api/gateway-client.ts` and `apps/web/src/features/chat-workspace/__tests__/gateway-client.test.ts`.
- [ ] T040 [P] [US6] **TDD:** implement safe artifact renderers in `apps/web/src/features/chat-workspace/render/artifact-renderers.tsx` and `apps/web/src/features/chat-workspace/__tests__/artifact-panel.test.ts`.
- [ ] T041 [US6] Implement artifact panel integration in `apps/web/src/features/chat-workspace/components/artifact-panel.tsx`, `apps/web/src/features/chat-workspace/components/transcript-turn.tsx`, and `apps/web/src/features/chat-workspace/components/workspace-layout.tsx`.
- [ ] T042 [US6] Add artifact persistence and refresh workflow coverage in `apps/web/src/features/chat-workspace/__tests__/workspace-e2e.test.ts`.
- [ ] T043 [US6] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after artifact inspection is green.

**Checkpoint**: Artifacts are first-class outputs inside the workspace rather than external detours.

---

## Phase 7 — User Story 7: Large History & Multi-Session Orientation (Priority: P3)

**Goal**: The workspace stays understandable and responsive for long conversations and converges safely when multiple browser sessions view the same conversation.

**Independent Test**: Use the same conversation in two sessions, trigger control actions in one session, and verify the other converges while stale controls are not silently accepted; also confirm recent-context usability for large histories.

- [ ] T044 [P] [US7] Improve recent-context usability for large histories in `apps/web/src/features/chat-workspace/model/selectors.ts` and `apps/web/src/features/chat-workspace/components/transcript-pane.tsx`.
- [ ] T045 [P] [US7] Implement multi-session convergence and stale-control invalidation in `apps/web/src/features/chat-workspace/model/workspace-store.ts`, `apps/web/src/features/chat-workspace/model/reconciler.ts`, and `apps/web/src/features/chat-workspace/components/connection-banner.tsx`.
- [ ] T046 [US7] Add large-history and multi-session convergence coverage in `apps/web/src/features/chat-workspace/__tests__/workspace-e2e.test.ts` and `apps/web/src/features/chat-workspace/__tests__/workspace-store.test.ts`.
- [ ] T047 [US7] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after large-history and multi-session handling is green.

**Checkpoint**: The workspace behaves like a durable operator surface rather than a fragile single-tab demo.

---

## Phase 8 — Docs, Hardening, and Final Validation

- [ ] T048 [P] Update browser workspace usage and package docs in `apps/web/README.md`.
- [ ] T049 [P] Update browser workspace architecture and protocol docs in `docs/web-interface/03-architecture.md` and `docs/web-interface/04-protocol.md`.
- [ ] T050 Run final root validation with `npm run quality` and `npm test`, then reconcile any last browser-workspace doc or test gaps.

---

## Dependencies & Execution Order

### Phase Order

- **Phase 0** → required before any user-story implementation
- **US1** → first MVP slice
- **US2** → depends on US1 transcript/composer foundation
- **US3** → depends on US2 transcript event rendering
- **US4** → depends on US2 stream handling and US1 route shell
- **US5** → depends on US1 conversation context and US2/US4 authoritative reconciliation
- **US6** → depends on US1 transcript shell and gateway client foundation
- **US7** → depends on US1–US5 state and reconciliation behavior
- **Phase 8** → after all intended stories land

### Task Dependency Graph

- `T001`–`T005` must land before `T007` onward
- `T007` + `T008` + `T009` can start in parallel after Phase 0
- `T015` depends on `T007`, `T009`, and `T011`
- `T021` depends on `T015`, `T016`, and the transcript shell from US1/US2
- `T028` and `T030` depend on `T015` + `T016`
- `T033` and `T034` depend on the established workspace store/reconciler from US1–US4
- `T039` depends on `T007`
- `T044`–`T050` should wait until the intended implementation scope is stable

### Parallel Execution Examples

- **Phase 0**: `T001`, `T002`, `T003`, and `T004` can run in parallel, then converge in `T005`
- **US1**: `T007`, `T008`, and `T009` can run in parallel before wiring in `T010`–`T012`
- **US2**: `T015`, `T016`, and `T017` can run in parallel, then converge in `T018`
- **US3**: `T021` and `T022` can run in parallel before `T023`/`T024`
- **US4**: `T027` and `T028` can run in parallel before `T029`/`T030`
- **US5**: `T033` and `T034` can run in parallel before `T035`/`T036`
- **US6**: `T039` and `T040` can run in parallel before `T041`
- **US7**: `T044` and `T045` can run in parallel before `T046`

## Suggested MVP Scope

If you want the thinnest initial deliverable, stop after **Phase 1 / US1**.

If you want the first genuinely REPL-grade browser milestone, target **US1 + US2 + US3** before pausing.
