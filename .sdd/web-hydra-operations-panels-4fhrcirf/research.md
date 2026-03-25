# Research: Web Hydra Operations Panels

## Context

The repository already delivers a browser chat workspace in `apps/web/`, a validated gateway mediation layer in `apps/web-gateway/`, and shared conversation/session contracts in `packages/web-contracts/`. The remaining Phase 3 gap is a Hydra-native operations surface that exposes queue state, checkpoints, health, budgets, routing decisions, agent/council participation, and safe daemon-authorized controls without re-owning chat behavior.

## Findings From Existing Implementation

### Existing browser composition root

- `apps/web/src/routes/workspace.tsx` is the composition root for the delivered workspace.
- `apps/web/src/features/chat-workspace/components/workspace-layout.tsx` renders the current conversation list, transcript, artifact panel, and composer.
- `chat-workspace/model/` already follows an explicit reducer + selector + side-effect module pattern, which should be mirrored rather than bypassed.

### Existing gateway boundary

- `apps/web-gateway/src/index.ts` assembles auth/session/security, conversation REST routes, and WebSocket transport.
- `apps/web-gateway/src/conversation/` is a thin mediation layer with request validation and a single daemon client.
- Current gateway responsibilities already include daemon availability notifications and structured error translation, but not operational projection logic.

### Existing contracts and daemon surfaces

- `packages/web-contracts/` currently defines conversation, turn, stream, approval, artifact, activity, session, and auth contracts.
- Queue-related conversation contracts already exist (`ManageQueueRequest`, `ManageQueueResponse`), but there is no browser-safe contract family for workspace-wide operations views.
- The daemon already exposes useful ingredients in `lib/daemon/read-routes.ts` and `lib/daemon/conversation-routes.ts`:
  - `/task/:id/checkpoints`
  - `/summary`
  - `/self`
  - `/stats`
  - conversation queue access under `/conversations/:id/queue`
- Those existing daemon routes expose raw or core-oriented payloads, not the stable browser-facing DTOs needed for this slice.

## Decisions

### Decision 1: Keep operations panels as a sibling browser feature

- **Chosen**: Add `apps/web/src/features/operations-panels/` and compose it from `routes/workspace.tsx`.
- **Why**: The chat workspace already owns transcript/composer behavior. A sibling feature respects that ownership and keeps operational state isolated and testable.
- **Rejected alternatives**:
  - absorb operations state into `chat-workspace/model/`
  - create a separate route/app shell that fragments the operator workflow

### Decision 2: Use REST snapshot/detail synchronization for this slice

- **Chosen**: Synchronize operations data with REST endpoints and scheduled/targeted refetches, not a new WebSocket family.
- **Why**: Queue/health/budget/control state is broader than per-conversation stream transport. The repo already has TanStack Query available for non-stream state, and a snapshot model reduces protocol churn while preserving authoritative convergence.
- **Rejected alternatives**:
  - creating an operations-specific WebSocket protocol immediately
  - deriving queue and budget state from transcript events or activity entries alone

### Decision 3: Create dedicated operations contracts before implementation

- **Chosen**: Add new operations entities and contract families in `packages/web-contracts/`.
- **Why**: The architecture and quality docs require shared contracts before shared behavior. Raw daemon payloads (`/state`, `/self`, `/stats`) should not leak directly into browser code because they expose unstable internal structure and do not encode explicit empty/partial/unavailable semantics.
- **Rejected alternatives**:
  - browser-local types only in `apps/web`
  - direct gateway passthrough of daemon core payloads

### Decision 4: Put operational normalization and control eligibility in the daemon

- **Chosen**: Introduce daemon-owned operations projection routes and daemon-owned control routes for safe operational changes.
- **Why**: The daemon is the only place with enough authoritative context to normalize work status, distinguish local vs global degradation, and decide whether a routing/mode/agent/council change is currently allowed or stale.
- **Rejected alternatives**:
  - gateway-computed control eligibility
  - browser heuristics that infer actionability from incomplete state

### Decision 5: Deliver visibility before control mutation

- **Chosen**: Stage the work as read-only surfaces first, controls second.
- **Why**: User Stories 1–4 and Success Criteria 1–3 provide most of the operator value and establish the stable projection/control vocabulary needed for mutation work.
- **Rejected alternatives**:
  - exposing controls in the first UI pass
  - shipping mutation routes before the browser can render authoritative eligibility/result states

### Decision 6: Treat empty/unavailable/partial-data states as first-class contract fields

- **Chosen**: Encode data completeness and availability explicitly in operations DTOs.
- **Why**: The spec requires operators to distinguish “no active work” from “load failed” or “only partial authoritative data is available.” This must be owned by the contract layer, not improvised per component.
- **Rejected alternatives**:
  - generic null/undefined handling in the UI
  - conflating empty snapshots with transport failure

## Open Implementation Notes Resolved

### Status normalization

The browser spec requires statuses like `waiting`, `active`, `paused`, `blocked`, `completed`, `failed`, and `cancelled`, while current daemon task types expose values such as `todo`, `in_progress`, `blocked`, `done`, and `cancelled`. The plan resolves this by making the daemon projection layer responsible for mapping raw core status plus checkpoint/session/runtime metadata into the browser-facing vocabulary.

### Health and budget scope separation

The current daemon has useful health/runtime inputs in `/health`, `/self`, and `/stats`, but those routes expose mixed operational detail. The plan resolves this by projecting a browser-safe `DaemonHealthView` and `BudgetStatusView` with explicit `scope` so the browser can distinguish global degradation from work-item warnings.

### Routing/mode/agent/council visibility

Current daemon/core structures contain routing mode, models, and council-related data, but not in a stable browser DTO family. The plan resolves this by defining dedicated operations detail contracts and allowing daemon-side projection helpers to pull from existing runtime/config/task sources without exposing those raw structures directly.

## Resulting Planning Direction

The implementation plan should:

1. extend `apps/web/` with an `operations-panels` sibling feature;
2. extend `packages/web-contracts/` with operations read/control contracts;
3. extend `apps/web-gateway/` with a thin operations mediation module;
4. extend `lib/daemon/` with browser-safe operations projection/control routes;
5. stage read-only visibility ahead of daemon-authorized controls; and
6. preserve existing chat workspace ownership and gateway/daemon boundaries throughout.
