# Implementation Phases and SDD Plan

## Delivery Phases

These phases define the program shape. They are intentionally broader than the eventual SDD specs.

### Phase 0 — Architecture and Contract Foundation ✅ Delivered

Delivered via `web-repl-foundation`.

- establish workspaces and package boundaries: ✅ delivered
- create shared contract package and public API surface: ✅ delivered
- define conversation, turn, event, approval, artifact, and snapshot vocabulary: ✅ delivered
- name the first required daemon contract families for messaging, command execution, council events,
  task live output, and controlled mutations: ✅ delivered
- define baseline quality gates for the new packages: ✅ delivered

### Phase 1 — Secure Session and Conversation Transport ✅ Delivered

Delivered via `web-session-auth`, `web-conversation-protocol`, and `web-gateway-conversation-transport`.

- login/logout and browser session management: ✅ delivered (PRs #210, #212)
- websocket bootstrap and reconnect behavior: ✅ delivered
- conversation create/open/resume flow: ✅ delivered
- gateway REST + WebSocket mediation layer (daemon→browser event bridge, session binding): ✅ delivered
- daemon transport amendments needed by the gateway (event subscription, sequence numbering): ✅ delivered
- protocol-level validation and replay tests: ✅ delivered

### Phase 2 — Core Chat Workspace ✅ Delivered

Delivered via `web-chat-workspace` (phases 1–8, PRs #173–#185).

- transcript and composer: ✅ delivered
- streaming rendering: ✅ delivered
- cancel, retry, branch, and follow-up flows: ✅ delivered
- approvals and browser-safe interactive prompts: ✅ delivered
- artifact views: ✅ delivered

### Phase 3 — Hydra-Native Control Surfaces ✅ Delivered

Delivered via the `web-hydra-operations-panels` SDD (US1–US6, all phases).

- task queue and checkpoints: ✅ delivered
- routing, mode, agent, and council controls: ✅ delivered
- budgets and daemon health: ✅ delivered
- council and multi-agent execution visualization: ✅ delivered

### Phase 4 — Controlled Mutations and Operational Workflows ✅ Complete

- safe config read/write subset through daemon-owned APIs;
- approved workflow-launch surfaces;
- audit trails and destructive-action safeguards.

### Phase 5 — Hardening, Packaging, and Polishing ✅ Complete

- packaging integration: ✅ delivered (npm tarball includes `dist/web-runtime/` with bundled
  gateway entry + browser assets; `prepack`/`postpack` lifecycle scripts; packaging integration
  tests via `npm run package:evidence`)
- responsiveness and layout hardening: ✅ delivered (Phase 4 operations panel work)
- contributor verification and troubleshooting documentation: ✅ delivered
- accessibility and performance hardening: ✅ delivered
- security review and failure-mode drills: ✅ delivered

## Recommended SDD Spec Breakdown

| #   | Spec                                     | Status                                                                                                            |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | **`web-repl-foundation`**                | ✅ Delivered                                                                                                      |
| 2   | **`web-session-auth`**                   | ✅ Delivered (PRs #210, #212)                                                                                     |
| 3   | **`web-conversation-protocol`**          | ✅ Delivered                                                                                                      |
| 4   | **`web-gateway-conversation-transport`** | ✅ Delivered — gateway REST + WebSocket mediation, session binding, reconnect/resume, daemon transport amendments |
| 5   | **`web-chat-workspace`**                 | ✅ Delivered (phases 1–8, PRs #173–#185)                                                                          |
| 6   | **`web-hydra-operations-panels`**        | ✅ Delivered — Hydra-native operations visibility and daemon-authorized controls (US1–US6, PRs #201–#209)         |
| 7   | **`web-controlled-mutations`**           | ✅ Delivered (PR #221)                                                                                            |
| 8   | **`web-hardening-and-packaging`**        | ✅ Delivered (PR #222)                                                                                            |

## Recommended Workflow

For each spec:

1. create the spec with `sdd.specify`;
2. review and revise it with GPT-5.4;
3. generate the plan with Opus 4.6 via `sdd.plan`;
4. review and revise the plan with GPT-5.4;
5. generate dependency-ordered tasks with `sdd.tasks`;
6. implement one spec at a time with strict validation.

## Open Questions (Resolved)

1. ~~Should the daemon own browser-native conversation/session entities directly in phase one, or
   should the gateway temporarily adapt current task semantics while new daemon contracts land?~~
   **Resolved:** Daemon owns entities; gateway is the bridge layer.
2. ~~How much streamed conversation state should be persisted for reconnect and history replay?~~
   **Resolved:** Full turn history with sequence-numbered events and replay buffer.
3. ~~What event structure best represents council and multi-agent deliberation?~~
   **Resolved:** `AgentExecutionGroup` with participant snapshots; delivered in `web-hydra-operations-panels`.
4. ~~Which config and workflow mutations are safe enough for early browser phases?~~
   **Resolved:** Delivered in `web-controlled-mutations` (PR #221).
5. When does the repo benefit enough from `turbo` to justify adding it beyond workspaces?
6. ~~How should browser assets and the gateway runtime be packaged for both npm distribution and the
   existing executable paths?~~
   **Resolved:** npm tarball ships `dist/web-runtime/` (bundled gateway + browser assets); standalone
   exe remains CLI-only. See [`docs/WEB_INTERFACE.md`](../WEB_INTERFACE.md) § Supported Packaging
   Targets.
7. Which command families should be exposed through a typed command catalog first so the web UI can
   reach meaningful operator parity without inventing browser-only workflows?
