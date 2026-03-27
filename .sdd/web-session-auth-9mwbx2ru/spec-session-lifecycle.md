# Feature Specification: Web Session Lifecycle (Remainder)

**Created**: 2025-07-13
**Status**: Draft
**Slice**: `web-session-auth` — Phase 1, Session Lifecycle sub-slice
**Predecessor**: Login sub-slice (PR #210, merged)
**SDD directory**: `.sdd/web-session-auth-9mwbx2ru/`

---

## Overview

This specification covers the **remainder** of the `web-session-auth` SDD slice — everything
not delivered by the Login sub-slice (PR #210). The Login sub-slice established:

- An auth API client (`login`, `getSessionInfo`, `logout`, `getCsrfToken`)
- The login form component and `/login` route
- A TanStack Router `beforeLoad` guard on `workspaceRoute` that redirects to `/login` when the
  session is `null` or in a terminal state

This spec delivers the **reactive session layer** that sits on top of those primitives: a
`reauth()` API function, a `useSession` hook, a React context that makes session state
universally accessible inside the workspace, and the workspace-level UI affordances (expiry
warning banner, logout button, daemon-unreachable screen) that give the operator continuous
visibility into session health.

### Why this matters

The Login sub-slice guards the entry door. This sub-slice keeps the house safe once the operator
is inside. Without it, the workspace has no mechanism to react to a session that expires mid-use,
warn the operator before losing work, or distinguish between "your session ended" and "the daemon
is temporarily down". All items are P1 relative to any workspace feature that touches the Hydra
daemon.

---

## Functional Requirements

### FR-101 — `reauth()` auth client function

The auth client module MUST export a `reauth()` function that extends the operator's current
session. It MUST:

- Send a `POST /auth/reauth` request with `credentials: 'include'` so the existing session cookie
  is forwarded automatically
- Include the CSRF double-submit value in an `x-csrf-token` request header (same pattern as
  `logout()`)
- On `200 OK`, parse and return the response body as `ExtendResponse`
- On any non-`2xx` status, parse the response body as `AuthError` and throw an `Error` with
  `error.code` set to `AuthError.code`, mirroring the error-propagation pattern of `login()`
- On network failure, propagate the underlying `Error` to the caller unmodified

> **Rationale**: Extracting this as a standalone function keeps the auth client the single source
> of truth for HTTP coordination; the `useSession` hook calls it without duplicating fetch logic.

---

### FR-102 — `useSession` hook — initial fetch

On first render, `useSession` MUST call `getSessionInfo()` and populate `session` with the
returned `SessionInfo` (or `null` on `401`). `isLoading` MUST be `true` from mount until the
initial fetch settles.

---

### FR-103 — `useSession` hook — polling

When the current session state is `active` or `expiring-soon`, `useSession` MUST poll
`getSessionInfo()` on a configurable interval. The default interval MUST be 60 seconds.

Polling MUST pause when `document.visibilityState === 'hidden'` and resume when the document
becomes visible again, to avoid unnecessary gateway load while the tab is in the background.

Polling MUST stop entirely when the session enters a terminal state (`expired`, `invalidated`,
`logged-out`) or `daemon-unreachable`.

---

### FR-104 — `useSession` hook — WebSocket session event subscription

`useSession` MUST open a WebSocket connection to the gateway's `/ws` endpoint with
`credentials: 'include'` and subscribe to incoming `SessionEvent` frames.

On receiving a valid `SessionEvent` frame:

- If `type` is `state-change` or `expiry-warning`, `useSession` MUST update `session.state` to
  `event.newState` without waiting for the next poll cycle
- If `type` is `forced-logout`, `useSession` MUST update `session.state` to `event.newState`
  (which will be a terminal state) and cease all further polling

The WebSocket connection MUST be torn down and re-established (with exponential back-off, maximum
retry delay of 30 seconds) if the connection closes unexpectedly while the session is
`active` or `expiring-soon`.

The WebSocket connection MUST be closed cleanly when the hook unmounts.

> **Out of scope**: The full WebSocket subscribe/unsubscribe protocol for conversation events is
> covered by the `web-conversation-protocol` SDD slice. This spec covers only session-event
> framing on the same `/ws` connection.

---

### FR-105 — `useSession` hook — public surface

`useSession` MUST expose the following stable interface:

```
{
  session:   SessionInfo | null   // null while loading or when unauthenticated
  isLoading: boolean              // true only during the initial fetch
  extend:    () => Promise<void>  // calls reauth(), updates session.expiresAt on success
  logout:    () => Promise<void>  // calls logout(), marks session as logged-out locally
}
```

`extend()` MUST call `reauth()`, and on success MUST update the local `session` value to reflect
`newExpiresAt` and set `session.state` back to `active` if it was `expiring-soon`.

`logout()` MUST call the `logout()` auth client function and then set the local `session` to
`null`. Navigation to `/login` is the responsibility of the **caller**, not of the hook itself.
The hook has no router dependency.

---

### FR-106 — `SessionProvider` React context

A `SessionProvider` component MUST wrap the `useSession` hook result in a React context so that
any descendant component can access session state and actions via a `useSessionContext()` hook.

`useSessionContext()` MUST throw a descriptive `Error` when called outside a `SessionProvider`.

The `SessionProvider` MUST accept a `pollInterval` prop (optional, number of milliseconds) that
is forwarded to `useSession` as its configurable poll interval.

---

### FR-107 — `SessionProvider` placement in the workspace

`SessionProvider` MUST be mounted as the outermost wrapper of the `WorkspaceRoute` component,
wrapping the workspace content and `<Outlet />`. It MUST NOT be mounted in
`apps/web/src/app/providers.tsx` or in `AppShell`.

> **Rationale**: The existing `AppShell` comment explicitly notes: _"Connection-status banners
> are rendered by each route that owns the connection state (e.g. WorkspaceRoute), not here,
> because the context provider lives below the root route in the component tree."_ Mounting
> `SessionProvider` in root providers would cause polling and a WebSocket connection to open on
> the `/login` route and on the index route, where no session state is needed. Confining it to
> the workspace subtree is both architecturally correct and avoids unnecessary gateway load.

---

### FR-108 — Expiry warning banner

When `session.state === 'expiring-soon'`, the workspace MUST display a dismissible warning banner
at the top of the workspace content area (below the app-shell header, above all other workspace
content).

The banner MUST contain:

- A human-readable warning message that communicates the session is about to expire
- An **"Extend Session"** button that calls `extend()` from the session context
- A dismiss control (×) that hides the banner for the remainder of the `expiring-soon` window
  without triggering an extension

The banner MUST disappear automatically when `session.state` transitions away from
`expiring-soon` — whether by extension (→ `active`), expiry (→ `expired`), or any other
transition.

Dismissing the banner MUST be local UI state only. If `session.state` returns to
`expiring-soon` (e.g. after a page reload), the banner MUST be shown again.

While `extend()` is in flight, the "Extend Session" button MUST be disabled and indicate a
loading state.

---

### FR-109 — Logout button in the workspace header

The workspace layout MUST render a **"Log out"** button in the header area. Activating it MUST:

1. Call `logout()` from the session context
2. Navigate to `/login` using TanStack Router's `navigate` or `useNavigate()` hook

The button MUST be disabled while the `logout()` call is in flight.

---

### FR-110 — Daemon-unreachable error state

When `session.state === 'daemon-unreachable'`, the workspace MUST render a prominent, full-width
error state in place of normal workspace content. This screen MUST:

- Make clear that the Hydra daemon is temporarily unavailable — NOT that the session has expired
- Preserve the operator's authenticated context (no redirect to `/login`)
- Offer a **"Retry"** / **"Check again"** action that triggers a manual call to `getSessionInfo()`
  and updates the session state if the daemon has recovered

The `workspaceRoute.beforeLoad` guard MUST NOT redirect for `daemon-unreachable`; that state
MUST be handled entirely inside the workspace component tree.

---

### FR-111 — Route guard unchanged for terminal states

The existing `workspaceRoute.beforeLoad` guard behaviour for `null` sessions and TERMINAL_STATES
(`expired`, `invalidated`, `logged-out`) MUST remain unchanged. No modification to the guard's
redirect logic is required by this spec.

`expiring-soon` and `daemon-unreachable` are handled reactively inside the workspace; the guard
MUST NOT redirect for either of these states.

---

## Non-Functional Requirements

### NFR-201 — Session event latency

A `SessionEvent` received over the WebSocket MUST be reflected in the UI within 250 ms of the
frame being received.

### NFR-202 — Poll jitter

The polling interval MUST include a ±5 % randomised jitter to prevent thundering-herd behaviour
when many tabs are open. Jitter MUST be re-applied on each poll cycle, not only on mount.

### NFR-203 — WebSocket back-off

WebSocket reconnect attempts MUST use binary exponential back-off starting at 1 second and
capped at 30 seconds. Each reconnect attempt MUST add a ±500 ms random jitter to avoid
correlated reconnect storms.

### NFR-204 — Cookie access safety

All reads of `document.cookie` MUST use the `Reflect.get(globalThis, 'document')` guard pattern
established in `auth-client.ts`, so the code functions correctly in Node.js test environments
where `document` is not defined.

### NFR-205 — TypeScript strict

All new source files MUST compile without errors under the project's existing `tsconfig.json`
(strict mode). No `@ts-ignore` or `@ts-expect-error` suppressions are permitted without a
co-located explanatory comment and team review.

### NFR-206 — No external component library

All UI (banner, logout button, daemon-unreachable screen) MUST be implemented with inline styles
only. No third-party component library may be introduced.

### NFR-207 — Accessibility

- The expiry warning banner MUST have `role="alert"` so screen readers announce it automatically
  when it appears
- The "Extend Session" and dismiss buttons MUST have accessible labels (`aria-label` or visible
  text)
- The daemon-unreachable screen MUST have `role="status"` and a clearly labelled retry control
- The logout button MUST be a native `<button>` element with visible text

### NFR-208 — No memory leaks

The WebSocket connection and polling timer MUST be cleaned up in the `useSession` hook's effect
cleanup function. Unmounting `SessionProvider` MUST leave no lingering timers or open connections.

---

## Component Breakdown

The table below lists every file that must be created or modified. Files shown without a
modification note are **new**.

| File                                                           | Action     | Description                                                                                 |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `apps/web/src/features/auth/api/auth-client.ts`                | **Modify** | Add `reauth()` export                                                                       |
| `apps/web/src/features/auth/hooks/use-session.ts`              | **Create** | `useSession` hook                                                                           |
| `apps/web/src/features/auth/context/session-context.ts`        | **Create** | React context definition and `useSessionContext()`                                          |
| `apps/web/src/features/auth/components/session-provider.tsx`   | **Create** | `SessionProvider` component wrapping `useSession`                                           |
| `apps/web/src/features/auth/components/expiry-banner.tsx`      | **Create** | Dismissible expiry warning banner                                                           |
| `apps/web/src/features/auth/components/daemon-unreachable.tsx` | **Create** | Full-width daemon-unavailable error screen                                                  |
| `apps/web/src/routes/workspace.tsx`                            | **Modify** | Wrap with `SessionProvider`; render `ExpiryBanner`, `DaemonUnreachable`, and `LogoutButton` |
| `apps/web/src/app/app-shell.tsx`                               | **Modify** | Add `LogoutButton` to the workspace header (visible only inside workspace context)          |

> **Note on LogoutButton placement**: The `AppShell` renders the header for all routes. Because
> `SessionProvider` is scoped to the workspace, `LogoutButton` should be rendered directly by
> `WorkspaceRoute` inside a dedicated workspace header band (above the `<Outlet />`), rather
> than by `AppShell` itself. Altering `AppShell` to conditionally render a logout button based
> on session context would couple the root shell to a workspace-only concern.

---

## Contract Dependencies

All contracts listed below already exist in `@hydra/web-contracts`. No new schemas are required
by this spec.

| Export            | Source file          | Used by                                        |
| ----------------- | -------------------- | ---------------------------------------------- |
| `ExtendResponse`  | `session-schemas.ts` | `reauth()` — parse response body               |
| `SessionInfo`     | `session-schemas.ts` | `useSession` — type the `session` value        |
| `SessionState`    | `session-schemas.ts` | `useSession` — branch on state value           |
| `SessionEvent`    | `session-schemas.ts` | `useSession` — parse incoming WebSocket frames |
| `TERMINAL_STATES` | `session-schemas.ts` | `useSession` — stop polling on terminal state  |
| `AuthError`       | `auth-schemas.ts`    | `reauth()` — parse error response body         |

---

## Test Requirements

### Unit tests (Node `node:test` + `assert/strict`) — `.test.ts`

Each test file MUST follow the pattern in
`apps/web/src/features/auth/__tests__/auth-client.test.ts`: mock `globalThis.fetch` directly,
use `node:test` runner primitives (`describe`, `it`, `before`, `after`, `beforeEach`), and assert
with `node:assert/strict`.

| Test file                                                         | Coverage target                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/auth/__tests__/auth-client-reauth.test.ts` | `reauth()` — success path returns parsed `ExtendResponse`; non-2xx throws with correct `.code`; CSRF token is read from `document.cookie` and sent as `x-csrf-token`; missing CSRF token is handled gracefully (omitted header, no throw)                                                                                                                                                           |
| `apps/web/src/features/auth/__tests__/use-session.test.ts`        | `useSession` — initial fetch populates `session`; polling fires at configured interval; polling pauses on `visibilitychange` to hidden; WebSocket frame updates state without waiting for poll; terminal state stops polling; `extend()` calls `reauth()` and updates `expiresAt`; `logout()` calls `logout()` auth function and sets session to `null`; cleanup cancels timer and closes WebSocket |

### Browser specs (Vitest + Testing Library) — `.browser.spec.tsx`

Each browser spec MUST follow the pattern in
`apps/web/src/features/auth/__tests__/login-form.browser.spec.tsx`: use `vi.mock()` for
module-level mocks, `render()` + `screen` from `@testing-library/react`, and
`userEvent.setup()` for interaction simulation.

| Test file                                                                  | Coverage target                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/auth/__tests__/session-provider.browser.spec.tsx`   | `SessionProvider` — `useSessionContext()` throws outside provider; context value is propagated to consumers; `extend()` and `logout()` are callable from consumer                                                                                                                              |
| `apps/web/src/features/auth/__tests__/expiry-banner.browser.spec.tsx`      | `ExpiryBanner` — not rendered when state is `active`; rendered with `role="alert"` when `expiring-soon`; "Extend Session" button calls `extend()`; dismiss button hides banner; banner disappears when state changes away from `expiring-soon`; "Extend Session" button disabled while loading |
| `apps/web/src/features/auth/__tests__/daemon-unreachable.browser.spec.tsx` | `DaemonUnreachable` — renders with `role="status"` when `daemon-unreachable`; not rendered for other states; "Retry" button calls `getSessionInfo()` and updates state on recovery; retry button is focusable and has accessible label                                                         |
| `apps/web/src/features/auth/__tests__/logout-button.browser.spec.tsx`      | `LogoutButton` — calls `logout()` from context on click; navigates to `/login` after logout resolves; is disabled while logout is in flight; is a native `<button>` element                                                                                                                    |

### Test IDs

Every interactive element introduced by this spec MUST carry a `data-testid` attribute matching
the following convention (established in `login-form.tsx`):

| Element                         | `data-testid`              |
| ------------------------------- | -------------------------- |
| Expiry warning banner container | `expiry-banner`            |
| "Extend Session" button         | `extend-session-button`    |
| Banner dismiss button           | `expiry-banner-dismiss`    |
| Daemon-unreachable screen       | `daemon-unreachable`       |
| Retry button                    | `daemon-unreachable-retry` |
| Logout button                   | `logout-button`            |

---

## Out of Scope

The following items are explicitly excluded from this spec:

| Item                                                                 | Why excluded                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| WebSocket subscribe/unsubscribe protocol for conversation events     | Covered by `web-conversation-protocol` SDD slice                                        |
| Admin-initiated session revocation and revocation-reason display     | Phase 4 — `admin-session-management` slice                                              |
| Per-action re-authentication challenges (dangerous-action gate)      | Phase 4 — `web-controlled-mutations` slice                                              |
| Audit log review UX                                                  | Phase 4                                                                                 |
| Server-side changes to `/auth/reauth` or the WebSocket handler       | Already implemented in the gateway                                                      |
| New Zod schemas in `@hydra/web-contracts`                            | All required contracts are already exported                                             |
| Multi-tab session sync beyond what the existing WebSocket broadcasts | Out of scope for Phase 1                                                                |
| `providers.tsx` modifications                                        | `SessionProvider` is workspace-scoped (see FR-107); `providers.tsx` requires no changes |

---

## Acceptance Criteria

### AC-101 — `reauth()` is exported from the auth client

**Given** a call to `reauth()`,
**When** the gateway returns `200 OK` with a valid `ExtendResponse` body,
**Then** `reauth()` resolves with the parsed `ExtendResponse` and the CSRF token was sent in
the `x-csrf-token` header.

### AC-102 — `reauth()` propagates auth errors

**Given** a call to `reauth()`,
**When** the gateway returns a non-2xx status with a valid `AuthError` body,
**Then** `reauth()` throws an `Error` with `error.code` matching `AuthError.code`.

### AC-103 — `useSession` populates session on mount

**Given** a component tree containing `SessionProvider`,
**When** the component mounts,
**Then** `isLoading` is `true` until `getSessionInfo()` resolves, and `session` contains the
returned `SessionInfo` afterwards.

### AC-104 — `useSession` polls at the configured interval

**Given** an active session,
**When** the configured poll interval elapses,
**Then** `getSessionInfo()` is called again and `session` is updated if the state has changed.

### AC-105 — Polling pauses in background tabs

**Given** an active session in a background tab (`document.visibilityState === 'hidden'`),
**When** the poll interval would fire,
**Then** `getSessionInfo()` is NOT called until the tab becomes visible again.

### AC-106 — WebSocket event updates state immediately

**Given** the WebSocket connection is open,
**When** a `state-change` `SessionEvent` frame arrives,
**Then** `session.state` is updated within 250 ms without waiting for the next poll cycle.

### AC-107 — `forced-logout` stops polling

**Given** an active session,
**When** a `forced-logout` `SessionEvent` is received,
**Then** `session.state` reflects the terminal state and no further polling occurs.

### AC-108 — `useSessionContext()` throws outside provider

**Given** a component that calls `useSessionContext()`,
**When** it renders outside a `SessionProvider`,
**Then** an `Error` is thrown with a message that identifies the missing provider.

### AC-109 — `extend()` updates expiry and resets state

**Given** a session in state `expiring-soon`,
**When** `extend()` is called and `reauth()` succeeds,
**Then** `session.expiresAt` reflects `ExtendResponse.newExpiresAt` and `session.state` returns
to `active`.

### AC-110 — `logout()` clears session and does not navigate

**Given** a component calling `logout()` from session context,
**When** the call resolves,
**Then** `session` is `null` and the hook has not performed any navigation itself.

### AC-111 — Expiry banner appears for `expiring-soon`

**Given** the workspace is rendered with `session.state === 'expiring-soon'`,
**When** the component tree renders,
**Then** an element with `data-testid="expiry-banner"` and `role="alert"` is present in the DOM.

### AC-112 — Expiry banner is absent for other states

**Given** the workspace is rendered with `session.state === 'active'` (or any non-`expiring-soon`
state),
**When** the component tree renders,
**Then** no element with `data-testid="expiry-banner"` is present in the DOM.

### AC-113 — Dismiss hides banner without extending

**Given** the expiry banner is visible,
**When** the operator activates the dismiss control (`data-testid="expiry-banner-dismiss"`),
**Then** the banner is no longer visible and `extend()` was NOT called.

### AC-114 — Banner disappears on state transition

**Given** the expiry banner is visible and the operator has NOT dismissed it,
**When** `session.state` transitions to any state other than `expiring-soon`,
**Then** the banner is no longer visible.

### AC-115 — Logout button navigates to `/login`

**Given** the operator activates the logout button (`data-testid="logout-button"`),
**When** `logout()` resolves,
**Then** the router navigates to `/login`.

### AC-116 — Daemon-unreachable screen replaces workspace content

**Given** `session.state === 'daemon-unreachable'`,
**When** the workspace renders,
**Then** an element with `data-testid="daemon-unreachable"` and `role="status"` is visible and
normal workspace content is not rendered.

### AC-117 — Daemon-unreachable does not redirect to login

**Given** `session.state === 'daemon-unreachable'`,
**When** the workspace renders,
**Then** no redirect to `/login` occurs.

### AC-118 — Retry recovers from daemon-unreachable

**Given** the daemon-unreachable screen is visible,
**When** the operator activates the retry button (`data-testid="daemon-unreachable-retry"`) and
`getSessionInfo()` returns an `active` session,
**Then** `session.state` returns to `active` and the workspace content is restored.

### AC-119 — `workspaceRoute.beforeLoad` guard is unchanged for terminal states

**Given** a browser request to `/workspace` when the session is `null` or in a terminal state,
**When** `beforeLoad` runs,
**Then** the router redirects to `/login` with a `redirectTo` search parameter.

### AC-120 — WebSocket cleanup on unmount

**Given** `SessionProvider` is mounted and a WebSocket connection is open,
**When** `SessionProvider` unmounts,
**Then** the WebSocket connection is closed and no further events are processed.

### AC-121 — No polling when unauthenticated

**Given** `getSessionInfo()` returns `null` (no active session),
**When** `useSession` is in this state,
**Then** no polling timer is active.

---

## Open Questions

None. All decisions are resolvable from the existing codebase, contract definitions, and the
constraints stated in this spec. Architectural choices that could have been ambiguous are resolved
with rationale inline (see FR-107 on provider placement, FR-105 on navigation ownership).
