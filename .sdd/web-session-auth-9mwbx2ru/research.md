# Research: Web Session & Authentication

**Date**: 2026-03-15
**Feature**: [spec.md](./spec.md) | [plan.md](./plan.md)

## Research Questions and Findings

### RQ-1: Where Does Browser Authentication Live?

**Question**: Should browser authentication be owned by the daemon, the gateway, or a shared package?

**Finding**: The gateway owns it. The existing architecture docs (`docs/web-interface/03-architecture.md`) define the responsibility split explicitly:

> | `apps/web-gateway` | Auth, browser sessions, WebSocket termination, REST routes, static serving, protocol translation |
> | Hydra daemon | Source of truth for orchestration state, task lifecycle, sessions, durable events, config/workflow mutations |

The daemon's current auth model (`lib/daemon/http-utils.ts: isAuthorized()`) is a simple header-token check (`x-ai-orch-token`). This is appropriate for daemon-to-daemon or CLI-to-daemon communication but not for browser sessions. The security docs (`docs/web-interface/05-security-and-quality.md`) explicitly state: "browser should not store or reuse the raw daemon control token for ordinary operations."

**Decision**: Gateway owns browser auth. The gateway authenticates the operator, establishes a browser session, and proxies authorized requests to the daemon using the daemon's own token internally. The operator never sees or handles the daemon token.

---

### RQ-2: What Session Storage Backend to Use?

**Question**: The spec requires server-tracked sessions (FR-004, FR-009, FR-015). What storage is appropriate?

**Finding**: Hydra's deployment model is local/LAN (not cloud). The daemon already uses file-based event-sourced state with periodic snapshots (`docs/web-interface/03-architecture.md` — daemon owns "event persistence and replay"). No database exists in the dependency tree. The runtime deps are minimal: `zod`, `@modelcontextprotocol/sdk`, `cross-spawn`, `picocolors`.

**Options evaluated**:

| Option                       | Pros                                                            | Cons                                                                     |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| In-memory + file snapshot    | Zero dependencies, fast, simple, consistent with daemon pattern | Lost on gateway crash (mitigated by short session lifetimes and re-auth) |
| SQLite via better-sqlite3    | ACID, query-friendly                                            | Native dependency, complicates packaging                                 |
| Redis                        | Fast, built for sessions                                        | Requires separate service, violates local simplicity                     |
| Plain JSON files per session | Persistent, inspectable                                         | Slow at scale, file locking complexity                                   |

**Decision**: In-memory Map with periodic JSON file snapshots. Sessions are short-lived by design (FR-004), so losing them on gateway restart is acceptable — operators simply re-authenticate, which satisfies FR-015 (invalidate sessions on restart). The file snapshot enables audit and debugging but is not the source of truth for session validity.

---

### RQ-3: How Should Concern Separation Be Enforced?

**Question**: FR-019 requires authentication, session management, and authorization to be "distinct concerns." How do we make this testable per SC-008?

**Finding**: The existing codebase uses ESLint boundaries plugin (`eslint-plugin-boundaries` in devDependencies) to enforce architectural rules. The web-interface docs (`docs/web-interface/05-security-and-quality.md`) call for "lint complexity and nesting limits; max-lines and architectural-boundary rules; cycle detection."

**Decision**: Physical separation into three directories (`auth/`, `session/`, `security/`) with ESLint boundary rules preventing cross-imports. Each module exposes a service interface that the gateway's route handlers compose. The modules share types only through `packages/web-contracts/`, never through direct imports. This makes SC-008 enforceable by static analysis: adding a new auth method means adding files to `auth/` and schemas to `web-contracts/auth-schemas.ts` — if `session/` or `security/` imports change, the boundary lint fails. The full `authorization/` module is deferred to Phase 4; the directory structure is designed so it can be added alongside the existing modules without modifying them.

---

### RQ-4: How to Handle the "Fail Closed" Requirement?

**Question**: FR-018 says the system must deny access when session state cannot be determined (clock skew, state corruption). How do we make this reliable?

**Finding**: The spec's edge case identifies clock drift as a risk. Node.js `Date.now()` depends on system time. If the gateway and daemon have skewed clocks, session expiry can be miscalculated.

**Decision**: Inject an abstracted clock into all time-dependent services. The clock:

1. Uses `Date.now()` by default in production.
2. Can be replaced with a fake clock in tests (deterministic expiry testing).
3. Includes a monotonicity check: if the clock goes backward beyond a configurable tolerance (e.g., 30 seconds), the clock reports "unreliable" and all session validity checks return `false` (fail closed).
4. Session validation includes both an expiry check (clock-based) and a server-side state check (state machine). If either fails, the session is invalid.

---

### RQ-5: What Is the Concurrent Session Policy?

**Question**: FR-017 requires a defined policy for concurrent sessions by the same operator. The spec says "replace, reject, or allow with auditing" — which?

**Finding**: The deployment context is local/LAN with a small number of operators. The edge case about multiple browser tabs under one session implies that operators routinely use multiple tabs. Rejecting concurrent sessions would break multi-tab usage. Replacing sessions would forcefully disconnect existing tabs.

**Decision**: Allow concurrent sessions with auditable tracking. Each new authentication creates a new session ID. All sessions for the same operator are independently tracked and can be individually invalidated. The audit trail records session creation with the operator's existing active session count. A configurable maximum concurrent session limit (default: 5) prevents unbounded accumulation. This policy is the most flexible and least surprising for a local deployment.

