# Security and Quality Standards

## Security Posture

Security is a first-class design goal.

### Baseline rules

- loopback-only by default;
- LAN exposure only by explicit operator opt-in;
- TLS required for non-loopback access;
- no broad CORS;
- browser should not store or reuse the raw daemon control token for ordinary operations.

## Auth and Session Model

Use a **browser session cookie** backed by gateway-controlled validation.

Recommended properties:

- `HttpOnly`;
- `SameSite=Strict`;
- `Secure` whenever HTTPS is used;
- short lifetime with explicit idle refresh rules;
- immediate logout revocation;
- websocket handshake bound to the authenticated session with origin validation.

## Browser Safety Requirements

- strict CSP and hardened response headers;
- `Origin` validation on state-changing routes and socket commands;
- CSRF protection for non-idempotent HTTP routes;
- rate limiting on login, mutating endpoints, and socket session creation;
- no unsafe rendering of streamed content or artifacts;
- secret masking and allowlisted fields for future config surfaces.

## Durable Mutation Rules

The gateway must never directly write arbitrary config, files, or schedules.

For durable changes, use a daemon-owned API with:

- allowlisted writable fields;
- optimistic concurrency;
- audit events;
- schema validation;
- explicit authorization checks.

## Quality Standards

The web initiative should use the strictest practical engineering discipline.

### Required principles

- TDD by default;
- small composable modules;
- SOLID and DRY through package boundaries and shared contracts;
- no hidden state machines in components when explicit state modeling is warranted;
- no schema duplication across browser, gateway, and daemon boundaries;
- no silent fallbacks for auth, connection, or mutation failures;
- new browser-facing contracts should avoid introducing raw transport metadata fields unless a
  dedicated browser-safe contract explicitly owns and justifies that exposure.

### Enforceable rules to add

- lint complexity and nesting limits;
- max-lines and architectural-boundary rules;
- cycle detection;
- no untyped socket payload handling;
- no unchecked `any` escape hatches in protocol packages;
- mandatory tests for new public contracts and stateful workflows.

## Responsiveness Budgets

Every primary web surface must meet explicit responsiveness targets under normal local operating
conditions. "Normal" means one active operator session on a development machine with the daemon and
gateway running locally.

### Build and bundle targets

These are Phase 0 target budgets. Enforcement via CI is planned for the evidence-hook tasks
(T021–T025).

| Metric                            | Threshold | Evidence command                                            |
| --------------------------------- | --------- | ----------------------------------------------------------- |
| Production build succeeds         | exit 0    | `npm --workspace @hydra/web run build`                      |
| JS bundle size (gzipped)          | ≤ 250 KB  | Vite build output — check total gzip column                 |
| CSS bundle size (gzipped)         | ≤ 50 KB   | Vite build output — check total gzip column                 |
| Build time                        | ≤ 30 s    | Wall-clock time of build command                            |
| Root CLI package dry-run succeeds | exit 0    | `npm run package:dry-run` (validates root CLI package only) |

### Runtime responsiveness targets

The following targets define the expected user-perceived responsiveness for each primary surface.
Behavioral targets (marked ✅) can be verified today through jsdom-based browser specs and
integration tests. Timing and profiling targets (marked 🔮) require real-browser instrumentation
that is not yet in place — they are recorded here as design intent and will become enforceable once
evidence-hook work lands (see T021–T025 in the task graph).

| Surface                      | Metric                       | Target   | Verifiable now |
| ---------------------------- | ---------------------------- | -------- | -------------- |
| Login page                   | Mounts without error         | yes      | ✅             |
| Authenticated workspace      | Mounts without error         | yes      | ✅             |
| Operations panels            | Renders initial content      | yes      | ✅             |
| Mutation dialogs             | Open-to-interactive          | ≤ 500 ms | 🔮             |
| Live update cycle            | Input-to-render latency      | ≤ 200 ms | 🔮             |
| Repeated refresh (10 cycles) | No unreclaimed subscriptions | 0 leaks  | ✅             |
| WebSocket reconnect          | Reconnect attempt initiated  | ≤ 3 s    | ✅             |
| Login page                   | Time to interactive (TTI)    | ≤ 2 s    | 🔮             |
| Authenticated workspace      | Time to interactive (TTI)    | ≤ 3 s    | 🔮             |
| Operations panels            | First meaningful paint (FMP) | ≤ 2 s    | 🔮             |
| Repeated refresh (10 cycles) | Cumulative memory growth     | < 5 %    | 🔮             |

