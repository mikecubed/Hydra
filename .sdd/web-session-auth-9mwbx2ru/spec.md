# Feature Specification: Web Session & Authentication

**Created**: 2026-03-15
**Status**: Draft (revised 2026-03-16)
**Input**: Secure browser authentication and session management for the Hydra web REPL — covering login, session lifecycle, browser-safety hardening, and auditability in a local/trusted-environment deployment model.

> **Scope note — Phase 1 slice.** This spec covers the auth/session primitives
> required by Phase 1 ("Secure Session and Conversation Transport") per
> `docs/web-interface/06-phases-and-sdd.md`. Dangerous-action catalogs, audit-log
> review UX, and admin session management are Phase 4 concerns and intentionally
> excluded. The interfaces here are designed for later extension by those slices.

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Operator Authenticates to the Web Interface (Priority: P1)

An operator navigates to the Hydra web interface and is required to prove their identity before gaining access. The system never presents workspace controls or sensitive information until the operator has successfully authenticated. Authentication failure produces a clear, unambiguous rejection — never a degraded or partial view.

**Why this priority**: Without authentication gating every entry point, no other session or access-control behaviour is meaningful. This is the foundational security boundary.

**Independent Test**: Deploy the web interface, attempt to reach the workspace without authenticating, and verify that no workspace content or control surface is exposed. Then authenticate with valid credentials and confirm full access is granted.

**Acceptance Scenarios**:

1. **Given** an unauthenticated browser request to any workspace route, **When** the request arrives, **Then** the system redirects or blocks access and presents only the authentication prompt — no workspace content is leaked.
2. **Given** an operator at the authentication prompt with valid credentials, **When** the operator submits credentials, **Then** the system establishes an authenticated session and presents the full workspace.
3. **Given** an operator at the authentication prompt with invalid credentials, **When** the operator submits credentials, **Then** the system rejects the attempt with a clear error message and does not reveal which part of the credentials was wrong.
4. **Given** an operator who has failed authentication multiple times in rapid succession, **When** the next attempt is made, **Then** the system applies a rate-limiting or lockout policy and communicates the restriction clearly.

---

### User Story 2 — Operator Understands Session State at All Times (Priority: P1)

Once authenticated, the operator always has unambiguous visibility into the current state of their session. The interface makes it obvious whether the session is active, about to expire, expired, invalidated, or disconnected from the Hydra daemon. The operator is never left guessing why commands fail or the interface becomes unresponsive.

**Why this priority**: Silent session failures are the most common source of operator confusion and data loss. Clear state visibility is a core usability and safety requirement, co-equal with authentication.

**Independent Test**: Establish a session, then simulate each state transition (approaching expiry, expiry, daemon disconnect, revocation) and verify the interface communicates each state distinctly and promptly.

**Acceptance Scenarios**:

1. **Given** an active authenticated session, **When** the operator views the interface, **Then** a session status indicator shows the session is active and healthy.
2. **Given** an active session approaching its expiry window, **When** the remaining time drops below a configurable warning threshold, **Then** the system alerts the operator with enough lead time to take action (extend or save work).
3. **Given** a session that has expired, **When** the operator attempts any workspace action, **Then** the system blocks the action, displays an explicit "session expired" notification, and offers a path to re-authenticate.
4. **Given** a session that has been invalidated by a system policy (e.g., daemon restart, concurrent-session limit exceeded), **When** the operator next interacts with the interface, **Then** the system communicates that the session is no longer valid and requires re-authentication. _(Admin-initiated revocation and revocation-reason display are deferred to the admin-session-management slice.)_
5. **Given** an active session when the Hydra daemon becomes unreachable, **When** the operator attempts a workspace action, **Then** the system distinguishes "daemon unavailable" from "session invalid" and communicates the distinction clearly.

---

### User Story 3 — Operator Manages Session Lifecycle (Priority: P2)

An authenticated operator can explicitly control their session: log out voluntarily, extend a session before expiry (if permitted by policy), and re-authenticate after session loss without losing orientation in the interface. The system supports clean teardown so that no stale session lingers.

