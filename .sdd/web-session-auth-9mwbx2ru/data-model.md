# Data Model: Web Session & Authentication

**Date**: 2026-03-15
**Feature**: [spec.md](./spec.md) | [plan.md](./plan.md)

## Entities

### Operator

Represents a human user authorized to access the Hydra web interface.

| Attribute   | Type      | Constraints       | Description                                                           |
| ----------- | --------- | ----------------- | --------------------------------------------------------------------- |
| id          | string    | Unique, immutable | Stable operator identifier                                            |
| displayName | string    | Non-empty         | Human-readable name for UI and audit logs                             |
| createdAt   | timestamp | Immutable         | When the operator record was created                                  |
| isActive    | boolean   | Default: true     | Whether the operator can authenticate (soft-disable without deletion) |

**Relationships**:

- Has 0..N **Credential** records
- Has 0..N **Session** records (active or historical)
- Referenced by **AuditRecord** as actor

---

### Credential

Proof-of-identity material bound to an Operator. The schema is intentionally generic to support future credential types (FR-019, SC-008).

| Attribute    | Type          | Constraints                     | Description                                          |
| ------------ | ------------- | ------------------------------- | ---------------------------------------------------- |
| id           | string        | Unique                          | Credential record identifier                         |
| operatorId   | string        | FK → Operator.id                | Owning operator                                      |
| type         | string (enum) | One of defined credential types | Credential category (e.g., "password")               |
| hashedSecret | string        | Never plaintext                 | One-way hash of the secret material                  |
| salt         | string        | Per-credential unique           | Unique salt used in hashing                          |
| createdAt    | timestamp     | Immutable                       | When this credential was created                     |
| lastUsedAt   | timestamp     | Nullable                        | Last successful authentication using this credential |
| isRevoked    | boolean       | Default: false                  | Whether this credential has been disabled            |

**Validation rules**:

- `hashedSecret` must be produced by a one-way hash function; plaintext storage is forbidden
- `salt` must be cryptographically random and unique per credential
- A revoked credential must be rejected during authentication regardless of correctness
- An operator may have multiple credentials of different types (extensibility for SC-008)

---

### Session

A bounded-lifetime, server-tracked connection between an authenticated Operator and the Hydra workspace.

> **Cookie transport (FR-020).** The session `id` is never returned to the browser
> in a response body or made accessible to JavaScript. It is set as an `HttpOnly;
SameSite=Strict; Secure` cookie by the gateway on login. A separate non-HttpOnly
> `__csrf` cookie carries the CSRF double-submit token (FR-022).

| Attribute         | Type         | Constraints                           | Description                                         |
| ----------------- | ------------ | ------------------------------------- | --------------------------------------------------- |
| id                | string       | Unique, cryptographically random      | Session identifier — cookie value, never JS-visible |
| operatorId        | string       | FK → Operator.id                      | Authenticated operator                              |
| state             | SessionState | Must follow state machine transitions | Current session state                               |
| createdAt         | timestamp    | Immutable                             | Session creation time                               |
| expiresAt         | timestamp    | Must be future at creation            | Absolute session expiry time                        |
| lastActivityAt    | timestamp    | Updated on operator activity          | Last meaningful operator interaction                |
| extendedCount     | integer      | ≥ 0, ≤ maxExtensions                  | Number of times session has been extended           |
| invalidatedReason | string       | Nullable                              | Reason for invalidation (if state is "invalidated") |
| createdFromIp     | string       | For audit purposes                    | Source address at creation time                     |
| csrfToken         | string       | Cryptographically random              | Double-submit CSRF token bound to this session      |

**Validation rules**:

- `id` must be generated with a cryptographically secure random source, minimum 128 bits of entropy
- `id` must only be transmitted to the browser as an `HttpOnly; SameSite=Strict; Secure` cookie — never in a response body
- `csrfToken` must be cryptographically random, transmitted as a non-HttpOnly cookie (`__csrf`) so JS can read and echo it
- `expiresAt` must always be in the future at creation and after each extension
- `extendedCount` must not exceed a configurable maximum (default: 3)
- State transitions must follow the defined state machine (invalid transitions are programming errors)
- A session in a terminal state (`expired`, `invalidated`, `logged-out`) must never transition to any other state

---

### SessionState (Enumeration)

Defines the complete set of states a Session can occupy. Every session is in exactly one state at all times.

| State                | Description                                                                                             | Terminal? |
| -------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| `active`             | Session is valid and usable                                                                             | No        |
| `expiring-soon`      | Session is valid but approaching expiry (within warning threshold)                                      | No        |
| `expired`            | Session lifetime has elapsed                                                                            | Yes       |
| `invalidated`        | Session was terminated by system policy (daemon restart, concurrent-session limit, future admin action) | Yes       |
| `logged-out`         | Operator explicitly logged out                                                                          | Yes       |
| `daemon-unreachable` | Gateway cannot reach the Hydra daemon (session itself may still be valid)                               | No        |

> **Rename note.** Earlier drafts used `revoked` for the admin-terminated state.
> This slice renames it to `invalidated` because the only triggers in scope are
> system-policy actions (daemon restart, concurrent-limit). Admin-initiated
> revocation with a reason display is deferred to Phase 4.

**State machine transitions** (see plan.md for diagram):

