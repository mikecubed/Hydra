# Tasks: Web Session & Authentication

**Input**: Design documents from `.sdd/web-session-auth-9mwbx2ru/`
**Prerequisites**: plan.md (loaded), spec.md (loaded), data-model.md (loaded), research.md (loaded)
**Revised**: 2026-03-16 — cookie transport, security hardening, scope narrowing, TDD ordering, quality-gate integration

## Format: `- [ ] T### [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions
- **TDD discipline**: Within each phase, test tasks (🔴 RED) precede implementation tasks (🟢 GREEN). Write the failing test first, then implement to make it pass, then refactor.

---

## Phase 1: Setup & Quality-Gate Integration

**Purpose**: Workspace initialization, package scaffolding, dependency installation, and root quality-gate wiring

- [ ] T001 Create workspace directory structure: `apps/web-gateway/`, `apps/web-gateway/src/`, `packages/web-contracts/`, `packages/web-contracts/src/`
- [ ] T002 Initialize `packages/web-contracts/package.json` with name, version, ESM type, TypeScript, Zod dependency, and `tsconfig.json` (ES2024, NodeNext, strict)
- [ ] T003 Initialize `apps/web-gateway/package.json` with name, version, ESM type, TypeScript, Hono dependency, workspace dependency on `packages/web-contracts`, and `tsconfig.json`
- [ ] T004 Register both packages as npm workspaces in root `package.json`; verify `npm install` succeeds
- [ ] T005 [P] Update root `package.json` scripts so that `npm test` and `npm run quality` (lint + format:check + typecheck) discover and include the new workspace packages. Verify `npm run quality` passes with zero source files.
- [ ] T006 [P] Create gateway module directory skeleton: `apps/web-gateway/src/auth/`, `apps/web-gateway/src/session/`, `apps/web-gateway/src/security/`, `apps/web-gateway/src/audit/`, `apps/web-gateway/src/shared/`
- [ ] T007 [P] Configure ESLint boundary rules for `apps/web-gateway/src/auth/`, `apps/web-gateway/src/session/`, `apps/web-gateway/src/security/` to prevent cross-imports between modules (they share types only via `packages/web-contracts/`)

**Checkpoint**: `npm install` succeeds, `npm run quality` passes, workspace resolution works. SC-013 verified from this point forward.

---

## Phase 2: Foundational — Shared Contracts & Utilities

**Purpose**: Zod schemas, type definitions, and shared gateway utilities that ALL user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### 🔴 RED — Tests first

- [ ] T008 [P] Write tests for SessionState enum and Session schema: valid states accepted, invalid states rejected, SessionInfo roundtrip — `packages/web-contracts/src/__tests__/session-schemas.test.ts`
- [ ] T009 [P] Write tests for LoginRequest, LoginResponse (no sessionId field!), LogoutResponse, AuthError schemas: valid input acceptance, invalid input rejection — `packages/web-contracts/src/__tests__/auth-schemas.test.ts`
- [ ] T010 [P] Write tests for AuditRecord, AuditEventType enum (11 in-scope types) — `packages/web-contracts/src/__tests__/audit-schemas.test.ts`
- [ ] T011 [P] Write tests for Operator and Credential schemas — `packages/web-contracts/src/__tests__/operator-schemas.test.ts`
- [ ] T012 [P] Write tests for clock abstraction: normal operation, fake clock injection, monotonicity violation triggers unreliable state, tolerance boundary — `apps/web-gateway/src/shared/__tests__/clock.test.ts`
- [ ] T013 [P] Write tests for error module: all error codes instantiable, correct structure — `apps/web-gateway/src/shared/__tests__/errors.test.ts`

### 🟢 GREEN — Implementations