### Evidence expectations

These budgets are **target expectations for Phase 0**, not already-enforced CI checks. Current
evidence relies on the commands and test layers that exist today:

- **Browser specs** (`apps/web/src/features/**/*.browser.spec.tsx`) should include behavioral
  assertions (mount success, subscription cleanup, reconnect initiation) for the ✅ rows above.
- **Gateway tests** (`npm --workspace @hydra/web-gateway run test`) must pass without timeout
  failures.
- **Quality gate** (`npm run quality`) must pass — this validates linting, formatting, type
  checking, and cycle detection.
- **Real-browser timing enforcement** (TTI, FMP, memory profiling) is deferred to the evidence-hook
  tasks (T021–T025). Until those land, 🔮 rows are design targets tracked by review, not by CI.

Budget thresholds are intentionally generous for Phase 0. Later phases may tighten them and
introduce automated CI enforcement as profiling instrumentation matures.

## Hardening Budgets

Hardening budgets define the maximum tolerable degradation during adverse conditions. These prevent
regressions from going unnoticed between phases.

### State and rendering limits

| Concern                          | Budget                                                                                                                                   | Verification (target)                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Unnecessary rerenders per update | ≤ 3 render cycles per single state change                                                                                                | Browser spec profiling assertions (🔮 T021–T025) |
| Visible DOM node count           | ≤ 2 000 nodes on any primary surface                                                                                                     | Browser spec DOM measurement (🔮 T021–T025)      |
| Daemon replay concurrency        | ≤ 8 concurrent replay fetches per connection                                                                                             | Gateway transport defaults + tests (✅)          |
| Error retry storms               | Capped per subsystem: stream reconnect ≤ 10 attempts (1–30 s backoff), approval hydration ≤ 3 retries; all surface failure on exhaustion | Gateway and browser spec assertions (✅)         |

### Failure-mode guardrails

| Scenario                       | Required behavior                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Daemon unreachable             | Visible degraded banner within 5 s; no silent retry loop                             |
| Session expired                | Redirect to login within 2 s; no stale-state flash                                   |
| Mutation rejected              | Error shown in-place; no false success indication                                    |
| WebSocket dropped              | ≤ 10 reconnect attempts; exponential backoff 1–30 s, then surface disconnected state |
| Gateway startup without assets | Clear unsupported-state message; no blank page                                       |

### Failure-drill matrix (US2)

