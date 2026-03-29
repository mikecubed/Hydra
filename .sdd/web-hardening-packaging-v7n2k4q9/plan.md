# Implementation Plan: Web Hardening and Packaging

**Date**: 2026-03-29
**Spec**: `.sdd/web-hardening-packaging-v7n2k4q9/spec.md`
**Research**: `.sdd/web-hardening-packaging-v7n2k4q9/research.md`

## Summary

Complete the pending Phase 5 web-interface roadmap work by turning the already delivered browser,
gateway, and mutation surfaces into a release-ready experience. The implementation should extend
the existing same-origin gateway model, close packaging gaps, harden the highest-value workflows
for accessibility and failure recovery, define explicit responsiveness targets, and update docs/CI
so contributors can verify and troubleshoot the web experience without source-diving.

## Technical Context

| Dimension | Decision |
| --- | --- |
| **Language/Version** | TypeScript 5.x, ESM, Node 24+ |
| **Primary Dependencies** | React 19 + Vite 8 (`apps/web`), Hono (`apps/web-gateway`), Zod (`packages/web-contracts`) |
| **Storage** | Browser static bundle in `apps/web/dist`; gateway local state in `~/.hydra/web-gateway`; existing daemon/runtime state remains authoritative |
| **Testing** | Root `npm test`; Vitest browser specs in `apps/web`; Node `node:test` suites in `apps/web-gateway`, `packages/web-contracts`, and `test/`; repo `npm run quality` |
| **Target Platform** | Same-origin browser + gateway deployment for local and explicit remote operator use |
| **Project Type** | Monorepo workspace web app + gateway + shared contracts |
| **Performance Goals** | Define explicit load/responsiveness budgets for login and primary workspace surfaces, then verify them with repeatable build/test evidence |
| **Constraints** | Preserve daemon authority; preserve existing auth/CSRF/origin/TLS posture; no boundary erosion between `apps/*`, `packages/*`, and `lib/`; packaged usage must fail explicitly when unsupported |
| **Scale/Scope** | Operator-oriented Hydra deployment, not multi-tenant public hosting |

## Project Structure

### Feature Artifacts

```text
.sdd/web-hardening-packaging-v7n2k4q9/
├── spec.md
├── research.md
├── plan.md
└── tasks.md
```

### Repository Areas in Scope

```text
apps/web/
├── src/app/
├── src/routes/
├── src/features/auth/
├── src/features/chat-workspace/
├── src/features/operations-panels/
├── src/features/mutations/
└── README.md

apps/web-gateway/
├── src/server.ts
├── src/server-runtime.ts
├── src/index.ts
├── src/auth/
├── src/session/
├── src/security/
├── src/transport/
└── README.md

packages/web-contracts/
└── src/              # Only if hardening exposes a genuine shared contract gap

scripts/
├── build-pack.ts
├── clean-pack.ts
└── build-exe.ts

.github/workflows/
├── ci.yml
└── quality.yml

docs/
├── WEB_INTERFACE.md
└── web-interface/

README.md
CONTRIBUTING.md
package.json
```

**Structure Decision**: Keep Phase 5 centered in existing web and packaging surfaces. Avoid new
workspace packages unless a hard requirement appears during implementation.

## Research Findings

### Decision: Keep the same-origin gateway deployment model

- **Chosen**: Extend the current model where the gateway serves the built browser bundle and owns the
  same-origin HTTP/WebSocket boundary.
- **Rationale**: This is already how `apps/web-gateway/src/server.ts` and the workspace READMEs are
  structured, and it preserves the current security model.
- **Alternatives considered**: Separate static hosting mode; daemon-hosted web assets.

### Decision: Make packaging integration a supported operator path

- **Chosen**: Phase 5 should upgrade packaging from "there is a build artifact" to "there is a
  documented, supported way to launch the web experience from packaged output or receive an explicit
  unsupported message."
- **Rationale**: This is the only way to satisfy the roadmap's packaging and contributor goals.
- **Alternatives considered**: Leave packaged web launch undefined.

### Decision: Use existing verification infrastructure first

- **Chosen**: Build hardening checks around existing browser specs, gateway tests, repo quality
  scripts, and packaging scripts before considering extra tools.
