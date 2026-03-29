# Hydra Web Interface

> **Status:** Active — all 8 specs delivered; Phase 5 complete
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
| 7   | **`web-controlled-mutations`**       | ✅ Delivered (PR #221)                   |
| 8   | `web-hardening-and-packaging`        | ✅ Delivered (PR #222)                   |

## Supported Packaging Targets

The web interface is supported from both a **source checkout** and the published **npm package**.
Standalone executables remain CLI-only.

| Distribution form         | Web interface status | Reason                                                                               |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| **Source checkout**       | ✅ Supported         | Full monorepo; build browser bundle, start gateway + daemon                          |
| **npm package** (tarball) | ✅ Included          | Published artifact ships `dist/web-runtime/` with bundled gateway entry + web assets |
| **Standalone executable** | ❌ Not included      | Single binary; operator mode only (`--full` unsupported)                             |

### What this means for operators

- **Source checkout users** follow the startup commands in
  [apps/web-gateway/README.md](../apps/web-gateway/README.md) to build the browser bundle, start
  the daemon, and launch the same-origin gateway.
- **npm package users** get full CLI/REPL orchestration and can also start the packaged web
  interface via `node dist/web-runtime/server.js`. The published tarball includes
  `dist/web-runtime/server.js`, bundled browser assets under `dist/web-runtime/web/`, and a
  `.packaged` sentinel used for packaged-runtime detection. If those bundled assets are missing,
  the package artifact is incomplete and should be rebuilt from a source checkout.
- **Standalone exe users** get operator-mode CLI support (`hydra`, `hydra --prompt`, subcommands)
  but `hydra --full` is explicitly rejected in standalone `.exe` builds. The web interface is not
  available.

### Why source checkout and npm package support differ

The web interface is built around a same-origin gateway that serves the React browser bundle
(`apps/web/dist` in a source checkout, `dist/web-runtime/web/` in the npm package) and owns
HTTP/WebSocket routing, authentication, CSRF protection, and session management.

- **Source checkout** keeps the full monorepo layout (`apps/web`, `apps/web-gateway`,
  `packages/web-contracts`) and is the best surface for active development.
- **npm package** ships a prebuilt packaged runtime under `dist/web-runtime/` so operators can run
  the gateway and bundled frontend without the workspace sources.
- **Standalone executable** stays focused on CLI orchestration and does not include the packaged web
  runtime.

## Current Focus

**`web-hardening-and-packaging`** is complete. The npm tarball ships `dist/web-runtime/` with
bundled gateway and browser assets. Contributor release-readiness documentation, verification
guidance, and quality-gate coverage for the full web stack are all delivered.

Standalone executables remain CLI-only — web support is available via source checkout and npm
package.

See [`docs/web-interface/06-phases-and-sdd.md`](./web-interface/06-phases-and-sdd.md) for full phase
and spec breakdown details, and [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the web-interface
verification sequence.
