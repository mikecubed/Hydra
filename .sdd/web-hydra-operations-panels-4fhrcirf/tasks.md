# Tasks: Web Hydra Operations Panels

**Generated**: 2026-03-25
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Feature directory**: `.sdd/web-hydra-operations-panels-4fhrcirf/`

> **Scope guard.** These tasks extend the delivered browser workspace with
> Hydra-native operations visibility and safe daemon-authorized controls only:
> queue visibility, checkpoint history, health/budget awareness,
> routing/mode/agent/council detail, gateway mediation, shared contracts,
> and regression-safe workspace composition. The following are **deferred** and
> must NOT be re-owned here: transcript rendering, approvals UX, reconnect
> semantics already owned by `web-chat-workspace`, new browser↔daemon direct
> coupling, gateway-owned orchestration policy, destructive non-authorized
> mutations, or a second standalone browser shell.

## User Stories Reference

| ID  | Title                                                          | Priority |
| --- | -------------------------------------------------------------- | -------- |
| US1 | Operator sees active Hydra work across the queue               | P1       |
| US2 | Operator understands checkpoints and execution progress        | P1       |
| US3 | Operator monitors health, budgets, and operational risk        | P1       |
| US4 | Operator understands routing, mode, agent, and council choices | P2       |
| US5 | Operator uses safe operational controls from the browser       | P2       |
| US6 | Operator visualizes multi-agent and council execution clearly  | P3       |

## Dependency Legend

