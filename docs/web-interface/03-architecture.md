# Target Architecture

## High-Level Shape

```mermaid
flowchart TB
    subgraph Browser[apps/web]
        Workspace[Conversation workspace]
        Panels[Hydra panels\nqueue, budgets, council, artifacts]
        Settings[Session and settings surfaces]
    end

    subgraph Gateway[apps/web-gateway]
        Auth[Browser auth and sessions]
        Socket[WebSocket session transport]
        Api[REST/BFF routes]
        Static[Static asset delivery]
    end

    subgraph Contracts[packages/web-contracts]
        Schemas[Shared schemas\nand event types]
    end

    subgraph Daemon[Hydra daemon + core runtime]
        Sessions[Conversation/task/session authority]
        Routing[Routing and councils]
        Tasks[Task execution and checkpoints]
        Events[Event persistence and replay]
        Config[Config and controlled writes]
    end

    Browser -->|HTTPS + WebSocket| Gateway
    Browser -->|typed DTOs| Schemas
    Gateway -->|typed DTOs| Schemas
    Gateway -->|daemon API| Daemon
    Daemon -->|domain events + responses| Gateway
```

## Responsibility Split

| Component                | Responsibility                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/web`               | Browser UX, conversation workspace, artifacts, approvals, reconnect UX, Hydra-specific operator panels       |
| `apps/web-gateway`       | Auth, browser sessions, WebSocket termination, REST routes, static serving, protocol translation             |
| `packages/web-contracts` | Shared schemas and DTOs for requests, events, approvals, artifacts, and snapshots                            |
| Hydra daemon             | Source of truth for orchestration state, task lifecycle, sessions, durable events, config/workflow mutations |

## Architectural Rules

1. **The daemon stays authoritative.**
   The gateway may adapt browser interactions into daemon calls, but it must not become the hidden
   home for Hydra behavior.

2. **The gateway is not a second control plane.**
   If a feature requires durable orchestration semantics, persistence, or controlled writes, the
   daemon should own it.

3. **Shared contracts come before shared behavior.**
   Browser, gateway, and daemon integration should align through versioned schemas rather than
   duplicated assumptions.

4. **The browser should feel native, not terminal-emulated.**
   Build browser-safe flows for approvals, artifacts, retries, and reconnect behavior instead of
   trying to mirror raw TTY interactions.