- **Rationale**: The repo already has strong CI and test plumbing; Phase 5 should integrate with it.
- **Alternatives considered**: Introduce a separate hardening toolchain immediately.

### Decision: Prioritize the highest-value hardening journeys

- **Chosen**: Login/session lifecycle, workspace shell, connection/failure banners, operations
  panels, and mutation dialogs are the primary hardening surfaces.
- **Rationale**: These cover the main operator journey and most important failure/security states.
- **Alternatives considered**: Uniform hardening across every route and component.

## Data Model

Phase 5 is mostly hardening and release-readiness work, so it does not introduce a large new domain
model. The main planning entities are:

- **PackagedLaunchProfile**
  - Represents a supported launch path for the web-capable experience.
  - Key fields: artifact type, required assets, startup command, prerequisite checks, unsupported
    state message.

- **FailureDrillScenario**
  - Represents a named release-readiness drill for a critical failure condition.
  - Key fields: drill id, trigger condition, affected surface, expected visible state, recovery
    action, verification method.

- **AccessibilityTarget**
  - Represents a high-value workflow or component group that must remain keyboard- and
    assistive-technology-friendly.
  - Key fields: route/surface, interaction path, focus expectations, state/error expectations.

- **PerformanceBudget**
  - Represents a measurable responsiveness target for a primary web surface.
  - Key fields: surface, metric, threshold, evidence source, enforcement point.

- **ReleaseReadinessGuide**
  - Represents the documentation and CI evidence bundle contributors use to verify the feature.
  - Key fields: commands, expected outputs, troubleshooting notes, supported packaging paths.

## Interface Contracts

Phase 5 should prefer existing interfaces and only add new ones when the hardening work cannot be
expressed through current surfaces.

### Existing interfaces to preserve and harden

- **Gateway startup/runtime interface**
  - `apps/web-gateway/src/server.ts`
  - `apps/web-gateway/src/server-runtime.ts`
  - Existing environment-variable-based launch contract and static-dir resolution

- **Browser same-origin interface**
  - Existing `/auth`, `/session`, `/conversations`, `/approvals`, `/turns`, `/artifacts`,
    `/operations`, `/config`, `/audit`, and `/ws` surfaces

- **Packaging interface**
  - Root `npm run package`, `npm run package:dry-run`, and `npm run build:exe`
  - Any new web-capable packaged launch path should compose with these rather than bypass them

- **Contributor verification interface**
  - Root `npm test` and `npm run quality`
  - Workspace README guidance and top-level docs

### Contract policy for this phase

- Avoid new browser/daemon protocol families unless a hardening requirement exposes a missing shared
  contract.
- Keep any packaging or verification interface additive and documented.
- If packaged execution cannot support the web surface in one artifact form, the resulting runtime
  must surface that limitation explicitly and the docs must state the supported path.

## Implementation Phases

### Phase 0 — Baseline and Readiness Matrix

**Goal**: Convert the umbrella spec into a concrete release-readiness matrix.

Deliverables:

- Inventory the current packaged and source-checkout launch paths for the web-capable experience.
- Define the Phase 5 scope matrix: packaging, accessibility, performance, failure drills, docs, CI.
- Record explicit performance budgets and supported packaging targets.
- Identify which gaps require code changes versus doc-only updates.

Exit gate:

- Phase 5 readiness matrix checked into `.sdd/web-hardening-packaging-v7n2k4q9/tasks.md`
- No unresolved scope ambiguity around supported packaging targets

### Phase 1 — Packaging Integration

**Goal**: Make the web-capable experience available through a supported packaged path.

Workstreams:

- Extend packaging scripts and included assets so the supported packaged artifact contains the web
  runtime pieces it needs, or emits an explicit unsupported-state message when that artifact form is
  intentionally out of scope.
- Align startup docs and runtime behavior around a single supported launch story.
- Verify same-origin static asset resolution from packaged output.
- Validate remote-host configuration documentation against actual runtime expectations.

Likely files:

- `scripts/build-pack.ts`
- `scripts/clean-pack.ts`
- `scripts/build-exe.ts`
- `package.json`
- `apps/web-gateway/src/server.ts`
- `apps/web-gateway/src/server-runtime.ts`
- `apps/web/README.md`
- `apps/web-gateway/README.md`
- `README.md`