- [ ] T014 [P] Define SessionState enum and Session schema in `packages/web-contracts/src/session-schemas.ts` — states: active, expiring-soon, expired, invalidated, logged-out, daemon-unreachable; SessionInfo type with operatorId, state, expiresAt, lastActivityAt, createdAt (no id — it's the cookie, not a JS value)
- [ ] T015 [P] Define SessionEvent schema (type, newState, reason) and ExtendResponse schema in `packages/web-contracts/src/session-schemas.ts`
- [ ] T016 [P] Define LoginRequest, LoginResponse, LogoutResponse, and AuthError schemas in `packages/web-contracts/src/auth-schemas.ts` — LoginResponse has operatorId, expiresAt, state; NO sessionId field (FR-020)
- [ ] T017 [P] Define AuditRecord, AuditEventType enum (11 types from revised data-model.md), AuditQuery (for future use) in `packages/web-contracts/src/audit-schemas.ts`
- [ ] T018 [P] Define Operator and Credential schemas in `packages/web-contracts/src/operator-schemas.ts` — no hashedSecret in contract (server-only)
- [ ] T019 Create public barrel export in `packages/web-contracts/src/index.ts` re-exporting all schemas
- [ ] T020 [P] Implement injectable clock abstraction in `apps/web-gateway/src/shared/clock.ts` — default uses Date.now(), supports fake clock injection, includes monotonicity check with configurable tolerance (default 30s)
- [ ] T021 [P] Implement typed error module in `apps/web-gateway/src/shared/errors.ts` — error codes for auth failures (INVALID_CREDENTIALS, RATE_LIMITED, ACCOUNT_DISABLED), session failures (SESSION_EXPIRED, SESSION_INVALIDATED, SESSION_NOT_FOUND, IDLE_TIMEOUT), and system failures (DAEMON_UNREACHABLE, CLOCK_UNRELIABLE, CSRF_INVALID, ORIGIN_REJECTED)

**Checkpoint**: `npm run quality` passes. All schema and utility tests pass. Contracts importable from gateway via workspace dependency.

---

## Phase 3: User Story 1 — Operator Authenticates (P1 MVP) 🎯

**Goal**: Operators log in with credentials, receive an HttpOnly session cookie, and are blocked from all workspace routes without a valid cookie. Invalid credentials produce clear rejections. Rate limiting prevents brute-force.

**Covers**: FR-001, FR-002, FR-003, FR-004, FR-020, SC-001, SC-002, SC-007, SC-009

### 🔴 RED — Tests first

- [ ] T022 Write tests for credential hashing: round-trip hash+verify succeeds, wrong secret fails, different salts produce different hashes, constant-time comparison — `apps/web-gateway/src/auth/__tests__/credential-utils.test.ts`
- [ ] T023 [P] Write tests for operator store: create operator, add credential, lookup by identity, disable operator, file persistence round-trip — `apps/web-gateway/src/auth/__tests__/operator-store.test.ts`
- [ ] T024 [P] Write tests for rate limiter: under-threshold allows, at-threshold blocks, lockout expires, window slides, clock injection — `apps/web-gateway/src/auth/__tests__/rate-limiter.test.ts`
- [ ] T025 [P] Write tests for session store: create returns valid session, get by ID, get unknown ID returns undefined, delete removes session, list by operator, snapshot write+reload — `apps/web-gateway/src/session/__tests__/session-store.test.ts`
- [ ] T026 Write tests for session service: create succeeds with valid operator, validate active session, validate expired session, validate invalidated session, concurrent session limit enforced — `apps/web-gateway/src/session/__tests__/session-service.test.ts`
- [ ] T027 Write tests for auth service: valid login returns LoginResponse (no sessionId in body), invalid identity returns generic error, invalid secret returns same generic error, disabled operator rejected, rate-limited source rejected — `apps/web-gateway/src/auth/__tests__/auth-service.test.ts`
- [ ] T028 Write tests for auth middleware: request without session cookie returns 401, request with valid cookie passes through, request with expired session returns 401, request with invalidated session returns 401 — `apps/web-gateway/src/auth/__tests__/auth-middleware.test.ts`
- [ ] T029 Write tests for auth routes: login returns 200 + Set-Cookie (HttpOnly, SameSite=Strict) + Set-Cookie (**csrf, non-HttpOnly), login with bad creds returns 401 + AuthError (no Set-Cookie), rate-limited returns 429, logout clears cookies — `apps/web-gateway/src/auth/**tests\_\_/auth-routes.test.ts`

### 🟢 GREEN — Implementations

- [ ] T030 Implement credential hashing utilities in `apps/web-gateway/src/auth/credential-utils.ts` — node:crypto, per-credential salt, constant-time comparison
- [ ] T031 [P] Implement operator store in `apps/web-gateway/src/auth/operator-store.ts` — in-memory Map + JSON file; CRUD for operators and credentials
- [ ] T032 [P] Implement rate limiter in `apps/web-gateway/src/auth/rate-limiter.ts` — sliding-window counter per source key; configurable threshold (default: 5/60s), lockout (default: 5 min); uses injected clock
- [ ] T033 [P] Implement session store in `apps/web-gateway/src/session/session-store.ts` — in-memory Map; cryptographically random ID via node:crypto; periodic file snapshot
- [ ] T034 Implement session service (create, validate) in `apps/web-gateway/src/session/session-service.ts` — create sets state=active and expiresAt; generates csrfToken; validate checks cookie-derived ID, non-terminal state, not expired; enforces concurrent session limit (FR-017)
- [ ] T035 Implement auth service in `apps/web-gateway/src/auth/auth-service.ts` — authenticate(identity, secret, sourceKey): checks rate limit, looks up operator, verifies credential, creates session via session-service, returns LoginResponse + session cookie + csrf cookie; error messages never reveal which field failed (FR-002)
- [ ] T036 Implement auth middleware in `apps/web-gateway/src/auth/auth-middleware.ts` — reads `__session` HttpOnly cookie, validates via session-service, rejects if missing/invalid, attaches operator context on success
- [ ] T037 Implement auth routes in `apps/web-gateway/src/auth/auth-routes.ts` — POST /login sets `__session` cookie (HttpOnly; SameSite=Strict; Secure if TLS) + `__csrf` cookie (non-HttpOnly); POST /logout clears both cookies; both validate Zod request/response schemas

**Checkpoint**: Full auth flow end-to-end. Session cookie is HttpOnly (SC-009). No sessionId in response body (FR-020). `npm run quality` passes. `npm test` passes.

---

## Phase 4: Browser-Safety Hardening

**Goal**: CSRF protection, origin validation, hardened headers, TLS posture, and mutating-route rate limits. These run before any workspace routes.

**Covers**: FR-021, FR-022, FR-023, FR-024, FR-025, SC-010, SC-011, SC-012

### 🔴 RED — Tests first

- [ ] T038 Write tests for CSRF middleware: mutating request with valid X-CSRF-Token header passes, mutating request without header returns 403, mutating request with wrong token returns 403, GET/HEAD/OPTIONS bypass CSRF check — `apps/web-gateway/src/security/__tests__/csrf-middleware.test.ts`
- [ ] T039 [P] Write tests for origin guard: request with matching Origin passes, request with mismatched Origin returns 403, request with missing Origin on mutating route returns 403, WebSocket upgrade with wrong Origin returns 403 — `apps/web-gateway/src/security/__tests__/origin-guard.test.ts`
- [ ] T040 [P] Write tests for hardened headers: every response includes CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy; HSTS present only when TLS active — `apps/web-gateway/src/security/__tests__/hardened-headers.test.ts`
- [ ] T041 [P] Write tests for TLS guard: loopback bind without TLS allowed, non-loopback bind without TLS config refuses to start, non-loopback with TLS starts normally, Secure cookie flag conditional on TLS — `apps/web-gateway/src/security/__tests__/tls-guard.test.ts`
- [ ] T042 [P] Write tests for mutating rate limiter: under-threshold passes, at-threshold returns 429, WS session creation counted, window slides, separate from login rate limiter — `apps/web-gateway/src/security/__tests__/mutating-rate-limiter.test.ts`

### 🟢 GREEN — Implementations

- [ ] T043 Implement CSRF middleware in `apps/web-gateway/src/security/csrf-middleware.ts` — double-submit: reads `__csrf` cookie, compares to `X-CSRF-Token` header on POST/PUT/PATCH/DELETE; rejects mismatches with CSRF_INVALID error
- [ ] T044 [P] Implement origin guard in `apps/web-gateway/src/security/origin-guard.ts` — validates Origin header matches gateway's own origin on mutating routes and WebSocket upgrade; rejects with ORIGIN_REJECTED error
- [ ] T045 [P] Implement hardened headers middleware in `apps/web-gateway/src/security/hardened-headers.ts` — sets CSP (default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; frame-ancestors 'none'), X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy: strict-origin-when-cross-origin, HSTS (conditional on TLS)
- [ ] T046 [P] Implement TLS guard in `apps/web-gateway/src/security/tls-guard.ts` — startup check: non-loopback bind requires cert+key config; refuse to start with clear error otherwise; exports isSecure() for cookie Secure flag
- [ ] T047 [P] Implement mutating rate limiter in `apps/web-gateway/src/security/mutating-rate-limiter.ts` — sliding-window per source on mutating endpoints and WS creation; configurable threshold; uses injected clock

**Checkpoint**: All security hardening tests pass. SC-010 (CSRF), SC-011 (origin), SC-012 (TLS) verified. `npm run quality` passes.

---

## Phase 5: User Story 2 — Operator Understands Session State (P1)

**Goal**: Session state is always accurate and communicated promptly. Expiry warnings, daemon-unreachable, fail-closed on clock drift.

**Covers**: FR-005, FR-006, FR-010, FR-015, FR-018, SC-003

### 🔴 RED — Tests first

- [ ] T048 Write exhaustive tests for session state machine: every valid transition succeeds, every invalid transition returns error, terminal states truly terminal, all 6 states reachable — `apps/web-gateway/src/session/__tests__/session-state-machine.test.ts`
- [ ] T049 Write tests for integrated state machine: create session is active, transitions to expiring-soon at threshold, transitions to expired past expiresAt, fail-closed when clock unreliable (FR-018) — `apps/web-gateway/src/session/__tests__/session-service-states.test.ts`
- [ ] T050 Write tests for daemon heartbeat: healthy daemon keeps sessions active, unhealthy transitions to daemon-unreachable, recovery restores active, expired-during-outage stays expired — `apps/web-gateway/src/session/__tests__/daemon-heartbeat.test.ts`
- [ ] T051 Write tests for session info endpoint: active returns active, expiring-soon returns with expiresAt, expired returns 401 with explicit message, daemon-unreachable distinct from session errors — `apps/web-gateway/src/session/__tests__/session-routes.test.ts`

### 🟢 GREEN — Implementations

- [ ] T052 Implement session state machine in `apps/web-gateway/src/session/session-state-machine.ts` — pure function: (current state + trigger) → new state or error; 12 transitions; terminal states reject all
- [ ] T053 Integrate state machine into session-service: all state changes go through FSM; add expiry-check method; add expire and invalidate methods
- [ ] T054 Implement daemon heartbeat monitor in `apps/web-gateway/src/session/daemon-heartbeat.ts` — periodic health check (default 10s); transitions active→daemon-unreachable on failure; restores on recovery
- [ ] T055 Implement session info + extension routes in `apps/web-gateway/src/session/session-routes.ts` — GET session info (runs expiry check before responding); POST extend (validates CSRF token)

**Checkpoint**: Session state always accurate. SC-003 (5-second propagation) verified. FR-018 (fail-closed) verified. `npm run quality` passes.

---

## Phase 6: User Story 3 — Operator Manages Session Lifecycle (P2)

**Goal**: Logout, extend, and re-authenticate. Terminated sessions cannot be reused. Cross-tab propagation. Idle timeout gate.

**Covers**: FR-007, FR-008, FR-009, FR-012, FR-016, FR-017, SC-005

### 🔴 RED — Tests first

- [ ] T056 Write tests for session extension: extend active succeeds, extend expiring-soon returns to active, max count rejected, extend expired rejected, extend invalidated rejected — `apps/web-gateway/src/session/__tests__/session-extension.test.ts`
- [ ] T057 [P] Write tests for session invalidation: invalidate single session, invalidateAll for operator, invalidated sessions rejected on validate — `apps/web-gateway/src/session/__tests__/session-invalidation.test.ts`
- [ ] T058 [P] Write tests for session state broadcaster: register connection, state change notifies all, logout notifies all tabs, failed callback removed — `apps/web-gateway/src/session/__tests__/session-state-broadcaster.test.ts`
- [ ] T059 [P] Write tests for idle timeout: active session not idle passes, session at boundary passes, session past threshold triggers re-auth requirement, **re-auth with valid credentials clears idle lock on same session (no new session created, session cookie unchanged), idle timer resets after successful re-auth** — `apps/web-gateway/src/session/__tests__/idle-timeout.test.ts`
- [ ] T060 Write tests for lifecycle routes: extend returns new expiresAt, extend at limit returns 403, logout clears cookie, old cookie rejected, idle session returns 401 with IDLE_TIMEOUT code, **POST /auth/reauth with valid idle session + correct credentials returns 200 + SessionInfo (same session, cookie unchanged), POST /auth/reauth with wrong credentials returns 401 and session remains idle-locked** — `apps/web-gateway/src/session/__tests__/session-lifecycle-routes.test.ts`

### 🟢 GREEN — Implementations

- [ ] T061 Implement session extension in session-service: transitions via FSM, resets expiresAt, increments extendedCount, rejects at max
- [ ] T062 [P] Implement session invalidation in session-service: invalidate(sessionId, reason) and invalidateAllForOperator(operatorId, reason) — transitions via FSM
- [ ] T063 [P] Implement session state broadcaster in `apps/web-gateway/src/session/session-state-broadcaster.ts` — sessionId→Set<callback> registry; notifies on state change; cleans failed callbacks
- [ ] T064 [P] Implement idle timeout check in session-middleware — if lastActivityAt + idleThreshold < now, reject with IDLE_TIMEOUT and require re-auth (FR-012); update lastActivityAt on valid requests. **Same-session resume path**: add POST `/auth/reauth` route in `apps/web-gateway/src/auth/auth-routes.ts` — requires a valid-but-idle session cookie; verifies credentials against the session's operator; on success resets `lastActivityAt` and returns `SessionInfo`; does NOT create a new session or change the session cookie (US-4 scenario 3)
- [ ] T065 Add session extension route (POST, requires CSRF), update logout route to clear cookies and broadcast state change

**Checkpoint**: Full lifecycle works. SC-005 (zero replay) verified. FR-012 (idle re-auth) verified. FR-016 (cross-tab) verified. `npm run quality` passes.

---

## Phase 7: User Story 5 — Auth and Session Events Are Recorded (P2)

**Goal**: Every auth/session event produces an immutable audit record. Write side only — query UX deferred.

**Covers**: FR-013, SC-004

### 🔴 RED — Tests first

- [ ] T066 Write tests for audit store: append creates record, records immutable (no update/delete), retention pruning — `apps/web-gateway/src/audit/__tests__/audit-store.test.ts`
- [ ] T067 Write tests for audit service: record creates valid AuditRecord, all 11 in-scope event types accepted, invalid type rejected, timestamp uses injected clock — `apps/web-gateway/src/audit/__tests__/audit-service.test.ts`
- [ ] T068 Write integration tests for audit completeness: login → extend → idle-timeout → re-auth → logout, verify all expected events recorded with correct types and timestamps — `apps/web-gateway/src/audit/__tests__/audit-integration.test.ts`

### 🟢 GREEN — Implementations

- [ ] T069 Implement audit store in `apps/web-gateway/src/audit/audit-store.ts` — append-only file log; write(AuditRecord); configurable retention (default 90 days)
- [ ] T070 Implement audit service in `apps/web-gateway/src/audit/audit-service.ts` — record(eventType, operatorId?, sessionId?, detail, outcome); validates against AuditEventType enum; delegates to store
- [ ] T071 Integrate audit recording into auth-service: emit auth.attempt.success, auth.attempt.failure, auth.rate-limited
- [ ] T072 Integrate audit recording into session-service: emit session.created, session.extended, session.expired, session.invalidated, session.logged-out, session.daemon-unreachable, session.daemon-restored, session.idle-reauth

**Checkpoint**: SC-004 (zero audit gaps) verified. Audit trail is append-only. `npm run quality` passes.

---

## Phase 8: User Story 6 — Security Model Supports Future Extensibility (P3)

**Goal**: Verify structural independence of auth, session, and security modules. Adding to one does not require changes to others.

**Covers**: FR-019, SC-008

- [ ] T073 Write architectural boundary test: `auth/` imports nothing from `session/` or `security/` except through `packages/web-contracts/` — `apps/web-gateway/src/__tests__/boundary-auth.test.ts`
- [ ] T074 [P] Write architectural boundary test: `session/` imports nothing from `auth/` or `security/` except through `packages/web-contracts/` — `apps/web-gateway/src/__tests__/boundary-session.test.ts`
- [ ] T075 [P] Write architectural boundary test: `security/` imports nothing from `auth/` or `session/` — `apps/web-gateway/src/__tests__/boundary-security.test.ts`
- [ ] T076 [P] Write extensibility smoke test: stub second credential type handled by auth module without session/security changes — `apps/web-gateway/src/__tests__/extensibility-auth-method.test.ts`
- [ ] T077 [P] Write extensibility smoke test: verify that adding a stub second credential type in `auth/` requires zero changes to `session/` or `security/`; verify that `packages/web-contracts/` can define an authorization-related schema without requiring changes to auth or session modules — `apps/web-gateway/src/__tests__/extensibility-concerns.test.ts`

**Checkpoint**: SC-008 verified. ESLint boundary rules enforce at lint time. `npm run quality` passes.

---

## Phase 9: Integration & End-to-End

**Purpose**: Full-flow integration tests exercising auth → session → security → audit pipeline

- [ ] T078 E2E: unauthenticated request → 401 → login → HttpOnly cookie set → workspace access → extend → access continues → logout → cookie cleared → old cookie rejected → re-login works — `apps/web-gateway/src/__tests__/e2e-auth-lifecycle.test.ts`
- [ ] T079 [P] E2E: login → idle past timeout → attempt action → 401 IDLE_TIMEOUT → POST /auth/reauth with valid credentials → **same session resumes (session cookie unchanged, no new session created)** → action succeeds — `apps/web-gateway/src/__tests__/e2e-idle-reauth.test.ts`
- [ ] T080 [P] E2E: mutating request without CSRF token → 403 → add X-CSRF-Token header → succeeds; cross-origin request → 403 — `apps/web-gateway/src/__tests__/e2e-csrf-origin.test.ts`
- [ ] T081 [P] E2E: 6 rapid bad logins → rate limited → lockout expires → login succeeds — `apps/web-gateway/src/__tests__/e2e-rate-limiting.test.ts`
- [ ] T082 [P] E2E: login → daemon down → daemon-unreachable shown → daemon up → active restored → all events in audit — `apps/web-gateway/src/__tests__/e2e-daemon-health.test.ts`
- [ ] T083 [P] E2E: login → session expires → 401 explicit expired message → re-login → audit trail chronologically correct — `apps/web-gateway/src/__tests__/e2e-session-expiry.test.ts`
- [ ] T084 E2E: verify every response includes CSP, X-Content-Type-Options, X-Frame-Options headers — `apps/web-gateway/src/__tests__/e2e-hardened-headers.test.ts`

**Checkpoint**: All success criteria (SC-001 through SC-013) verified. `npm run quality` and `npm test` pass.

---

## Phase 10: Polish

**Purpose**: Configuration, documentation, and final quality sweep

- [ ] T085 [P] Create gateway configuration schema with all thresholds (session lifetime, warning threshold, max extensions, idle timeout, rate-limit threshold, lockout duration, max concurrent sessions, audit retention, heartbeat interval, clock drift tolerance, TLS cert/key paths, **bind address (default: 127.0.0.1 — loopback-only; LAN access opt-in)**, gateway origin) — `apps/web-gateway/src/config.ts`
- [ ] T086 [P] Write tests for configuration: default values, overrides, invalid values rejected — `apps/web-gateway/src/__tests__/config.test.ts`
- [ ] T087 [P] Write README for `packages/web-contracts/` documenting all exported schemas
- [ ] T088 [P] Write README for `apps/web-gateway/` documenting module structure, configuration, and how to run/test
- [ ] T089 Run full `npm run quality` across all workspaces; fix any issues
- [ ] T090 Run full `npm test` across all workspaces; verify zero failures

**Checkpoint**: All packages type-check, lint clean, tests pass, documentation complete. Feature ready for review.

---

## Dependencies & Execution Order

```text
Phase 1 (Setup + Quality Gates)
  │
  ▼
Phase 2 (Foundational: Schemas + Utilities)
  │
  ▼
Phase 3 (US1: Authentication — P1 MVP) ──► Phase 4 (Security Hardening)
  │                                          │
  ├──────────────────────────────────────────┤
  ▼                                          ▼
Phase 5 (US2: Session State — P1)
  │
  ├──────────────────────┐
  ▼                      ▼
Phase 6 (US3:          Phase 7 (US5:
 Lifecycle — P2)        Audit — P2)
  │                      │
  └──────────┬───────────┘
             ▼
      Phase 8 (US6: Extensibility — P3)
             │
             ▼
      Phase 9 (Integration & E2E)
             │
             ▼
      Phase 10 (Polish)
```

### Key Dependencies

- **Phase 1 → Phase 2**: Packages must exist before schemas can be written
- **Phase 2 → Phases 3+**: All modules depend on shared contracts and utilities
- **Phase 3 → Phase 4**: Security hardening builds on auth middleware and session cookie model
- **Phase 3+4 → Phase 5**: Session state visibility requires auth and security foundations
- **Phase 5 → Phases 6, 7**: Lifecycle management and audit extend the session state machine
- **Phases 6, 7 → Phase 8**: Boundary tests verify separation from earlier phases
- **Phases 6–8 → Phase 9**: E2E tests exercise the complete pipeline

### Quality-Gate Invariant

**SC-013**: `npm run quality` and `npm test` MUST pass at every phase checkpoint. This is verified in Phase 1 and maintained throughout. Agents must run these commands before marking a phase complete.

### TDD Discipline

Every implementation phase follows **Red → Green → Refactor**:

1. 🔴 Write failing tests that encode the requirement
2. 🟢 Write the minimum implementation to pass the tests
3. 🔄 Refactor for clarity without changing behavior

Test tasks always precede implementation tasks within a phase. An agent must not begin a GREEN task until the corresponding RED tasks compile (with expected failures).

### Parallel Execution Opportunities

Within **Phase 2**, schema test/impl pairs (T008–T018) can run in parallel across contracts.
Within **Phase 3**, credential-utils (T022/T030), operator-store (T023/T031), rate-limiter (T024/T032), and session-store (T025/T033) are independent pairs.
Within **Phase 4**, all five security modules (T038–T047) are independent.
**Phases 6 and 7** can begin in parallel once Phase 5 is complete.
Within **Phase 9**, E2E tests T079–T084 can run in parallel.

---

## Summary

| Metric                                     | Count                                                 |
| ------------------------------------------ | ----------------------------------------------------- |
| **Total tasks**                            | 90                                                    |
| **Phase 1 — Setup + Quality Gates**        | 7                                                     |
| **Phase 2 — Foundational**                 | 14                                                    |
| **Phase 3 — US1: Authentication (P1 MVP)** | 16                                                    |
| **Phase 4 — Security Hardening**           | 10                                                    |
| **Phase 5 — US2: Session State (P1)**      | 8                                                     |
| **Phase 6 — US3: Lifecycle (P2)**          | 10                                                    |
| **Phase 7 — US5: Audit (P2)**              | 7                                                     |
| **Phase 8 — US6: Extensibility (P3)**      | 5                                                     |
| **Phase 9 — Integration & E2E**            | 7                                                     |
| **Phase 10 — Polish**                      | 6                                                     |
| **Test tasks**                             | ~50 (56% — every implementation has a preceding test) |

### Removed from Original Draft

- **Phase 6 (old US4: Dangerous Actions)** — full dangerous-action catalog, challenge/confirm flow, authorization middleware. Deferred to Phase 4 slice (`web-controlled-mutations`). Only idle-timeout gate remains (now in Phase 6 / US3).
- **Phase 7 (old US5: Audit Query)** — audit routes and filterable query UX. Deferred to Phase 4 slice. Only audit recording (write side) remains.
- **Authorization module directory** — replaced by `security/` module for browser-safety hardening. Full `authorization/` module returns in Phase 4 slice.

### Suggested MVP Scope

**Phases 1–4 (47 tasks)** deliver a secure, hardened authentication system:

- Workspace scaffolding with quality-gate integration from day one
- Complete auth flow with HttpOnly cookie transport
- CSRF, origin validation, CSP, TLS enforcement, mutating rate limits
- SC-001, SC-007, SC-009, SC-010, SC-011, SC-012, SC-013 verified

This is independently deployable, testable, and secure.
