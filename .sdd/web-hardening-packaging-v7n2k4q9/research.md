# Research: Web Hardening and Packaging

**Date**: 2026-03-29
**Feature**: `.sdd/web-hardening-packaging-v7n2k4q9/spec.md`

## Current-State Findings

- The browser, gateway, and shared contract workspaces already exist and are heavily exercised:
  `apps/web`, `apps/web-gateway`, and `packages/web-contracts`.
- The gateway already serves static assets from `apps/web/dist` through same-origin routing in
  `apps/web-gateway/src/server.ts` and `apps/web-gateway/src/server-runtime.ts`.
- The repo already has a packaging pipeline for the core npm tarball (`scripts/build-pack.ts`) and
  a separate Windows executable pipeline (`scripts/build-exe.ts`), but neither is clearly shaped as
  a supported, documented release path for the web-capable experience.
- Quality gates already exist at the repo level (`npm test`, `npm run quality`, coverage, cycles,
  mutation testing), and web browser specs already run from the root test command.

## Decision 1: Package the existing same-origin gateway model rather than inventing a new deployment shape

- **Chosen**: Keep the gateway as the same-origin host for browser assets, HTTP routes, and the
  WebSocket endpoint.
- **Rationale**: This matches the current architecture and README guidance, avoids creating a second
  hosting mode, and keeps authentication, CSRF, origin checks, and static asset serving in one
  coherent surface.
- **Alternatives considered**:
  - Serve the browser as a separate static site with proxy-only guidance. Rejected because it adds
    more deployment modes and weakens the single-origin mental model.
  - Push more behavior directly into the daemon. Rejected because the gateway is already the browser
    boundary and owns session/browser-facing policy.

## Decision 2: Treat packaging integration as release-path work, not just a build-script exercise

- **Chosen**: Phase 5 should define a supported launch story for packaged usage and make failures in
  unsupported packaging contexts explicit and operator-visible.
- **Rationale**: "Packaging integration" in the roadmap is about a usable release path, not just
  producing build artifacts. A tarball or executable that omits web runtime pieces without a clear
  message would fail the spec's operator and contributor stories.
- **Alternatives considered**:
  - Limit scope to source-checkout usage only. Rejected because it does not satisfy the roadmap ask.
  - Document packaging as future work. Rejected because Phase 5 is the pending release-readiness
    phase.

## Decision 3: Prefer existing test/runtime tooling for accessibility and performance hardening

- **Chosen**: Start with the existing browser-spec harness, gateway tests, root quality gates, and
  build outputs instead of introducing new hardening tools as the default path.
- **Rationale**: The repo already has strong verification plumbing. Leveraging it first keeps the
  plan aligned with current workflows and reduces tool churn.
- **Alternatives considered**:
  - Add dedicated accessibility or performance frameworks immediately. Possible later, but not the
    baseline assumption for this plan.

## Decision 4: Harden the highest-value journeys first

- **Chosen**: Focus hardening on login/session lifecycle, workspace shell, connection/failure
  banners, operations panels, and mutation dialogs.
- **Rationale**: These surfaces cover the main operator workflow and the highest-risk failure states
  already called out by the architecture and security docs.
- **Alternatives considered**:
  - Spread effort evenly across every screen. Rejected because it dilutes release-readiness work.

## Decision 5: Define failure-mode drills as reusable verification assets

- **Chosen**: Create a named drill matrix for the most important breakdowns: session expiry,
  daemon-unreachable state, reconnect/replay disruption, mutation rejection, and packaged static
  asset/runtime misconfiguration.
- **Rationale**: The roadmap explicitly calls for failure-mode drills, and named drills make the
  work testable, documentable, and repeatable in CI or release checklists.
- **Alternatives considered**:
  - Rely on ad hoc manual spot checks. Rejected because it does not scale or leave evidence.