Exit gate:

- Packaged usage path is documented and reproducible
- Missing/unsupported packaged contexts fail explicitly instead of silently

### Phase 2 — Failure-Mode and Security Hardening

**Goal**: Make the highest-risk breakdowns operator-visible, safe, and testable.

Workstreams:

- Define named drills for session expiry, daemon-unreachable state, reconnect/replay disruption,
  mutation rejection, and packaged runtime misconfiguration.
- Tighten recovery messaging and degraded-state handling across auth, workspace, operations, and
  mutation surfaces.
- Verify hardened headers and deployment guidance remain aligned with the documented security
  posture.
- Ensure protected actions never present false-success UI on rejected or partial outcomes.

Likely files:

- `apps/web/src/features/auth/`
- `apps/web/src/features/chat-workspace/`
- `apps/web/src/features/operations-panels/`
- `apps/web/src/features/mutations/`
- `apps/web-gateway/src/security/`
- `apps/web-gateway/src/session/`
- `apps/web-gateway/src/transport/`
- `apps/web-gateway/src/shared/gateway-error-response.ts`

Exit gate:

- Drill matrix is implemented or documented with repeatable verification steps
- Critical failure states have explicit operator-visible recovery paths

### Phase 3 — Accessibility and Responsiveness Hardening

**Goal**: Ensure the core operator journeys remain usable, discoverable, and responsive.

Workstreams:

- Add keyboard/focus/error-state coverage for login, workspace shell, operations panels, and
  mutation dialogs.
- Tighten layout behavior for supported narrow viewports and modal/banner interactions.
- Define measurable responsiveness targets and add regression-safe verification for the most
  important surfaces.
- Identify and fix obvious rerender, unbounded-list, or refresh-cycle regressions that materially
  degrade usability.

Likely files:

- `apps/web/src/app/`
- `apps/web/src/routes/`
- `apps/web/src/features/auth/`
- `apps/web/src/features/chat-workspace/`
- `apps/web/src/features/operations-panels/`
- `apps/web/src/features/mutations/`
- `apps/web/vite.config.ts`

Exit gate:

- Core workflows are keyboard-operable
- Accessibility and responsiveness targets have repeatable test evidence

### Phase 4 — Contributor and CI Readiness

**Goal**: Make Phase 5 verifiable and maintainable by contributors.

Workstreams:

- Update top-level and workspace docs with supported launch, packaging, verification, and
  troubleshooting guidance.
- Add or tighten CI hooks for the chosen hardening evidence without duplicating existing checks.
- Document known constraints and unsupported deployment modes clearly.
- Ensure the roadmap/docs reflect that the pending web-interface phase is complete once implemented.

Likely files:

- `README.md`
- `CONTRIBUTING.md`
- `docs/WEB_INTERFACE.md`
- `docs/web-interface/05-security-and-quality.md`
- `docs/web-interface/06-phases-and-sdd.md`
- `.github/workflows/ci.yml`
- `.github/workflows/quality.yml`

Exit gate:

- A contributor can follow the docs to run, verify, package, and troubleshoot the web interface
- CI reflects the chosen release-readiness checks

## Validation Strategy

Use the repo's existing commands as the primary verification path:

```bash
npm run quality
npm test
npm --workspace @hydra/web run build
npm --workspace @hydra/web-gateway run test
npm run package:dry-run
```

Add phase-specific drills and any narrower workspace commands only where they provide missing
evidence for packaging, accessibility, or responsiveness.

## Risks and Mitigations

- **Risk**: Packaging the web runtime may require cross-boundary changes touching root scripts, docs,
  and gateway runtime.
  - **Mitigation**: Keep the same-origin model and document the supported artifact matrix early.

- **Risk**: Accessibility and responsiveness work can sprawl across many components.
  - **Mitigation**: Limit mandatory coverage to the highest-value journeys defined in the spec.

- **Risk**: CI additions may duplicate existing checks or slow the pipeline unnecessarily.
  - **Mitigation**: Reuse `npm test`, `npm run quality`, and packaging scripts wherever possible.
