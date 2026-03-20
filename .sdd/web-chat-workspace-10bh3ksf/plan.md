# Implementation Plan: Web Chat Workspace

**Date**: 2026-03-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `.sdd/web-chat-workspace-10bh3ksf/spec.md`

## Summary

This plan delivers the first real browser-side Hydra workspace in `apps/web/`: a conversation-centered interface with transcript and composer, inline live streaming, approval and follow-up handling, cancel/retry/branch controls, reconnect-aware synchronization UX, and artifact inspection. The gateway and daemon remain authoritative for conversation state and transport; the browser layer focuses on rendering, operator interaction, browser-safe presentation, and deterministic reconciliation of authoritative state after submit, stream, prompt, reconnect, and control actions.

> **Scope note.** This slice consumes the already-delivered session/auth, protocol, and gateway transport layers. It does not redesign transport, add new daemon conversation semantics, or introduce operational control panels. The goal is to turn the existing browser-facing contracts into a usable REPL-grade chat workspace with explicit state modeling and strong browser-safety guarantees.

## Prerequisites

This slice depends on and does NOT re-own the following existing deliverables:

- **web-repl-foundation** — workspace layout, package boundaries, import-direction rules, and web initiative quality baseline.
- **web-session-auth** — authenticated browser session lifecycle, origin and CSRF posture, session warning/termination semantics, and gateway-backed auth routes.
- **web-conversation-protocol** — conversation, turn, stream event, approval, artifact, and lineage contracts in `packages/web-contracts/`.
- **web-gateway-conversation-transport** — browser-facing gateway REST routes, WebSocket stream transport, reconnect/resume semantics, structured gateway error responses, and session-bound streaming behavior.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM-only, targeting ES2024  
**Primary Dependencies**: React + TypeScript + Vite for the browser workspace; TanStack Router for route/layout modeling; TanStack Query for non-stream gateway state; `@hydra/web-contracts` for shared browser-safe contracts  
**Storage**: No durable browser-owned source of truth; authoritative state remains gateway/daemon. Browser state is in-memory UI state plus optional per-tab ephemeral draft state only if needed by implementation.  
**Testing**: Repo-standard `node:test` for state, adapters, and pure view-model logic; browser component tests for UI rendering; end-to-end browser tests for transcript/stream/control flows; root `npm run quality` and `npm test` remain required  
**Target Platform**: Browser frontend in `apps/web/`, running against the local/LAN Hydra web gateway  
**Project Type**: Browser application workspace (`apps/web/`) consuming existing gateway transport and shared contracts  
**Performance Goals**: Visible streaming updates within the spec’s 1 second target under normal local conditions; recent conversation context stays interactive without waiting for full history render; reconnect resynchronization preserves operator orientation with no duplicate visible transcript entries  
**Constraints**: `apps/web` may import only allowed shared workspace packages (currently `packages/web-contracts`; `packages/web-ui` remains optional/future); no direct imports from `lib/` or `apps/web-gateway/`; no unsafe rendering of transcript or artifact content; no hidden state machines buried inside components when explicit modeling is warranted  
**Scale/Scope**: Single authenticated operator, potentially multiple browser tabs on the same conversation, conversations with long histories and mixed content types, local-first deployment posture

## Project Structure

### Documentation (this feature)

```text
.sdd/web-chat-workspace-10bh3ksf/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository layout)

This slice turns `apps/web/` from a placeholder into the first real browser application. New code remains browser-owned and does not cross into gateway or core internals.

```text
apps/web/
├── package.json                      # add browser app dependencies + scripts
├── tsconfig.json
├── vite.config.ts                    # new Vite configuration
├── index.html                        # browser entry document
└── src/
    ├── main.tsx                      # React/Vite browser entrypoint
    ├── app/
    │   ├── router.tsx                # top-level route tree
    │   ├── providers.tsx             # query/router/session-aware providers
    │   └── app-shell.tsx             # root authenticated shell
    ├── routes/
    │   ├── index.tsx                 # redirect/landing route
    │   └── workspace.tsx             # main chat workspace route
    ├── features/chat-workspace/
    │   ├── api/
    │   │   ├── gateway-client.ts     # REST adapter to gateway routes
    │   │   └── stream-client.ts      # WebSocket subscription + reconnect adapter
    │   ├── model/
    │   │   ├── workspace-store.ts    # explicit workspace state container/reducer
    │   │   ├── reconciler.ts         # authoritative-state merge logic
    │   │   ├── composer-drafts.ts    # per-conversation draft ownership
    │   │   └── selectors.ts          # derived state for UI
    │   ├── components/
    │   │   ├── workspace-layout.tsx
    │   │   ├── conversation-list.tsx
    │   │   ├── transcript-pane.tsx
    │   │   ├── transcript-turn.tsx
    │   │   ├── stream-event-block.tsx
    │   │   ├── composer-panel.tsx
    │   │   ├── prompt-card.tsx
    │   │   ├── control-bar.tsx
    │   │   ├── artifact-panel.tsx
    │   │   ├── connection-banner.tsx
    │   │   └── lineage-badge.tsx
    │   ├── render/
    │   │   ├── safe-text.tsx         # safe transcript/artifact rendering helpers
    │   │   └── artifact-renderers.tsx
    │   └── __tests__/
    │       ├── workspace-store.test.ts
    │       ├── reconciler.test.ts
    │       ├── gateway-client.test.ts
    │       ├── stream-client.test.ts
    │       ├── workspace-route.test.ts
    │       ├── transcript-pane.test.ts
    │       ├── prompt-card.test.ts
    │       ├── artifact-panel.test.ts
    │       └── workspace-e2e.test.ts
    └── shared/
        ├── gateway-errors.ts         # browser-side mapping of GatewayErrorResponse
        └── session-state.ts          # browser session/connection status vocabulary
