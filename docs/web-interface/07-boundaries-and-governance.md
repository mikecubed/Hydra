---
# Machine-readable metadata for automated agents and CI tooling
workspace_roots:
  - apps/web
  - apps/web-gateway
  - packages/web-contracts
ownership:
  apps/web: browser
  apps/web-gateway: gateway
  packages/web-contracts: shared
  lib/: hydra-core
phases:
  - foundation
  - session-auth
  - conversation-protocol
  - chat-workspace
  - operations
  - mutations
  - hardening
governance: cross-boundary-review-required
---

# Boundaries and Governance

> **Parent document:** [`docs/WEB_INTERFACE.md`](../WEB_INTERFACE.md)
> **Status:** Active — established by the `web-repl-foundation` slice.

This document defines the workspace boundary between the Hydra web initiative and the existing Hydra
core, ownership rules per directory, cross-boundary governance, and the exception process.

## Workspace Boundary

The web initiative adds three workspace packages to the repository. These coexist with the existing
Hydra core structure (`lib/`, `bin/`, `scripts/`, `test/`) without reorganizing it.

| Directory                 | Surface    | Responsibility                                  |
| ------------------------- | ---------- | ----------------------------------------------- |
| `apps/web/`               | Browser    | React + Vite frontend workspace                 |
| `apps/web-gateway/`       | Gateway    | Hono HTTP/WebSocket gateway                     |
| `packages/web-contracts/` | Shared     | Cross-surface Zod schemas, vocabulary, and DTOs |
| `lib/`                    | Hydra core | Existing daemon, orchestrator, and CLI runtime  |
| `bin/`                    | Hydra core | CLI entry points and launchers                  |
| `scripts/`                | Hydra core | Dev utilities                                   |
| `test/`                   | All        | Tests for all surfaces (core + web initiative)  |

## Import Direction Rules

Import directions are enforced by ESLint (`eslint-plugin-boundaries`):

- `apps/web` → may import from `packages/web-contracts` only (will be extended for `packages/web-ui`
  when created).
- `apps/web-gateway` → may import from `packages/web-contracts` only (will be extended for daemon
  public API imports when that surface is formalized).
- `packages/web-contracts` → no internal dependencies (only Zod).
- `apps/web` ↛ `apps/web-gateway` (and vice versa) — no direct imports between apps.
- `apps/*` and `packages/*` ↛ `lib/` — web initiative must not import Hydra core internals.

## Cross-Boundary Governance

### Rule: Review required for cross-boundary changes

Any change that touches **both** `apps/` or `packages/` **and** `lib/` in the same PR requires:

1. Explicit justification in the PR description explaining why the cross-boundary coupling is
   necessary.
2. Review by a core maintainer to confirm the coupling is intentional and correctly scoped.

### Ambiguous Ownership

When a change cannot be cleanly classified as "web initiative" or "Hydra core," the **default
classification is Hydra core**. This ensures the established boundary is not inadvertently eroded.

If a contributor believes a change belongs to the web initiative but it touches `lib/`, they must:

1. Open a discussion or issue explaining the boundary ambiguity.
2. Get explicit agreement before proceeding.
3. Document the resolution in the PR description.

### Exception Process

In emergencies requiring a boundary violation (e.g., a critical bug fix that spans both sides):

1. Create the PR with a clear `[BOUNDARY EXCEPTION]` prefix in the title.
2. Document the justification and the plan to resolve the coupling post-merge.
3. Obtain two reviewer approvals instead of one.
4. File a follow-up issue to clean up the exception within the current sprint.

## Phase Roadmap

Known future phases and their expected workspace changes:

| Phase                   | Expected Packages                                            |
| ----------------------- | ------------------------------------------------------------ |
| `foundation` (current)  | `apps/web`, `apps/web-gateway`, `packages/web-contracts`     |
| `session-auth`          | Additions to `apps/web-gateway` and `packages/web-contracts` |
| `conversation-protocol` | Additions to `packages/web-contracts`, new daemon contracts  |
| `chat-workspace`        | Additions to `apps/web`, potentially `packages/web-ui`       |
| `operations`            | Additions to `apps/web`                                      |
| `mutations`             | Additions to `apps/web-gateway` and `packages/web-contracts` |
| `hardening`             | Cross-cutting quality and security improvements              |

## Extending the Foundation

### Adding a New Shared Contract

1. Create the contract file in `packages/web-contracts/src/` (e.g., `session-contract-v1.ts`).
2. Register it in `packages/web-contracts/CONTRACTS.md` with name, version, status, and consumers.
3. Add a barrel re-export in `packages/web-contracts/src/index.ts` (append-only).
4. Write conformance tests in `test/web-contracts/` using the shared `contract-helpers.ts` utilities.

No foundation structural artifacts need modification.

### Adding a New Workspace Package

1. Create a directory under `apps/` or `packages/` (e.g., `packages/web-ui/`).
2. Add `package.json` with workspace metadata and `tsconfig.json` extending the root.
3. Run `npm install` — the workspaces glob (`apps/*`, `packages/*`) covers it automatically.
4. The new package inherits all documented quality expectations from `packages/web-contracts/QUALITY.md`.

No root `package.json` workspaces array modification needed (glob-based).

### Adding a New Quality Rule

1. Add the ESLint rule entry to `eslint.config.mjs`.
2. Existing rules are **never weakened** — new rules only augment the gate.

### Extending a Boundary Rule

To allow new import directions (e.g., `apps/web` importing from a new `packages/web-ui`):

1. Update the `allow` array in the relevant ESLint boundary rule.
2. Document the change in this file's Import Direction Rules section.
