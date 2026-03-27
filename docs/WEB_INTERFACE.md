# Hydra Web Interface

> **Status:** Active — specs 1–6 delivered; `web-controlled-mutations` in progress
> **Scope:** Browser-native Hydra workspace with full REPL-grade capabilities, strict quality gates, and SDD-driven delivery

This document is the entry point for Hydra's web-interface design set.

The web initiative is no longer scoped as a thin dashboard or a narrow adapter over existing daemon
endpoints. The target is a **full REPL-grade Hydra web experience**: a rich chat workspace similar
in UX quality to Claude or ChatGPT, but centered on Hydra's strengths—routing, councils, task
execution, approvals, checkpoints, budgets, and operational visibility.

To keep the work easier to reason about, the design has been split into smaller focused documents.

## Document Map

1. [`docs/web-interface/01-overview.md`](./web-interface/01-overview.md)
   - product framing, what "full REPL" means, goals, and non-goals.

2. [`docs/web-interface/02-stack-and-monorepo.md`](./web-interface/02-stack-and-monorepo.md)
   - language choice, frontend/backend framework recommendations, workspace strategy, and package
     boundaries.

3. [`docs/web-interface/03-architecture.md`](./web-interface/03-architecture.md)
   - target runtime architecture, responsibility split, and daemon ownership rules.

4. [`docs/web-interface/04-protocol.md`](./web-interface/04-protocol.md)
   - browser protocol requirements, conversation model, streaming semantics, and transport choices.

5. [`docs/web-interface/05-security-and-quality.md`](./web-interface/05-security-and-quality.md)
   - auth/session model, security posture, quality rules, test layers, and CI expectations.

6. [`docs/web-interface/06-phases-and-sdd.md`](./web-interface/06-phases-and-sdd.md)
   - implementation phases, recommended SDD spec breakdown, and open questions.

7. [`docs/web-interface/07-boundaries-and-governance.md`](./web-interface/07-boundaries-and-governance.md)
   - workspace boundary, ownership rules, cross-boundary governance, and extension process.

## Current Direction Summary

- Choose **TypeScript end-to-end** for the web initiative.
- Keep the existing Hydra runtime lean by isolating the web app and gateway in dedicated
  workspaces/packages.
- Treat **WebSocket** as the primary interactive transport for the browser REPL.
- Keep the **daemon authoritative** for orchestration state and durable mutations.
- Use **SDD** to break the work into small, reviewable specs and plans before implementation.
- Hold the web work to strict standards for TDD, security, type safety, architecture, and CI.

## SDD Execution Progress

| #   | Spec                                 | Status                                   |
| --- | ------------------------------------ | ---------------------------------------- |
| 1   | `web-repl-foundation`                | ✅ Delivered                             |
| 2   | `web-session-auth`                   | ✅ Delivered (PRs #210, #212)            |
| 3   | `web-conversation-protocol`          | ✅ Delivered                             |
| 4   | `web-gateway-conversation-transport` | ✅ Delivered                             |
| 5   | `web-chat-workspace`                 | ✅ Delivered (phases 1–8, PRs #173–#185) |
| 6   | `web-hydra-operations-panels`        | ✅ Delivered (US1–US6, PRs #201–#209)    |
| 7   | **`web-controlled-mutations`**       | 🔄 In progress                           |
| 8   | `web-hardening-and-packaging`        | ⬜ Pending                               |

## Next Step

**`web-controlled-mutations`** — safe config read/write through daemon-owned APIs, approved
workflow-launch surfaces, audit trails, and destructive-action safeguards.

See [`docs/web-interface/06-phases-and-sdd.md`](./web-interface/06-phases-and-sdd.md) for full phase
and spec breakdown details.