| From                 | To                   | Trigger                                                         |
| -------------------- | -------------------- | --------------------------------------------------------------- |
| (initial)            | `active`             | Successful authentication                                       |
| `active`             | `expiring-soon`      | Remaining time < warning threshold                              |
| `active`             | `expired`            | Time exceeds expiresAt                                          |
| `active`             | `invalidated`        | System policy action (daemon restart, concurrent-session limit) |
| `active`             | `logged-out`         | Operator logout                                                 |
| `active`             | `daemon-unreachable` | Daemon heartbeat failure                                        |
| `expiring-soon`      | `active`             | Operator extends session                                        |
| `expiring-soon`      | `expired`            | Time exceeds expiresAt                                          |
| `expiring-soon`      | `invalidated`        | System policy action                                            |
| `expiring-soon`      | `logged-out`         | Operator logout                                                 |
| `daemon-unreachable` | `active`             | Daemon heartbeat resumes                                        |
| `daemon-unreachable` | `expired`            | Time exceeds expiresAt during outage                            |

---

### DangerousActionPolicy _(deferred to Phase 4)_

The dangerous-action catalog, per-action challenge/confirm workflows, and the
authorization module that consumes these policies are Phase 4 scope
(`web-controlled-mutations` slice). This entity is listed here as a forward
reference only — no implementation, service interface, or configuration is
required in this slice.

| Attribute            | Type    | Constraints    | Description                                       |
| -------------------- | ------- | -------------- | ------------------------------------------------- |
| actionPattern        | string  | Unique pattern | Glob or exact match for action identifiers        |
| requiresReauth       | boolean |                | Whether the operator must re-enter credentials    |
| requiresConfirmation | boolean |                | Whether the operator must explicitly confirm      |
| description          | string  | Non-empty      | Human-readable explanation shown during challenge |

**Validation rules**:

- At least one of `requiresReauth` or `requiresConfirmation` must be `true`
- `actionPattern` must not be empty or match everything (no wildcard-only patterns)
- Policies are evaluated in definition order; first match wins

---

### AuditRecord

Immutable log entry capturing a security-relevant event.

| Attribute  | Type           | Constraints                                           | Description                   |
| ---------- | -------------- | ----------------------------------------------------- | ----------------------------- |
| id         | string         | Unique, monotonically ordered                         | Record identifier             |
| timestamp  | timestamp      | Monotonically increasing per session                  | When the event occurred       |
| eventType  | AuditEventType | Must be a defined type                                | Category of event             |
| operatorId | string         | Nullable (for failed auth with unknown identity)      | Actor who triggered the event |
| sessionId  | string         | Nullable (for pre-session events like login attempts) | Associated session            |
| outcome    | string (enum)  | "success" or "failure"                                | Result of the event           |
| detail     | object         | Schema varies by eventType                            | Event-specific metadata       |
| sourceIp   | string         |                                                       | Source address of the request |

**Validation rules**:

- Records are append-only; no updates or deletions permitted
- `timestamp` must be monotonically increasing within a session's audit trail
- `eventType` must be one of the defined `AuditEventType` values
- `detail` schema is validated per `eventType`

---

### AuditEventType (Enumeration)

Event types recorded in this slice. Additional types (authorization challenges, dangerous-action decisions) will be added by Phase 4.

| Event Type                   | Detail Contains                            | Mapped FR      |
| ---------------------------- | ------------------------------------------ | -------------- |
| `auth.attempt.success`       | operatorId, credentialType                 | FR-013         |
| `auth.attempt.failure`       | attemptedIdentity, reason                  | FR-013         |
| `auth.rate-limited`          | sourceIp, attemptCount, lockoutDuration    | FR-003, FR-013 |
| `session.created`            | sessionId, expiresAt                       | FR-004, FR-013 |
| `session.extended`           | sessionId, previousExpiresAt, newExpiresAt | FR-008, FR-013 |
| `session.expired`            | sessionId                                  | FR-013         |
| `session.invalidated`        | sessionId, reason                          | FR-013         |
| `session.logged-out`         | sessionId                                  | FR-007, FR-013 |
| `session.daemon-unreachable` | sessionId, lastHeartbeat                   | FR-010, FR-013 |
| `session.daemon-restored`    | sessionId                                  | FR-013         |
| `session.idle-reauth`        | sessionId, idleDuration                    | FR-012, FR-013 |

> **Removed from this slice**: `authorization.challenged`, `authorization.approved`,
> `authorization.declined` — these require the dangerous-action catalog (Phase 4).

---

## Entity Relationship Summary

```text
Operator 1──N Credential
Operator 1──N Session
Session  1──1 SessionState (current)
Session  1──N AuditRecord
Operator 1──N AuditRecord (as actor)
DangerousActionPolicy ──── (deferred to Phase 4; not implemented in this slice)
```

## Configurable Thresholds

These values are referenced by the data model and must be operator-configurable:

| Threshold                   | Default                   | Referenced By                           |
| --------------------------- | ------------------------- | --------------------------------------- |
| Session lifetime            | 8 hours                   | Session.expiresAt                       |
| Session warning threshold   | 15 minutes before expiry  | SessionState transition → expiring-soon |
| Maximum session extensions  | 3                         | Session.extendedCount                   |
| Extension duration          | Same as original lifetime | Session.expiresAt after extend          |
| Idle timeout                | 30 minutes                | FR-012, re-auth required                |
| Rate-limit threshold        | 5 failures / 60 seconds   | FR-003, SC-007                          |
| Rate-limit lockout duration | 5 minutes                 | auth.rate-limited event                 |
| Maximum concurrent sessions | 5 per operator            | FR-017                                  |
| Audit retention period      | 90 days                   | AuditRecord cleanup                     |
| Daemon heartbeat interval   | 10 seconds                | daemon-unreachable detection            |
| Clock drift tolerance       | 30 seconds                | FR-018, fail-closed threshold           |
