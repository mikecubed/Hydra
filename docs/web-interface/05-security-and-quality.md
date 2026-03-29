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

### Build and bundle budgets

| Metric                        | Threshold     | Evidence command                                  |
| ----------------------------- | ------------- | ------------------------------------------------- |
| Production build succeeds     | exit 0        | `npm --workspace @hydra/web run build`            |
| JS bundle size (gzipped)      | ≤ 250 KB      | Vite build output — check total gzip column       |
| CSS bundle size (gzipped)     | ≤ 50 KB       | Vite build output — check total gzip column       |
| Build time                    | ≤ 30 s        | Wall-clock time of build command                  |
| Package dry-run succeeds      | exit 0        | `npm run package:dry-run`                         |

### Runtime responsiveness targets

| Surface                       | Metric                          | Target    |
| ----------------------------- | ------------------------------- | --------- |
| Login page                    | Time to interactive (TTI)       | ≤ 2 s     |
| Authenticated workspace       | Time to interactive (TTI)       | ≤ 3 s     |
| Operations panels             | First meaningful paint          | ≤ 2 s     |
| Mutation dialogs              | Open-to-interactive             | ≤ 500 ms  |
| Live update cycle             | Input-to-render latency         | ≤ 200 ms  |
| Repeated refresh (10 cycles)  | No cumulative memory growth     | < 5 % increase over baseline |
| WebSocket reconnect           | Reconnect-to-data-flowing       | ≤ 3 s     |

### Enforcement and evidence

- **Browser specs** (`apps/web/src/features/**/*.browser.spec.tsx`) must include at least one
  timing assertion per surface listed above to prevent regression.
- **Gateway tests** (`npm --workspace @hydra/web-gateway run test`) must pass without timeout
  failures.
- **Quality gate** (`npm run quality`) must pass — this validates linting, formatting, type
  checking, and cycle detection.
- **CI** surfaces any budget violation as a failing check. Build-size budgets are enforced by
  checking Vite build output in CI; runtime budgets are enforced through browser spec assertions.

Budget thresholds are intentionally generous for Phase 0. Later phases may tighten them as
profiling evidence accumulates.

## Hardening Budgets

Hardening budgets define the maximum tolerable degradation during adverse conditions. These prevent
regressions from going unnoticed between phases.

### State and rendering limits

| Concern                           | Budget                                        | Verification                                    |
| --------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| Unnecessary rerenders per update  | ≤ 3 render cycles per single state change     | Browser spec profiling assertions               |
| Visible DOM node count            | ≤ 2 000 nodes on any primary surface          | Browser spec DOM measurement                    |
| Pending request queue             | ≤ 10 concurrent in-flight daemon requests     | Gateway integration test assertions             |
| Error retry storms                | Max 3 automatic retries, then surface failure | Gateway and browser spec assertions             |

### Failure-mode guardrails

| Scenario                       | Required behavior                                          |
| ------------------------------ | ---------------------------------------------------------- |
| Daemon unreachable             | Visible degraded banner within 5 s; no silent retry loop   |
| Session expired                | Redirect to login within 2 s; no stale-state flash         |
| Mutation rejected              | Error shown in-place; no false success indication          |
| WebSocket dropped              | Reconnect attempt within 3 s; exponential backoff capped at 30 s |
| Gateway startup without assets | Clear unsupported-state message; no blank page              |

### Evidence collection

Hardening budgets are verified through:

1. **Existing test suites** — `npm test` runs all unit, integration, and browser specs.
2. **Quality gate** — `npm run quality` catches lint, format, type, and cycle regressions.
3. **Build verification** — `npm --workspace @hydra/web run build` confirms bundle budgets.
4. **Package verification** — `npm run package:dry-run` confirms packaging integrity.

No new tooling is introduced in Phase 0. Evidence relies entirely on existing commands and test
assertions.

## Test and CI Expectations

Required test layers:

- contract tests for shared schemas;
- gateway unit and integration tests;
- frontend unit/component tests;
- end-to-end browser tests;
- security-focused tests;
- accessibility checks.

Required CI gates:

- formatting;
- strict linting;
- full type-checking;
- unit/integration/component/e2e tests;
- cycle or boundary verification;
- dependency and secret scanning;
- no backsliding on coverage expectations;
- build-size budget checks (Vite output, see Responsiveness Budgets above);
- responsiveness regression assertions in browser specs.