- **[P]**: Can run in parallel with other `[P]` tasks that do not touch the same files
- **[US#]**: User story ownership for the task
- All tasks follow **TDD**: failing test first where behavior changes, then implementation, then green validation
- Shared contracts land before gateway/browser behavior; daemon authority is preserved throughout

---

## Phase 0 — Shared Operations Contracts & Cross-Surface Foundations

_Create the browser-safe operations vocabulary before daemon, gateway, or browser behavior expands._

- [x] T001 [P] **TDD:** add operations schema and conformance coverage in `packages/web-contracts/src/__tests__/operations-contracts.test.ts` and `test/web-contracts/operations-contracts.test.ts`.
- [x] T002 [P] Define shared operations entity schemas and inferred types in `packages/web-contracts/src/operations.ts`.
- [x] T003 [P] Define operations snapshot/detail read contracts in `packages/web-contracts/src/contracts/operations-read.ts`.
- [x] T004 [P] Define daemon-authorized control request/result contracts in `packages/web-contracts/src/contracts/operations-control.ts`.
- [x] T005 Update append-only shared exports and contract registry in `packages/web-contracts/src/index.ts` and `packages/web-contracts/CONTRACTS.md`.
- [x] T006 Create operations module scaffolding and top-of-file JSDoc summaries in `apps/web-gateway/src/operations/daemon-operations-client.ts`, `apps/web-gateway/src/operations/operations-routes.ts`, `apps/web-gateway/src/operations/request-validator.ts`, `apps/web-gateway/src/operations/response-translator.ts`, `apps/web/src/features/operations-panels/api/operations-client.ts`, and `apps/web/src/features/operations-panels/model/operations-types.ts`.

**Checkpoint**: Shared operations DTOs exist, are exported append-only, and give daemon/gateway/browser code a stable contract foundation.

---

## Phase 1 — User Story 1: Queue Visibility in the Workspace (Priority: P1) 🎯 MVP

**Goal**: The operator can open the workspace and immediately understand the authoritative queue, recent work, and conversation relationships without leaving the browser.

**Independent Test**: Seed mixed waiting, active, paused, blocked, failed, cancelled, and completed work items; open the workspace; verify queue ordering, status labels, and conversation/session relationship hints match the authoritative snapshot.

- [x] T007 [P] [US1] **TDD:** add daemon projection and route coverage for queue status normalization, ordering, and relationship hints in `test/web-operations-projection.test.ts` and `test/web-operations-routes.test.ts`.
- [x] T008 [US1] Implement daemon queue snapshot projection and read-route mounting in `lib/daemon/web-operations-projection.ts`, `lib/daemon/web-operations-routes.ts`, and `lib/daemon/read-routes.ts`.
- [x] T009 [P] [US1] **TDD:** add gateway snapshot-client and route coverage for authenticated operations reads in `apps/web-gateway/src/operations/__tests__/daemon-operations-client.test.ts` and `apps/web-gateway/src/operations/__tests__/operations-routes.test.ts`.
- [x] T010 [US1] Implement gateway snapshot mediation and route wiring in `apps/web-gateway/src/operations/daemon-operations-client.ts`, `apps/web-gateway/src/operations/request-validator.ts`, `apps/web-gateway/src/operations/operations-routes.ts`, and `apps/web-gateway/src/index.ts`.
- [x] T011 [P] [US1] **TDD:** add browser snapshot-client and queue-state coverage in `apps/web/src/features/operations-panels/__tests__/operations-client.test.ts` and `apps/web/src/features/operations-panels/__tests__/operations-reducer.test.ts`.
- [x] T012 [P] [US1] Implement browser snapshot client, operations state, reducer, and selectors in `apps/web/src/features/operations-panels/api/operations-client.ts`, `apps/web/src/features/operations-panels/model/operations-types.ts`, `apps/web/src/features/operations-panels/model/operations-reducer.ts`, and `apps/web/src/features/operations-panels/model/selectors.ts`.
- [x] T013 [US1] Implement queue panel shell, queue cards, empty states, and workspace composition in `apps/web/src/features/operations-panels/components/operations-panel-shell.tsx`, `apps/web/src/features/operations-panels/components/queue-panel.tsx`, `apps/web/src/features/operations-panels/components/queue-item-card.tsx`, `apps/web/src/features/operations-panels/components/empty-state-card.tsx`, `apps/web/src/routes/workspace.tsx`, and `apps/web/src/features/chat-workspace/components/workspace-layout.tsx`.
- [x] T014 [US1] Add queue visibility browser integration coverage in `apps/web/src/features/operations-panels/__tests__/queue-panel.browser.spec.tsx` and `apps/web/src/features/operations-panels/__tests__/workspace-operations.integration.test.tsx`.
- [ ] T015 [US1] Run the phase quality gate from the repo root with `npm run quality` and `npm test` once queue visibility is green.

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 2 — User Story 2: Checkpoints & Execution Progress (Priority: P1)

**Goal**: The operator can inspect a work item and understand ordered checkpoints, waiting states, recovery, and resumed execution without inferring progress from transcript text.

**Independent Test**: Start a work item that pauses, recovers, and resumes; select it from the queue; verify the browser shows current checkpoint state plus ordered checkpoint history with waiting/recovery context preserved.

- [ ] T016 [P] [US2] **TDD:** extend daemon detail projection coverage for checkpoint ordering, waiting states, recovery states, and partial-data markers in `test/web-operations-projection.test.ts` and `test/web-operations-routes.test.ts`.
- [ ] T017 [US2] Implement daemon work-item detail projection for checkpoints and availability semantics in `lib/daemon/web-operations-projection.ts` and `lib/daemon/web-operations-routes.ts`.
- [ ] T018 [P] [US2] **TDD:** extend gateway detail-route coverage for selected work-item reads in `apps/web-gateway/src/operations/__tests__/daemon-operations-client.test.ts` and `apps/web-gateway/src/operations/__tests__/operations-routes.test.ts`.
- [ ] T019 [US2] Implement gateway work-item detail mediation, validation, and route wiring for `GET /operations/work-items/:workItemId` in `apps/web-gateway/src/operations/daemon-operations-client.ts`, `apps/web-gateway/src/operations/request-validator.ts`, and `apps/web-gateway/src/operations/operations-routes.ts`.
- [ ] T020 [P] [US2] **TDD:** add browser selected-item state, detail-client, and detail-sync coverage in `apps/web/src/features/operations-panels/__tests__/operations-client.test.ts`, `apps/web/src/features/operations-panels/__tests__/operations-reducer.test.ts`, and `apps/web/src/features/operations-panels/__tests__/sync-controller.test.ts`.
- [ ] T021 [P] [US2] Implement browser detail client, fetch orchestration, and selected-work-item synchronization in `apps/web/src/features/operations-panels/api/operations-client.ts`, `apps/web/src/features/operations-panels/model/sync-controller.ts`, `apps/web/src/features/operations-panels/model/operations-reducer.ts`, and `apps/web/src/features/operations-panels/model/selectors.ts`.
- [ ] T022 [US2] Implement checkpoint detail rendering in `apps/web/src/features/operations-panels/components/checkpoint-panel.tsx` and `apps/web/src/features/operations-panels/components/operations-panel-shell.tsx`.
- [ ] T023 [US2] Add checkpoint workflow coverage in `apps/web/src/features/operations-panels/__tests__/checkpoint-panel.browser.spec.tsx` and `apps/web/src/features/operations-panels/__tests__/workspace-operations.integration.test.tsx`.
- [ ] T024 [US2] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after checkpoint detail is green.

**Checkpoint**: User Stories 1 and 2 work together as an authoritative queue + progress surface.

---

## Phase 3 — User Story 3: Health, Budgets & Risk Signals (Priority: P1)

**Goal**: The operator can distinguish global daemon health from work-item-specific budget or risk signals in the same workspace session.

**Independent Test**: Simulate healthy, degraded, unavailable, warning, and exceeded states; verify the browser separates global daemon conditions from local work-item warnings and explicit unavailable/partial states.

- [ ] T025 [P] [US3] **TDD:** extend daemon projection coverage for health/budget scope separation and unavailable states in `test/web-operations-projection.test.ts` and `test/web-operations-routes.test.ts`.
- [ ] T026 [US3] Implement daemon health and budget projections in `lib/daemon/web-operations-projection.ts` and `lib/daemon/web-operations-routes.ts`, treating global budget posture as the required baseline and marking non-global scopes unavailable until daemon attribution exists.
- [ ] T027 [P] [US3] **TDD:** add browser health/budget and risk-badge coverage in `apps/web/src/features/operations-panels/__tests__/health-budget.browser.spec.tsx` and `apps/web/src/features/operations-panels/__tests__/operations-reducer.test.ts`.
- [ ] T028 [US3] Implement health and budget panels plus queue risk signals in `apps/web/src/features/operations-panels/components/health-budget-panel.tsx`, `apps/web/src/features/operations-panels/components/queue-item-card.tsx`, and `apps/web/src/features/operations-panels/components/operations-panel-shell.tsx`.
- [ ] T029 [US3] Add global-vs-item risk regression coverage in `apps/web/src/features/operations-panels/__tests__/workspace-operations.integration.test.tsx` and `apps/web-gateway/src/operations/__tests__/operations-routes.test.ts`.
- [ ] T030 [US3] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after health and budget surfaces are green.

**Checkpoint**: User Stories 1–3 provide the minimum read-only operator surface for queue, progress, and risk.

---

## Phase 4 — User Story 4: Routing, Mode, Agent & Council Visibility (Priority: P2)

**Goal**: The operator can inspect how Hydra routed the work, which mode is active, who is participating, and how those decisions changed over time.

**Independent Test**: Run work that changes route, mode, or assignments during execution; verify the selected work item preserves current values and visible history for prior routing and participant decisions.

- [ ] T031 [P] [US4] **TDD:** extend daemon detail projection coverage for routing history, assignment history, and council summaries in `test/web-operations-projection.test.ts` and `test/web-operations-routes.test.ts`.
- [ ] T032 [US4] Implement daemon-side routing, assignment, and council history capture in the authoritative runtime/state modules that observe those transitions, then expose that history to `lib/daemon/web-operations-projection.ts` without synthesizing it in the gateway or browser.
- [ ] T033 [US4] Implement daemon routing, assignment, and council detail projection in `lib/daemon/web-operations-projection.ts` and `lib/daemon/web-operations-routes.ts`.
- [ ] T034 [P] [US4] **TDD:** add browser routing and execution-detail coverage in `apps/web/src/features/operations-panels/__tests__/routing-panel.browser.spec.tsx` and `apps/web/src/features/operations-panels/__tests__/execution-panel.browser.spec.tsx`.
- [ ] T035 [P] [US4] Implement routing and execution detail panels in `apps/web/src/features/operations-panels/components/routing-panel.tsx`, `apps/web/src/features/operations-panels/components/execution-panel.tsx`, and `apps/web/src/features/operations-panels/components/operations-panel-shell.tsx`.
- [ ] T036 [US4] Add routing and participant-history convergence coverage in `apps/web/src/features/operations-panels/__tests__/workspace-operations.integration.test.tsx`.
- [ ] T037 [US4] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after routing and execution visibility is green.

**Checkpoint**: User Stories 1–4 expose Hydra’s read-only operational posture without violating browser/gateway boundaries.

---

## Phase 5 — User Story 5: Safe Operational Controls (Priority: P2)

**Goal**: The operator can request daemon-authorized routing, mode, agent, or council changes from the browser and see pending, accepted, rejected, stale, or superseded outcomes reconcile back to authoritative state.

**Independent Test**: Attempt allowed, disallowed, and stale control changes from the browser; verify pending UI, authoritative outcome messaging, and refetched state all match daemon decisions with no false-success presentation.

- [ ] T038 [P] [US5] **TDD:** add daemon control-route coverage for control discovery, operator authority, actionable/read-only states, and rejected/stale/superseded outcomes in `test/web-operations-routes.test.ts`.
- [ ] T039 [US5] Implement daemon-authored control discovery, authority, eligibility, and revision-token reads in `lib/daemon/web-operations-controls.ts`, `lib/daemon/web-operations-projection.ts`, and `lib/daemon/web-operations-routes.ts`.
- [ ] T040 [US5] Implement daemon-authorized control mutations and revision checks in `lib/daemon/web-operations-controls.ts`, `lib/daemon/web-operations-routes.ts`, and `lib/daemon/write-routes.ts`.
- [ ] T041 [P] [US5] **TDD:** extend gateway control mediation coverage for detail-read control hydration, validation, and outcome translation in `apps/web-gateway/src/operations/__tests__/daemon-operations-client.test.ts` and `apps/web-gateway/src/operations/__tests__/operations-routes.test.ts`.
- [ ] T042 [US5] Implement gateway control discovery hydration plus control mediation and structured stale/rejected translation in `apps/web-gateway/src/operations/daemon-operations-client.ts`, `apps/web-gateway/src/operations/operations-routes.ts`, and `apps/web-gateway/src/operations/response-translator.ts`.
- [ ] T043 [P] [US5] **TDD:** add browser control discovery, authority, pending, and result coverage in `apps/web/src/features/operations-panels/__tests__/control-strip.browser.spec.tsx`, `apps/web/src/features/operations-panels/__tests__/control-actions.test.ts`, and `apps/web/src/features/operations-panels/__tests__/operations-client.test.ts`.
- [ ] T044 [P] [US5] Implement control discovery hydration, pending control bookkeeping, and authoritative refetch handling in `apps/web/src/features/operations-panels/api/operations-client.ts`, `apps/web/src/features/operations-panels/model/control-actions.ts`, `apps/web/src/features/operations-panels/model/sync-controller.ts`, and `apps/web/src/features/operations-panels/model/operations-reducer.ts`.
- [ ] T045 [US5] Implement control-strip UI and route wiring in `apps/web/src/features/operations-panels/components/control-strip.tsx`, `apps/web/src/features/operations-panels/components/operations-panel-shell.tsx`, and `apps/web/src/routes/workspace.tsx`.
- [ ] T046 [US5] Add stale-control and multi-session control convergence coverage in `apps/web/src/features/operations-panels/__tests__/workspace-operations.integration.test.tsx` and `apps/web-gateway/src/operations/__tests__/operations-routes.test.ts`.
- [ ] T047 [US5] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after safe operational controls are green.

**Checkpoint**: User Story 5 adds daemon-authorized controls without making the browser or gateway look authoritative.

---

## Phase 6 — User Story 6: Multi-Agent Visualization, Recovery & Regression Hardening (Priority: P3)

**Goal**: The operations panels remain understandable for dense multi-agent execution and remain regression-safe across refresh, reconnect, and multi-tab workspace usage.

**Independent Test**: Observe a many-participant council flow across refresh or concurrent tabs; verify the execution view remains legible, operations state converges within one sync cycle, and existing chat-workspace behavior does not regress.

- [ ] T048 [P] [US6] **TDD:** add dense execution-visualization and partial-data recovery coverage in `apps/web/src/features/operations-panels/__tests__/execution-panel.browser.spec.tsx` and `apps/web/src/features/operations-panels/__tests__/workspace-operations.integration.test.tsx`.
- [ ] T049 [P] [US6] Implement dense multi-agent and council timeline rendering plus availability affordances in `apps/web/src/features/operations-panels/components/execution-panel.tsx`, `apps/web/src/features/operations-panels/components/empty-state-card.tsx`, and `apps/web/src/features/operations-panels/model/selectors.ts`.
- [ ] T050 [P] [US6] Add refresh, reconnect, and multi-tab regression coverage for operations polling alongside existing chat flows in `apps/web/src/features/operations-panels/__tests__/workspace-operations.integration.test.tsx`, `apps/web/src/features/chat-workspace/__tests__/workflow-refresh-recovery.browser.spec.tsx`, and `apps/web/src/features/chat-workspace/__tests__/workflow-control-actions.browser.spec.tsx`.
- [ ] T051 [US6] Harden workspace composition so operations synchronization preserves chat ownership and orientation in `apps/web/src/routes/workspace.tsx`, `apps/web/src/features/chat-workspace/components/workspace-layout.tsx`, and `apps/web/src/shared/session-state.ts`.
- [ ] T052 [US6] Run the phase quality gate from the repo root with `npm run quality` and `npm test` after multi-agent visualization and regression hardening is green.

**Checkpoint**: The operations panels behave like a trustworthy companion surface rather than a fragile sidecar.

---

## Phase 7 — Docs, Final Validation & Release Readiness

- [ ] T053 [P] Update browser workspace and architecture docs for operations panels in `apps/web/README.md` and `docs/web-interface/03-architecture.md`.
- [ ] T054 [P] Update protocol, phase-roadmap, and boundary documentation for operations snapshot/detail/control routes in `docs/web-interface/04-protocol.md`, `docs/web-interface/06-phases-and-sdd.md`, and `docs/web-interface/07-boundaries-and-governance.md`.
- [ ] T055 Run final validation with `npm run quality`, `npm test`, and `npm run test:browser -w @hydra/web`, then reconcile any last operations-panels doc or regression gaps.

---

## Dependencies & Execution Order

### Phase Order

- **Phase 0** → required before daemon, gateway, or browser operations behavior
- **US1** → first MVP slice and prerequisite for all later browser work
- **US2** → depends on US1 snapshot/selection foundations
- **US3** → depends on US1 snapshot plumbing and US2 detail hydration
- **US4** → depends on US2 detail routes and US3 risk/availability semantics
- **US5** → depends on US4 detail visibility plus Phase 0 control contracts
- **US6** → depends on US1–US5 browser synchronization and control-state behavior
- **Phase 7** → after the intended feature scope is stable

### Task Dependency Graph

- `T001` → `T005` must land before `T007` onward
- `T006` can start with `T002`–`T004`, but the operations modules should not grow behavior until `T005` is complete
- `T007` → `T010` establish daemon/gateway snapshot reads before browser queue work in `T011`–`T014`
- `T016`, `T018`, and `T020` all depend on `T008`–`T014`
- `T025` depends on the daemon detail surface from `T017`; `T027` depends on browser state from `T021`–`T023`
- `T031`–`T033` depend on the shared detail contracts and daemon detail projection from US2/US3, with `T032` establishing the authoritative history source before `T033`
- `T038` → `T046` depend on US4 detail surfaces plus Phase 0 control contracts, with `T039` and `T042` establishing control discovery/authority before mutation UI is considered complete
- `T048` → `T052` should wait until the intended read/control scope is stable so regression coverage targets the final panel composition
- `T053`–`T055` should land last

### Parallel Execution Examples

- **Phase 0**: `T001`, `T002`, `T003`, and `T004` can run in parallel, then converge in `T005`
- **US1**: `T007`, `T009`, and `T011` can run in parallel once Phase 0 is done, then converge in `T008`, `T010`, and `T012`–`T014`
- **US2**: `T016`, `T018`, and `T020` can run in parallel before `T017`, `T019`, and `T021`–`T023`
- **US3**: `T025` and `T027` can run in parallel before `T026`, `T028`, and `T029`
- **US4**: `T031` and `T034` can run in parallel while `T032` establishes history capture, then converge in `T033`, `T035`, and `T036`
- **US5**: `T038`, `T041`, and `T043` can run in parallel before `T039`, `T040`, `T042`, and `T044`–`T046`
- **US6**: `T048`, `T049`, and `T050` can run in parallel before `T051`

## Suggested MVP Scope

If you want the thinnest initial deliverable, stop after **Phase 1 / US1**.

If you want the first operator-meaningful read-only milestone, target **US1 + US2 + US3** before pausing.

If you want the first full Phase 3 operations milestone, complete **US1–US5** before final docs and validation.
