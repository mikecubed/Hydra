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
- no backsliding on coverage expectations.
