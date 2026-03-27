# Implementation Phases and SDD Plan

## Delivery Phases

These phases define the program shape. They are intentionally broader than the eventual SDD specs.

### Phase 0 — Architecture and Contract Foundation

- establish workspaces and package boundaries;
- create shared contract package and public API surface;
- define conversation, turn, event, approval, artifact, and snapshot vocabulary;
- name the first required daemon contract families for messaging, command execution, council events,
  task live output, and controlled mutations;
- define baseline quality gates for the new packages.

### Phase 1 — Secure Session and Conversation Transport

- login/logout and browser session management;
- websocket bootstrap and reconnect behavior;
- conversation create/open/resume flow;
- gateway REST + WebSocket mediation layer (daemon→browser event bridge, session binding);
- daemon transport amendments needed by the gateway (event subscription, sequence numbering);
- protocol-level validation and replay tests.

### Phase 2 — Core Chat Workspace

- transcript and composer;
- streaming rendering;
- cancel, retry, branch, and follow-up flows;
- approvals and browser-safe interactive prompts;
- artifact views.

### Phase 3 — Hydra-Native Control Surfaces ✅ Delivered

Delivered via the `web-hydra-operations-panels` SDD (US1–US6, all phases).

- task queue and checkpoints: ✅ delivered
- routing, mode, agent, and council controls: ✅ delivered
- budgets and daemon health: ✅ delivered
- council and multi-agent execution visualization: ✅ delivered

### Phase 4 — Controlled Mutations and Operational Workflows

- safe config read/write subset through daemon-owned APIs;
- approved workflow-launch surfaces;
- audit trails and destructive-action safeguards.

### Phase 5 — Hardening, Packaging, and Polishing

- packaging integration;
- accessibility and performance hardening;
- security review and failure-mode drills;
- contributor/documentation updates.

## Recommended SDD Spec Breakdown

After the document set is accepted, break the work into these specs:

1. **`web-repl-foundation`**
2. **`web-session-auth`**
3. **`web-conversation-protocol`**
4. **`web-gateway-conversation-transport`** — gateway REST + WebSocket mediation, session binding, reconnect/resume, and daemon transport amendments
5. **`web-chat-workspace`**
6. **`web-hydra-operations-panels`** — Hydra-native operations visibility and daemon-authorized controls (US1–US6, all phases delivered)
7. **`web-controlled-mutations`**
8. **`web-hardening-and-packaging`**

### Suggested early execution order

The most important early dependency is getting the protocol and backend contract shape right before
the richer UI work expands.

1. `web-repl-foundation`
2. `web-session-auth`
3. `web-conversation-protocol`
4. `web-gateway-conversation-transport`
5. `web-chat-workspace`
6. `web-hydra-operations-panels`
7. `web-controlled-mutations`
8. `web-hardening-and-packaging`

If the daemon needs significant new conversation or command contracts, that work should be planned
inside or immediately adjacent to `web-conversation-protocol` or
`web-gateway-conversation-transport` rather than deferred until the UI is already built. The
transport slice explicitly includes daemon transport amendments (event subscription, sequence
numbering, replay buffer) as work items rather than assuming they exist.

## Recommended Workflow

For each spec:

1. create the spec with `sdd.specify`;
2. review and revise it with GPT-5.4;
3. generate the plan with Opus 4.6 via `sdd.plan`;
4. review and revise the plan with GPT-5.4;
5. generate dependency-ordered tasks with `sdd.tasks`;
6. implement one spec at a time with strict validation.

## Open Questions

1. Should the daemon own browser-native conversation/session entities directly in phase one, or
   should the gateway temporarily adapt current task semantics while new daemon contracts land?
2. How much streamed conversation state should be persisted for reconnect and history replay?
3. What event structure best represents council and multi-agent deliberation?
4. Which config and workflow mutations are safe enough for early browser phases?
5. When does the repo benefit enough from `turbo` to justify adding it beyond workspaces?
6. How should browser assets and the gateway runtime be packaged for both npm distribution and the
   existing executable paths?
7. Which command families should be exposed through a typed command catalog first so the web UI can
   reach meaningful operator parity without inventing browser-only workflows?