```

**Structure Decisions**:

- The first implementation stays inside `apps/web/` rather than creating `packages/web-ui/` immediately. This keeps the initial browser slice cohesive while the component vocabulary stabilizes.
- `features/chat-workspace/model/` holds explicit state and reconciliation logic separate from components to satisfy the “no hidden state machines” quality rule.
- `api/` adapters are the only runtime boundary to gateway transport. Components consume normalized browser-side state, not raw HTTP/WebSocket payload handling.
- Shared contracts remain in `packages/web-contracts/`; this slice does not define new cross-surface public contract files unless implementation pressure proves they are missing.

## Research Findings

See [research.md](./research.md) for full analysis. Key decisions summarized below.

### Decision 1: Keep the first workspace slice entirely inside `apps/web/`

- **Chosen**: Implement the initial browser workspace in `apps/web/` only and defer `packages/web-ui/` until component reuse becomes concrete.
- **Rationale**: `apps/web/` is still a placeholder; this slice’s main job is to establish the real browser surface. Splitting too early into a second UI package would add boundary churn before the design language is proven.
- **Alternatives rejected**: creating `packages/web-ui/` immediately; keeping browser logic as a minimal page shell with logic embedded directly in route components.

### Decision 2: Use route-driven workspace composition with explicit feature state

- **Chosen**: Route the browser into a single authenticated workspace surface, with explicit feature-owned state modules for conversation selection, transcript reconciliation, composer drafts, prompt state, and connection status.
- **Rationale**: The workspace has multiple interacting state domains (HTTP data, stream data, reconnect state, prompt state, stale control state). Explicit state modules reduce accidental coupling and make TDD feasible.
- **Alternatives rejected**: ad hoc `useState` scattered across components; fully server-state-only rendering without a workspace reconciliation layer.

### Decision 3: Separate non-stream fetch state from live stream reconciliation

- **Chosen**: Use request/query infrastructure for conversation lists, turn history, and artifact fetches, while a dedicated stream adapter + reconciler owns WebSocket event application and reconnect merge behavior.
- **Rationale**: Querying and streaming have different consistency and lifecycle needs. Treating all state as generic request cache makes reconnect, prompt recovery, and duplicate suppression harder to reason about.
- **Alternatives rejected**: putting stream events directly into generic query caches; treating reconnect as a full hard reload on every disconnect.

### Decision 4: Default to safe text/structured rendering, not rich untrusted markup

- **Chosen**: Transcript, prompts, and artifacts render as safe text or allowlisted structured views. Browser rendering does not execute raw HTML-like content or embed active content by default.
- **Rationale**: The spec explicitly calls out browser-safe rendering. Hydra work output can include arbitrary text; the workspace must remain safe even when output resembles markup or script.
- **Alternatives rejected**: rich HTML rendering by default; artifact-specific embedding without a safe allowlist.

### Decision 5: Represent control actions as explicit lineage-aware transcript events

- **Chosen**: Cancel, retry, branch, and follow-up flows are modeled as visible transcript/lineage state transitions rather than hidden button side effects.
- **Rationale**: Operators need orientation and trust. Control actions must remain attributable, especially across reconnects or multi-session convergence.
- **Alternatives rejected**: ephemeral toast-only confirmation; control actions that update only side panels without transcript visibility.

### Decision 6: Test the browser slice at three levels

- **Chosen**: (1) pure state/reconciler tests, (2) component/rendering tests, and (3) end-to-end browser workflow tests for transcript, stream, reconnect, prompt, and artifact flows.
- **Rationale**: The highest-risk failures in this slice are reconciliation and operator-visible workflow regressions. Multiple test layers are needed to keep the UI deterministic and safe.
- **Alternatives rejected**: e2e-only coverage; component-only coverage with no reconnect/control workflow tests.

## Data Model

The browser workspace introduces significant client-side state and view-model structure. See [data-model.md](./data-model.md) for the detailed browser state model.

### Core Browser Entities

| Entity                       | Description                                                              | Key Attributes                                                                               |
| ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **WorkspaceState**           | Top-level browser-owned state for the active workspace session           | active conversation, selected conversation id, connection state, sync status, visible panes  |
| **ConversationViewState**    | Browser projection of one conversation’s visible transcript and controls | ordered transcript entries, conversation metadata, lineage summary, control eligibility      |
| **ComposerDraftState**       | Per-conversation draft input state                                       | conversation id, draft content, submit state, validation errors                              |
| **StreamingTurnViewState**   | Browser projection of an in-progress or completed turn                   | turn id, status, grouped stream content, prompt state, artifacts, lineage links              |
| **PromptViewState**          | Browser representation of a pending or resolved approval/follow-up       | prompt id, parent turn id, status, allowed responses, submission state                       |
| **ArtifactViewState**        | Browser representation of an artifact listing or opened artifact         | artifact id, kind, label, availability, preview/load state                                   |
| **WorkspaceConnectionState** | Operator-visible connection/session/sync status                          | transport status, reconnecting flag, session status, daemon reachability, last synced marker |

## Interface Contracts

This slice primarily **consumes** existing gateway and shared-contract interfaces rather than publishing new cross-surface contracts. The key interfaces are browser-internal adapters:

- **Gateway REST adapter** — wraps the gateway’s conversation, turn, prompt, artifact, and work-control routes into browser-friendly functions.
- **Stream adapter** — owns WebSocket connect/subscribe/ack/reconnect behavior and emits normalized workspace events.
- **Workspace reconciler** — deterministically merges fetched conversation state and live stream events into browser-visible transcript state.

No new `contracts/` directory is required at this planning stage because this slice does not define a new public cross-package schema family; it consumes `packages/web-contracts/` and the gateway transport delivered earlier.