This matrix details the concrete failure scenarios that User Story 2 ("Safe Recovery During
Failures") requires. Each row names the scenario, the expected operator-visible behavior, current
evidence (code paths and tests that exist today), and gaps that follow-on tasks T012–T016 must
close.

**Legend**: ✅ = covered by existing code and tests today; 🔧 = code path exists but test coverage
or UX polish is incomplete; 🔮 = not yet implemented — future work.

#### FD-1 Session expired during active use

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**           | Session reaches its expiry time or the daemon invalidates it (idle timeout, explicit revocation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Expected behavior** | Operator sees a clear "session expired" indication within 2 s. No stale-state flash, no false success. Protected actions attempted after expiry must not succeed silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Current evidence**  | `useSession` (auth/hooks/use-session.ts) polls `/session/info` on a 60 s cycle and subscribes to WebSocket `SessionEvent` messages. On `expired` or `invalidated` state the hook stops polling. `ExpiryBanner` (auth/components/expiry-banner.tsx) renders an "Extend Session" action when `state === 'expiring-soon'`. Gateway rejects reconnect attempts after expiry with `SESSION_EXPIRED` / `SESSION_INVALIDATED` 401 (transport/ws-server tests, ~1 300 lines). Browser-side `requiresReauth()` (web/src/shared/gateway-errors.ts) classifies these codes. Browser specs cover expiry banner rendering and session-provider wiring. ✅ |
| **Gaps**              | Poll errors during the expiry window are silently swallowed — a network blip can delay expiry detection beyond the 2 s target. No explicit redirect-to-login on expiry today; session context stops polling but the browser surface may remain mounted with stale state. The `extend()` action has no timeout or user-visible feedback if the reauth call hangs. **T012** should tighten the redirect and surface poll-error feedback; **T015/T016** should add gateway and browser drill coverage for the delayed-detection edge case. 🔧                                                                                                   |

#### FD-2 Daemon unreachable (backend down or network partition)

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**           | Hydra daemon process stops, crashes, or becomes unreachable from the gateway.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Expected behavior** | Visible degraded banner within 5 s. No silent retry loop. "Check again" action available. Session remains valid (operator is not logged out).                                                                                                                                                                                                                                                                                                                                                                        |
| **Current evidence**  | `DaemonUnreachable` component (auth/components/daemon-unreachable.tsx) renders when `state === 'daemon-unreachable'` with a "Check again" button that calls `refresh()`. Errors from refresh are caught silently (no redirect to login). `WorkspaceConnectionState.daemonStatus` tracks `'healthy'                                                                                                                                                                                                                   | 'unavailable' | 'recovering'`. Connection banner (chat-workspace/components/connection-banner.tsx) escalates to assertive alert severity for daemon-down state. Gateway broadcasts `daemon-unavailable`and`daemon-restored`events over WebSocket via`session-ws-bridge.ts`. Gateway returns `DAEMON_UNREACHABLE`(503) with optional`retryAfterMs`. Browser specs cover daemon-unreachable banner rendering, retry button behavior, and ARIA semantics. ✅ |
| **Gaps**              | The "Check again" button swallows errors without user feedback — repeated silent failures look identical to the first. No timeout on the refresh call itself. Connection banner does not show how long the daemon has been unavailable or how many retry attempts have occurred. **T012** should add feedback on retry failures; **T014** should tighten the gateway's daemon-unavailable classification to distinguish transient vs. sustained outages; **T015/T016** should cover the sustained-outage UX path. 🔧 |

#### FD-3 WebSocket connection dropped during live updates

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**           | Network interruption, server restart, or load-balancer timeout drops the WebSocket.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Expected behavior** | ≤ 10 reconnect attempts with exponential backoff (1–30 s). During reconnect, operator sees a visible "reconnecting" status. On exhaustion, operator sees a "disconnected" state with manual recovery option. No data loss for in-progress conversations — replay buffer catches up on reconnect.                                                                                                                                                                                                                                                                                                                                                                                     |
| **Current evidence**  | `stream-client.ts` connects to `/ws` and fires `onClose`/`onError`/`onOpen` callbacks. `WorkspaceConnectionState.transportStatus` cycles through `'connecting'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 'live' | 'reconnecting' | 'disconnected'`. Connection banner renders severity-appropriate status for each transport state. Gateway transport implements a replay barrier pattern (ws-message-handler.ts) with sequence tracking (`lastAckSeq`, `lastDeliveredSeq`) and buffer-miss fallback to daemon replay. Backpressure protection (backpressure.ts) closes connections that exceed a 1 MB send buffer with `WS_BUFFER_OVERFLOW`. Browser specs cover banner hierarchy transitions (connecting → live → disconnected), reconnect workflow, and create-reconnect scenarios. Gateway tests (~1 600 lines in ws-message-handler.test.ts) cover replay barrier, buffer miss, and sequence continuity. ✅ |
| **Gaps**              | Reconnect retry configuration (max attempts, backoff range) is not exposed as a tunable. The connection banner already shows the current reconnect attempt count, but it does not surface estimated wait or a stronger manual-recovery affordance after exhaustion. Browser-side reconnect is owned by the workspace stream subscription, not the session-lifecycle WebSocket, so follow-on work should stay with the workspace transport state. **T012** should improve reconnect-progress and exhausted-state messaging; **T014** should expose tunable retry configuration; **T016** should add browser drill specs for the full reconnect → exhaustion → manual recovery arc. 🔧 |

#### FD-4 Protected mutation rejected

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**           | Gateway or daemon rejects a state-changing request (validation failure, stale revision, authorization failure, rate limit, workflow conflict).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Expected behavior** | Error shown in-place on the originating surface. No false success indication. Visible state remains authoritative (pre-mutation value stays). Operator can retry or dismiss.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Current evidence**  | `useMutation` hook (mutations/model/use-mutation.ts) tracks `isLoading` and `error` state. On `MutationsRequestError` it extracts `gatewayError.message`; on unknown errors it sets `"Unexpected error"`. Concurrency guard prevents double-submit. `MutationErrorBanner` (mutations/components/mutation-error-banner.tsx) renders an inline dismissible alert with `role="alert"` and `aria-live="polite"`. Mutations client (mutations/api/mutations-client.ts) throws `MutationsRequestError` with parsed `GatewayErrorBody` including category, code, and message. Gateway error model provides `stale-revision` and `workflow-conflict` categories with structured codes. Browser specs cover the success path, error extraction, concurrency guard, reset, and unknown-error fallback. ✅ |
| **Gaps**              | No automatic retry logic — caller must manually retry. No optimistic concurrency rollback (the UI shows the error but does not explicitly restore the pre-mutation display value from server state). The `"Unexpected error"` fallback for non-`MutationsRequestError` throws loses the original error detail. No timeout on mutation HTTP calls. Error messages are passed through from the server without client-side translation or contextual guidance. **T013** should tighten in-place error rendering and add explicit rollback to authoritative state on rejection; **T015** should add gateway drill coverage for stale-revision and workflow-conflict scenarios; **T016** should add browser specs for the reject → dismiss → retry cycle. 🔧                                         |

#### FD-5 Operations panel render or data error

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Trigger**           | An operations panel component throws during render, or an operations API call returns an error or contract-violating response.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Expected behavior** | Error is contained to the affected panel — chat workspace and other panels remain functional. Operator sees a clear error message in the affected panel with recovery guidance.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Current evidence**  | `OperationsErrorBoundary` (operations-panels/components/operations-error-boundary.tsx) is a React error boundary wrapping operations panels. It catches render-time errors and displays a red alert with `role="alert"`, `aria-live="assertive"`, and `data-testid="operations-panel-error-boundary"`. Operations client (operations-panels/api/operations-client.ts) throws `OperationsRequestError` (HTTP errors) and `OperationsResponseValidationError` (contract mismatch from `safeParse()` failure). Browser specs confirm boundary isolation, fallback rendering, and ARIA semantics. ✅                               |
| **Gaps**              | The error boundary only catches synchronous render errors — async errors from API calls (e.g., `getOperationsSnapshot()` rejection) are not caught by the boundary and may surface as unhandled promise rejections or silently fail to update panel state. No component-level error UI for individual panels below the boundary. No retry mechanism for failed operations data fetches. **T013** should add per-panel async error handling and degraded-state rendering; **T015** should add gateway tests for operations contract violations; **T016** should add browser specs for the async-error → degraded-panel path. 🔧 |

#### FD-6 Gateway starts without bundled web assets (packaged runtime)

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**           | Standalone executable or packaged tarball is launched but the expected `dist/web-runtime/` directory is missing or incomplete.                                                                                                                                                                                                                                                                                                                                                            |
| **Expected behavior** | Clear unsupported-state message served to the browser — no blank page, no cryptic 404. Daemon API remains functional for CLI agents.                                                                                                                                                                                                                                                                                                                                                      |
| **Current evidence**  | `server-runtime.ts` probes for the web runtime directory at startup and sets an availability flag. When assets are unavailable, HTTP requests for web routes receive an explicit unsupported-state response with an explanatory message. `test/packaging.test.ts` asserts that a tarball includes `dist/web-runtime/` and that the bundled gateway starts successfully. README and workspace READMEs document the supported launch paths and expected behavior when assets are absent. ✅ |
| **Gaps**              | Minimal — this scenario is well-covered after the Phase 1 (US1) packaging work. The only remaining gap is that the unsupported-state response is plain text; a styled HTML fallback page could improve the operator experience. This is low priority and not assigned to a specific follow-on task. ✅                                                                                                                                                                                    |

#### FD-7 Rate-limit rejection

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**           | Operator exceeds request rate on login, mutating endpoints, or WebSocket session creation.                                                                                                                                                                                                                                                           |
| **Expected behavior** | Gateway returns `RATE_LIMITED` (429) with optional `retryAfterMs`. Browser surfaces the rejection as an in-place error — no silent retry storm.                                                                                                                                                                                                      |
| **Current evidence**  | Gateway error model defines `RATE_LIMITED` with category `'rate-limit'` and HTTP 429. Browser-side `isRateLimitError()` and `isRetriable()` helpers exist in `web/src/shared/gateway-errors.ts`. `getRetryAfterMs()` extracts the delay hint. The `useMutation` hook and `MutationsRequestError` propagate rate-limit errors to the error banner. ✅ |
| **Gaps**              | No browser-side backoff logic that uses `retryAfterMs` — the retry delay hint is available but no component consumes it for automatic retry scheduling. **T013** should consider surfacing the retry-after hint in the mutation error banner; **T014** should validate that the gateway consistently provides `retryAfterMs` on 429 responses. 🔧    |

#### FD-8 Stale-revision conflict on mutation

| Aspect                | Detail                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**           | Two operator sessions (or tabs) attempt conflicting mutations; the second receives a `stale-revision` rejection.                                                                                                                                                                                                                                                                                                    |
| **Expected behavior** | The losing mutation fails visibly with a conflict message. No silent overwrite. Operator can refresh and retry.                                                                                                                                                                                                                                                                                                     |
| **Current evidence**  | Gateway error model defines the `stale-revision` category and code. Browser-side `isStaleRevision()` helper correctly classifies the error. The `useMutation` error path would surface this as a `MutationsRequestError` with the conflict message. Mutations client includes CSRF token injection for all POST requests. ✅                                                                                        |
| **Gaps**              | No browser-side conflict-resolution UX — the error is surfaced but there is no "refresh and retry" affordance specific to stale-revision. The mutations client does not distinguish stale-revision from other rejection categories in its error rendering. **T013** should add a stale-revision-specific error message and refresh prompt; **T016** should add a browser spec for the two-tab conflict scenario. 🔧 |

#### Drill-matrix summary

| #    | Scenario                              | Current state                                                                   | Primary follow-on tasks |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------- |
| FD-1 | Session expired during active use     | Code path exists; poll-error silence and missing redirect are gaps              | T012, T015, T016        |
| FD-2 | Daemon unreachable                    | Banner and retry exist; retry feedback and sustained-outage UX are gaps         | T012, T014, T015, T016  |
| FD-3 | WebSocket dropped during live updates | Reconnect and replay exist; progress visibility and circuit-breaker are gaps    | T012, T014, T016        |
| FD-4 | Protected mutation rejected           | Hook and error banner exist; retry, rollback, and error translation are gaps    | T013, T015, T016        |
| FD-5 | Operations panel error                | Render boundary exists; async error handling and per-panel degradation are gaps | T013, T015, T016        |
| FD-6 | Gateway starts without assets         | Well-covered after US1                                                          | —                       |
| FD-7 | Rate-limit rejection                  | Error classification exists; retry-after consumption is a gap                   | T013, T014              |
| FD-8 | Stale-revision conflict               | Error classification exists; conflict-resolution UX is a gap                    | T013, T016              |

### Evidence expectations

Hardening budgets are target expectations for Phase 0. Evidence should be collected through the
commands and test layers available today:

1. **Existing test suites** — `npm test` runs all unit, integration, and browser specs. Tests
   should assert failure-mode behaviors (error banners, redirects, retry limits) where feasible.
2. **Quality gate** — `npm run quality` catches lint, format, type, and cycle regressions.
3. **Build verification** — `npm --workspace @hydra/web run build` confirms bundle budgets.
4. **Root package verification** — `npm run package:dry-run` validates the published root CLI
   package shape only. Packaged web runtime verification now comes from `test/packaging.test.ts`,
   which asserts that the tarball includes `dist/web-runtime/` and that the bundled gateway starts
   successfully. Broader packaging/build evidence automation for CI remains future work for T025.

No new tooling is introduced in Phase 0. Quantitative render-count and DOM-node-count enforcement
requires instrumentation that will land with the evidence-hook tasks (T021–T025). Until then, the
state and rendering limits above are design targets verified by review.

## Test and CI Expectations

Current required test layers in this repo:

- contract tests for shared schemas;
- gateway unit and integration tests;
- frontend unit/component/browser-spec tests;
- security-focused tests implemented within those suites;
- release-readiness doc reviews for accessibility and failure-mode coverage until dedicated tooling lands.

Target test layers for later hardening work:

- accessibility-focused browser checks beyond the current browser-spec coverage;
- real end-to-end browser tests once dedicated tooling is introduced.

Current CI gates in this repo:

- formatting;
- strict linting;
- full type-checking;
- unit/integration/component/browser-spec test execution through the existing repo commands;
- cycle or boundary verification;
- dependency audit;
- no backsliding on coverage expectations.

Target CI additions for later hardening work:

- secret scanning;
- explicit accessibility/e2e evidence hooks tied to the Phase 5 target budgets.

Target CI gates (to be added by evidence-hook tasks T021–T025):

- build-size budget checks (Vite output, see Responsiveness Budgets above);
- responsiveness regression assertions in browser specs.