**Why this priority**: Explicit lifecycle control prevents credential leakage on shared machines and ensures operators are not forced to restart workflows after routine session events.

**Independent Test**: Authenticate, perform a voluntary logout, confirm the session is fully terminated. Then re-authenticate and verify access is restored. Separately, test session extension and confirm the expiry window resets.

**Acceptance Scenarios**:

1. **Given** an authenticated operator, **When** the operator initiates logout, **Then** the session is fully terminated on both the client and server side, and the operator is returned to the authentication prompt.
2. **Given** an active session within the extension-eligible window, **When** the operator requests a session extension, **Then** the session expiry resets and the operator is notified of the new expiry time.
3. **Given** an expired or invalidated session, **When** the operator re-authenticates, **Then** a new session is established and the operator can resume work without needing to manually navigate back to their previous context (best-effort context restoration).
4. **Given** a session that was terminated (logout, expiry, or revocation), **When** any subsequent request arrives bearing the old session identity, **Then** the system rejects it — the terminated session cannot be reused or replayed.

---

### User Story 4 — Idle Sessions Require Re-Authentication (Priority: P2)

An already-authenticated session that has been idle beyond a configurable threshold requires re-authentication before permitting any further workspace action. This prevents unattended browser sessions from being exploited.

**Why this priority**: Defence-in-depth requires that a stale, unattended session cannot silently continue operating. This is a session primitive, not dependent on a dangerous-action catalog.

> **Scope note.** The full dangerous-action catalog, per-action authorization challenges, and
> confirmation/re-auth workflows are Phase 4 concerns (`web-controlled-mutations` slice). This
> story covers only the idle-timeout gate that applies uniformly to all workspace actions. The
> authorization service interface is designed so the Phase 4 slice can extend it with action-specific
> policies without modifying session or auth modules.

**Independent Test**: Authenticate, allow the session to remain idle past the threshold, then attempt any workspace action. Verify re-authentication is demanded.

**Acceptance Scenarios**:

1. **Given** an authenticated session that has been idle for longer than the configurable idle timeout (default: 30 minutes), **When** the operator attempts any workspace action, **Then** the system requires re-authentication before proceeding.
2. **Given** an authenticated session with recent activity within the idle threshold, **When** the operator performs a workspace action, **Then** the action proceeds without additional authentication.
3. **Given** an idle session that triggers re-authentication, **When** the operator successfully re-authenticates, **Then** the existing session resumes (no new session is created) and the idle timer resets.

---

### User Story 5 — Auth and Session Events Are Recorded (Priority: P2)

All security-relevant session events — authentication attempts (success and failure), session creation, extension, expiry, invalidation, and logout — are recorded in an append-only audit trail. The recording mechanism is always-on and does not require operator action.

**Why this priority**: Auditability is a stated primary goal. Without event recording, incident investigation is impossible. This story delivers the write side; the query/review UX is deferred to the admin-and-audit slice.

> **Scope note.** Audit _recording_ is in scope. Audit _query routes_ and
> _filterable review UX_ (FR-014 in the original draft) are deferred to Phase 4
> (`web-controlled-mutations` slice). The audit store interface is designed so
> that a query layer can be added later without changing the recording path.

**Independent Test**: Perform a sequence of session lifecycle operations (login, failed login, logout, session expiry), then inspect the audit log file and confirm every event is recorded with sufficient detail (who, what, when, outcome).

**Acceptance Scenarios**:

1. **Given** any authentication attempt (success or failure), **When** the attempt completes, **Then** an audit record is created containing the identity (or attempted identity), timestamp, and outcome.
2. **Given** any session lifecycle event (creation, extension, expiry, invalidation, logout), **When** the event occurs, **Then** an audit record is created containing the session identifier, event type, timestamp, and triggering actor.
3. **Given** the audit store, **When** records are written, **Then** they are append-only — no update or deletion is permitted.
4. **Given** a rate-limiting or idle-timeout enforcement event, **When** the event occurs, **Then** an audit record is created capturing the enforcement action and source.

---