---

### RQ-6: How Will This Slice Support Future Dangerous-Action Policies?

**Question**: FR-011 (deferred to Phase 4) requires per-action authorization. What does this slice need to provide so Phase 4 can add it without reworking auth or session modules?

**Finding**: The web-interface docs reference "controlled mutations" and "destructive-action safeguards" as Phase 4 concerns (`web-controlled-mutations` slice). The spec explicitly defers the dangerous-action catalog, per-action authorization challenges, and confirmation workflows to that slice.

**Decision**: This slice does **not** build an authorization module or a dangerous-action allowlist. The responsibility of this slice is limited to ensuring that the directory structure and module boundaries (`auth/`, `session/`, `security/`) are designed so that a future `authorization/` module can be added alongside them without modifying existing modules. No authorization service, no action-pattern matching, and no policy configuration are implemented here. FR-011 and its detailed design are Phase 4 deliverables.

---

### RQ-7: How Does Session State Propagation Work Across Tabs?

**Question**: FR-016 requires that session state changes propagate to all active client connections promptly. The edge case about multiple tabs makes this concrete.

**Finding**: The architecture specifies WebSocket as the canonical transport for the conversation stream (`docs/web-interface/04-protocol.md`). The gateway terminates WebSocket connections. When a session state changes (logout, revocation, expiry), the gateway knows all active WebSocket connections for that session.

**Decision**: The gateway maintains a registry of active connections per session ID. When session state changes (via the session service's state machine), the session-state-broadcaster iterates all connections for that session and sends a typed `SessionEvent` message. Connections that fail to receive the message are marked for cleanup. For non-WebSocket clients (REST-only), the session validation middleware returns the current state on every request, so the browser discovers state changes on the next request. This satisfies FR-016 and SC-003 (5-second propagation).

---

### RQ-8: Why HttpOnly Cookie Transport Instead of JS-Visible Session Tokens?

**Question**: The browser needs to identify its session on every request. Should the session ID be returned in the login response body (available to JS) or set as an HttpOnly cookie?

**Finding**: `docs/web-interface/05-security-and-quality.md` specifies:

> Use a **browser session cookie** backed by gateway-controlled validation.
> Recommended properties: `HttpOnly`; `SameSite=Strict`; `Secure` whenever HTTPS is used.

An HttpOnly cookie is invisible to `document.cookie` and to any injected script. If a future XSS vulnerability exists in streamed content rendering, the session identifier remains inaccessible. A JS-visible token (e.g., in `localStorage` or a response body) is trivially exfiltrable via XSS.

**Decision**: The gateway sets the session identity as an `HttpOnly; SameSite=Strict; Secure` cookie on the login response. The `LoginResponse` body contains only the operator ID and session metadata (expiry, state) — never the raw session identifier. All subsequent requests (REST and WebSocket upgrade) carry the cookie automatically. This aligns with FR-020 and SC-009.

---

### RQ-9: How Should CSRF Protection Work?

**Question**: `SameSite=Strict` cookies are not sent on cross-site requests in modern browsers, but CSRF protection is still required for defence-in-depth (FR-022). What pattern should be used?

**Finding**: Two standard patterns exist:

1. **Synchronizer token** — server generates a CSRF token per session, embeds it in a response header or meta tag, browser sends it back on every mutating request.
2. **Double-submit cookie** — server sets a second, non-HttpOnly cookie with a random value; browser must echo that value in a custom header.

The double-submit pattern is simpler for a SPA because it doesn't require server-side token storage. Combined with `SameSite=Strict` on the session cookie and `Origin` validation (FR-021), the attack surface is minimal.

**Decision**: Use a double-submit cookie pattern. On session creation, the gateway sets a non-HttpOnly `__csrf` cookie with a cryptographically random value. Mutating HTTP routes require a custom `X-CSRF-Token` header whose value matches the cookie. The WebSocket upgrade is covered by `Origin` validation (not CSRF tokens, since WebSocket handshakes don't support custom headers in browsers). This satisfies FR-022 and SC-010.

---

### RQ-10: What Hardened Headers and CSP Policy?

**Question**: FR-023 requires hardened response headers including CSP. What is the right starting policy?

**Finding**: `docs/web-interface/05-security-and-quality.md` requires "strict CSP and hardened response headers." The gateway serves both API responses and (eventually) static assets.

**Decision**: Every gateway response includes:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; frame-ancestors 'none'` — allows only same-origin resources, WebSocket connections, and inline styles (needed for many UI frameworks). No `eval`, no external scripts.
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains` (only when TLS is active, per FR-024)

The CSP is deliberately strict. If the frontend framework requires loosening (e.g., for hashed inline scripts), that is handled in the `web-chat-workspace` slice, not here.

---

### RQ-11: TLS Enforcement for Non-Loopback Access

**Question**: FR-024 requires TLS for non-loopback. How is this enforced?

**Finding**: `docs/web-interface/05-security-and-quality.md` says "TLS required for non-loopback access." The daemon is already loopback-only by default. The gateway inherits this posture.

**Decision**: The gateway startup checks its bind address. If the address is not a loopback interface (127.0.0.1, ::1), the gateway requires TLS configuration (cert + key paths). If TLS is not configured for a non-loopback bind, the gateway refuses to start and logs a clear error. The `Secure` flag on the session cookie is set conditionally: always on when TLS is active, omitted only for loopback-without-TLS. This satisfies FR-024 and SC-012.