### User Story 6 — Security Model Supports Future Extensibility (Priority: P3)

The session and authentication model is designed so that future features — such as multi-user conversations, workflow automation, or remote access — can be built on top of the existing security boundary without requiring a fundamental rework. The model cleanly separates authentication (who you are), session management (lifecycle of your connection), and authorization (what you can do).

**Why this priority**: Avoiding rework is an explicit goal stated in the feature context. A poorly separated model now creates compounding cost later. However, this is lower priority because it constrains design rather than delivering direct operator value today.

**Independent Test**: Review the specification and confirm that authentication, session, and authorization are specified as distinct concerns with clear boundaries. Verify that adding a new authorization rule, a new session type, or a second authentication method does not require modifying the specification of the other concerns.

**Acceptance Scenarios**:

1. **Given** the current specification, **When** a requirement is added for a second authentication method (e.g., a new credential type), **Then** the session management and authorization requirements remain unchanged.
2. **Given** the current specification, **When** a requirement is added for a new authorization policy (e.g., a new category of dangerous action), **Then** the authentication and session management requirements remain unchanged.
3. **Given** the current specification, **When** a requirement is added for a new session capability (e.g., session sharing or handoff), **Then** the authentication and authorization requirements remain unchanged.

---

### Edge Cases

- What happens when the operator's browser is closed mid-session without logout? The session must still expire according to its normal policy; it must not persist indefinitely.
- What happens when the Hydra daemon restarts while sessions are active? Active sessions must be invalidated or re-validated; the system must not silently resume a stale session against a fresh daemon.
- What happens when multiple browser tabs or windows are open under the same session? Actions in one tab that affect session state (logout, expiry) must be reflected in all tabs promptly.
- What happens when system time is unreliable or skewed? Session expiry logic must be resilient to reasonable clock drift; the system should fail closed (expire the session) rather than fail open if time integrity is uncertain.
- What happens when an operator attempts to authenticate while already holding an active session? The system must define a clear policy — either replace the existing session, reject the new attempt, or allow concurrent sessions with auditable tracking.
- What happens when a request arrives without a session cookie, or with a tampered cookie? The system must reject the request and present only the authentication prompt — no partial access.
- What happens when a cross-origin request targets a state-changing route? The system must reject requests whose Origin header does not match the gateway's own origin.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST require authentication before granting access to any workspace content or control surface.
- **FR-002**: The system MUST reject invalid credentials without revealing which component (identity or secret) was incorrect.
- **FR-003**: The system MUST enforce rate-limiting or temporary lockout after repeated authentication failures from the same source.
- **FR-004**: The system MUST establish a bounded-lifetime session upon successful authentication.
- **FR-005**: The system MUST provide continuous, unambiguous session-state indication to the operator (active, expiring soon, expired, invalidated, daemon unreachable).
- **FR-006**: The system MUST alert the operator before session expiry with sufficient lead time to take action.
- **FR-007**: The system MUST support explicit operator-initiated logout that fully terminates the session on both client and server.
- **FR-008**: The system MUST support operator-initiated session extension within a policy-defined window.
- **FR-009**: The system MUST invalidate terminated sessions so they cannot be reused or replayed.
- **FR-010**: The system MUST distinguish between "session invalid" and "daemon unavailable" in its error reporting to the operator.
- **FR-011**: _(Deferred to Phase 4 — `web-controlled-mutations` slice.)_ The authorization service interface MUST be designed so that per-action dangerous-action policies can be added without modifying the auth or session modules.
- **FR-012**: The system MUST require re-authentication after a configurable idle timeout.
- **FR-013**: The system MUST record all security-relevant auth and session events in an append-only audit trail (authentication attempts, session lifecycle events, rate-limit enforcements, idle-timeout enforcements).
- **FR-014**: _(Deferred to Phase 4.)_ The audit store interface MUST be designed so a query/review layer can be added later without changing the recording path.
- **FR-015**: The system MUST invalidate or re-validate active sessions when the Hydra daemon restarts.
- **FR-016**: The system MUST propagate session-state changes (logout, expiry) to all active client connections for that session promptly.
- **FR-017**: The system MUST define and enforce a policy for concurrent sessions by the same operator (replace, reject, or allow with auditing).
- **FR-018**: The system MUST fail closed — denying access — when session state cannot be determined (e.g., due to clock skew or state corruption).
- **FR-019**: The system MUST separate authentication, session management, and authorization as distinct concerns to support future extensibility without cross-cutting rework.
- **FR-020**: The system MUST transport the session identity via an `HttpOnly`, `SameSite=Strict`, `Secure` (when HTTPS) browser cookie. The session identifier MUST NOT be accessible to browser JavaScript.
- **FR-021**: The system MUST validate the `Origin` header on all state-changing HTTP routes and WebSocket upgrade requests, rejecting requests whose origin does not match the gateway's own origin.
- **FR-022**: The system MUST implement CSRF protection for all non-idempotent HTTP routes (e.g., double-submit cookie or synchronizer token pattern).
- **FR-023**: The system MUST serve hardened HTTP response headers on every response, including a strict `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Strict-Transport-Security` (when TLS is active).
- **FR-024**: The system MUST require TLS for all non-loopback connections. Loopback-only access MAY operate without TLS.
- **FR-025**: The system MUST enforce rate limits on mutating HTTP endpoints and WebSocket session creation, in addition to login (FR-003).

### Key Entities

- **Operator**: A human user who authenticates to the Hydra web interface. Identified by a unique identity. May hold zero or more active sessions.
- **Session**: A bounded-lifetime, server-tracked connection between an authenticated operator and the Hydra workspace. Represented to the browser exclusively via an `HttpOnly` cookie — never as a JS-visible identifier. Has a defined lifecycle: created → active → (optionally extended) → expired/invalidated/logged-out. Each session has a unique, cryptographically random server-side identifier.
- **Credential**: The proof of identity presented during authentication. The specification is agnostic to credential type to support future extensibility.
- **Audit Record**: An immutable log entry capturing a security-relevant event, including actor identity, event type, timestamp, and outcome.
- **Session State**: One of a defined set of states (active, expiring-soon, expired, invalidated, logged-out, daemon-unreachable) that the system tracks and communicates to the operator.

> **Removed from this slice**: `DangerousActionPolicy` (the per-action
> authorization catalog) is deferred to Phase 4. The authorization module
> interface is designed to accept policy definitions later.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 100% of workspace routes return an authentication challenge when accessed without a valid session cookie — zero unauthenticated content leakage.
- **SC-002**: An operator can complete authentication and reach a functional workspace within 10 seconds under normal conditions.
- **SC-003**: Session state transitions (expiry, invalidation, daemon disconnect) are communicated to the operator within 5 seconds of occurrence.
- **SC-004**: Every security-relevant auth/session event defined in FR-013 produces a corresponding audit record — zero audit gaps for defined event types.
- **SC-005**: Terminated sessions (logout, expiry, invalidation) are rejected on all subsequent access attempts — zero session replay.
- **SC-006**: _(Deferred to Phase 4.)_ Dangerous actions are never executed without the operator completing an additional authorization step.
- **SC-007**: Rate-limiting activates after a configurable threshold of failed authentication attempts (default: no more than 5 failures in a 60-second window).
- **SC-008**: Adding a new authentication method, authorization rule, or session capability requires changes only to the corresponding concern — zero cross-concern modifications to existing specification sections.
- **SC-009**: The session cookie is never accessible to `document.cookie` or JavaScript — verified by `HttpOnly` flag on every `Set-Cookie` response.
- **SC-010**: Every non-idempotent HTTP route rejects requests missing a valid CSRF token — zero CSRF bypass.
- **SC-011**: Every state-changing route and WebSocket upgrade rejects requests with an `Origin` header that does not match the gateway — zero origin bypass.
- **SC-012**: Non-loopback connections without TLS are refused — zero plaintext remote sessions.
- **SC-013**: `npm run quality` and `npm test` pass at every task checkpoint once the new workspace packages exist.
