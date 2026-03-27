# Session Lifecycle — Implementation Task List

> **SDD slice:** `web-session-auth` (session lifecycle sub-slice)
> **Status:** Planned — not yet started
> **Branch convention:** `feat/web-session-auth-lifecycle`
> **Predecessor:** Login sub-slice — PR #210 (merged)
> **Spec:** `.sdd/web-session-auth-9mwbx2ru/spec-session-lifecycle.md`

The gateway auth backend is fully implemented (`POST /auth/reauth`, `GET /session/info`, WebSocket
`/ws` session events, all contracts in `@hydra/web-contracts`). This task list covers browser-side
work only.

---

## Background

The login sub-slice (PR #210) delivered the entry guard: an auth client, a login form, a `/login`
route, and a `beforeLoad` redirect on `workspaceRoute`. Once an operator authenticates they land in
the workspace with no further session feedback. There is no mechanism to react to a session expiring
mid-use, warn before work is lost, or distinguish "session ended" from "daemon temporarily down".
This sub-slice delivers the reactive session layer that keeps the workspace safe once the operator
is inside.

---

## What the Backend Already Provides

| Endpoint            | Description                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /auth/reauth` | Extends current session; requires `__session` cookie + `x-csrf-token` header; returns `ExtendResponse` |
| `GET /session/info` | Returns `SessionInfo` if session valid; `401` if not                                                   |
| `GET /ws`           | WebSocket; broadcasts `SessionEvent` frames (`state-change`, `expiry-warning`, `forced-logout`)        |

Contracts in `@hydra/web-contracts` (all already exported — **no new schemas needed**):

| Export            | Source file          | Used by                                       |
| ----------------- | -------------------- | --------------------------------------------- |
| `ExtendResponse`  | `session-schemas.ts` | `reauth()` — parse response body              |
| `SessionInfo`     | `session-schemas.ts` | `useSession` — type the `session` value       |
| `SessionState`    | `session-schemas.ts` | `useSession` — branch on state value          |
| `SessionEvent`    | `session-schemas.ts` | `useSession` — parse incoming WS frames       |
| `TERMINAL_STATES` | `session-schemas.ts` | `useSession` — stop polling on terminal state |
| `AuthError`       | `auth-schemas.ts`    | `reauth()` — parse error response body        |

---

## Files to Create / Modify

```
apps/web/src/
  features/auth/
    api/
      auth-client.ts                                  ← MODIFY (add reauth)
    hooks/
      use-session.ts                                  ← NEW
    context/
      session-context.ts                              ← NEW
    components/
      session-provider.tsx                            ← NEW
      expiry-banner.tsx                               ← NEW
      daemon-unreachable.tsx                          ← NEW
      logout-button.tsx                               ← NEW
    __tests__/
      auth-client-reauth.test.ts                      ← NEW
      use-session.test.ts                             ← NEW
      session-provider.browser.spec.tsx               ← NEW
      expiry-banner.browser.spec.tsx                  ← NEW
      daemon-unreachable.browser.spec.tsx             ← NEW
      logout-button.browser.spec.tsx                  ← NEW
  routes/
    workspace.tsx                                     ← MODIFY
apps/web/README.md                                    ← MODIFY
apps/web-gateway/README.md                            ← MODIFY
```

> **Not modified:** `apps/web/src/app/providers.tsx`, `apps/web/src/app/app-shell.tsx`.
> `SessionProvider` is workspace-scoped (FR-107); mounting it in root providers would open a
> WebSocket on every route. The logout button lives in a workspace-owned header band, not in
> `AppShell`, to avoid coupling the root shell to a workspace-only concern.

---

## Tasks

### T1 — `reauth()` in auth-client

**Files:**

- `apps/web/src/features/auth/api/auth-client.ts` ← MODIFY
- `apps/web/src/features/auth/__tests__/auth-client-reauth.test.ts` ← NEW

**Depends on:** none — can start immediately

Add a `reauth()` export to the existing auth client. Extend the module — do not restructure existing
exports.

Implementation notes:

- Call `POST /auth/reauth` with `credentials: 'include'`.
- Read the CSRF double-submit value with `getCsrfToken()` (already defined in the module) and send
  it as the `x-csrf-token` request header. If `getCsrfToken()` returns `null`, omit the header —
  do not throw.
- On `200 OK`, parse the response body with `ExtendResponse.parse()` and return the typed result.
- On any non-`2xx` status, parse the body with `AuthError.parse()`, construct
  `new Error(parsed.message)`, attach `err.code = parsed.code`, and throw — mirroring the error
  pattern of `login()`.
- On network failure, let the underlying `fetch` rejection propagate unmodified.
- Function signature: `export async function reauth(): Promise<ExtendResponse>`

**Tests required** — `apps/web/src/features/auth/__tests__/auth-client-reauth.test.ts`:

Follow the `globalThis.fetch` stubbing + `node:test` + `assert/strict` pattern from
`auth-client.test.ts`.

- `reauth() — returns parsed ExtendResponse on 200`
- `reauth() — includes x-csrf-token header from document.cookie`
- `reauth() — omits x-csrf-token header when CSRF cookie is absent (no throw)`
- `reauth() — throws with correct .code on non-2xx response`

**Acceptance criteria:**

- AC-101: `reauth()` resolves with a typed `ExtendResponse` and the CSRF header was sent.
- AC-102: `reauth()` throws an `Error` with `.code` matching `AuthError.code` on non-2xx.
- All four unit tests pass; `npm run quality` passes.

---

### T2 — `useSession` hook

**Files:**

- `apps/web/src/features/auth/hooks/use-session.ts` ← NEW
- `apps/web/src/features/auth/__tests__/use-session.test.ts` ← NEW

**Depends on:** T1 (`reauth` must be available to call from `extend()`)

Create the `useSession` hook that manages the full session lifecycle: initial fetch, periodic
polling, WebSocket subscription, and the `extend` / `logout` / `refresh` actions.

Public surface (must be exactly this shape — FR-105):

```typescript
export interface UseSessionResult {
  session: SessionInfo | null; // null while loading or unauthenticated
  isLoading: boolean; // true only during the initial fetch
  extend: () => Promise<void>; // calls reauth(), updates expiresAt + resets state
  logout: () => Promise<void>; // calls logout(), sets session to null; does NOT navigate
  refresh: () => Promise<void>; // re-fetches getSessionInfo() and updates local state
}

export function useSession(pollIntervalMs?: number): UseSessionResult;
```

Implementation notes:

- **Initial fetch:** Call `getSessionInfo()` on mount. `isLoading` is `true` from mount until the
  initial fetch settles. Set `session` from the result (`null` if `getSessionInfo()` returned
  `null`).
- **Polling (FR-103, NFR-202):** Poll `getSessionInfo()` when `session.state` is `active` or
  `expiring-soon`. Default interval: 60 000 ms. Apply ±5 % randomised jitter to each interval
  calculation (not only on mount). Pause when `document.visibilityState === 'hidden'`; resume on
  `visibilitychange`. Stop polling entirely when `session` is `null` or `session.state` is in
  `TERMINAL_STATES` or `daemon-unreachable`.
- **WebSocket (FR-104, NFR-203):** Open `new WebSocket('/ws')`. Parse incoming messages as
  `SessionEvent`. On `state-change` or `expiry-warning`, update `session.state` to `event.newState`
  immediately. On `forced-logout`, update `session.state` and cease all polling. Reconnect on
  unexpected close (only when state is `active` or `expiring-soon`) using binary exponential
  back-off: 1 s base, 2× per attempt, 30 s cap, ±500 ms random jitter per attempt (NFR-203).
- **Cookie access (NFR-204):** The hook itself does not read cookies directly — `getCsrfToken()` in
  `auth-client.ts` handles that.
- **`extend()` action:** Call `reauth()`. On success, update local `session.expiresAt` to
  `ExtendResponse.newExpiresAt` and set `session.state` to `active` if it was `expiring-soon`.
- **`logout()` action:** Call the `logout()` auth client function. On resolution, set local
  `session` to `null`. Do NOT navigate — navigation is the caller's responsibility (FR-105).
- **`refresh()` action:** Call `getSessionInfo()` and update local `session` state. Used by
  `DaemonUnreachable` to check whether the daemon has recovered.
- **Cleanup (NFR-208):** The effect cleanup function must cancel the polling timer and call
  `ws.close()`. After cleanup, no further state updates may be dispatched.

**Tests required** — `apps/web/src/features/auth/__tests__/use-session.test.ts`:

Use `node:test` + `assert/strict`; mock `globalThis.fetch`, `globalThis.WebSocket`, and
`globalThis.document` as needed.

- `useSession — isLoading is true until initial getSessionInfo settles`
- `useSession — session is populated after initial fetch`
- `useSession — polling fires at configured interval with jitter`
- `useSession — polling pauses when visibilityState becomes hidden`
- `useSession — polling resumes when visibilityState returns to visible`
- `useSession — polling stops when session enters terminal state`
- `useSession — WebSocket state-change frame updates session.state immediately`
- `useSession — forced-logout frame stops polling`
- `useSession — extend() calls reauth() and updates expiresAt and resets state to active`
- `useSession — logout() calls auth-client logout and sets session to null`
- `useSession — cleanup cancels polling timer and closes WebSocket`

**Acceptance criteria:**

- AC-103: `isLoading` is `true` until `getSessionInfo()` resolves; `session` is populated after.
- AC-104: `getSessionInfo()` is called again after the poll interval elapses.
- AC-105: `getSessionInfo()` is NOT called while `visibilityState === 'hidden'`.
- AC-106: `session.state` updates within 250 ms of a WebSocket `state-change` frame.
- AC-107: `forced-logout` frame sets terminal state and stops polling.
- AC-109: `extend()` updates `expiresAt` and resets `state` to `active`.
- AC-110: `logout()` sets `session` to `null`; no navigation occurs.
- AC-120: After unmount, WebSocket is closed and no further events are processed.
- AC-121: No polling timer is active when `session` is `null`.
- All eleven unit tests pass; `npm run quality` passes.

---

### T3 — Session context and `SessionProvider`

**Files:**

- `apps/web/src/features/auth/context/session-context.ts` ← NEW
- `apps/web/src/features/auth/components/session-provider.tsx` ← NEW

**Depends on:** T2 (context wraps the `useSession` result)

Create the React context that exposes session state and actions to any workspace descendant, and
the `SessionProvider` component that drives it.

**`session-context.ts`** — context definition and consumer hook:

- Define `SessionContext` using `React.createContext<UseSessionResult | null>(null)`.
- Export `useSessionContext(): UseSessionResult` — reads the context value and throws a descriptive
  `Error` when called outside a `SessionProvider`:
  ```
  Error: useSessionContext() must be called inside a <SessionProvider>.
  ```
- Do not re-export `SessionProvider` from this file; keep the context module import-cycle-free.

**`session-provider.tsx`** — provider component:

```typescript
interface SessionProviderProps {
  pollInterval?: number; // forwarded to useSession; defaults to 60 000 ms
  children: React.ReactNode;
}

export function SessionProvider({ pollInterval, children }: SessionProviderProps): JSX.Element;
```

- Call `useSession(pollInterval)` and wrap the result in `SessionContext.Provider`.
- The component must not contain any UI of its own — it is a pure context bridge.

**Tests required:**

Browser-spec tests for T3 are delivered in T7 (`session-provider.browser.spec.tsx`). No standalone
unit test file is required for T3 itself.

**Acceptance criteria:**

- AC-108: `useSessionContext()` throws with the missing-provider message when called outside a
  `SessionProvider`.
- `SessionProvider` with `pollInterval={5000}` passes the value through to `useSession`.
- `npm run quality` passes.

---

### T4 — `ExpiryBanner` component

**Files:**

- `apps/web/src/features/auth/components/expiry-banner.tsx` ← NEW
- `apps/web/src/features/auth/__tests__/expiry-banner.browser.spec.tsx` ← NEW

**Depends on:** T3 (`useSessionContext` must be available)

Create the dismissible expiry warning banner. Shown when `session.state === 'expiring-soon'`;
auto-clears on any state transition away from that value.

```typescript
// No props — all data sourced from session context
export function ExpiryBanner(): JSX.Element | null;
```

Implementation notes:

- Call `useSessionContext()` to read `session` and `extend`.
- Maintain a single local `dismissed` boolean state, initialised to `false`. Reset it to `false`
  whenever `session.state` transitions away from `expiring-soon` (use a `useEffect` that watches
  `session?.state`).
- Render `null` when `session?.state !== 'expiring-soon'` or `dismissed === true`.
- When rendered, the outermost element must have: `role="alert"`, `data-testid="expiry-banner"`.
- Include a human-readable warning message communicating the session is about to expire.
- **"Extend Session" button** (`data-testid="extend-session-button"`, `aria-label="Extend Session"`):
  - On click, call `extend()` and track in-flight state locally.
  - Must be `disabled` and show a loading indicator while `extend()` is in flight.
- **Dismiss button** (`data-testid="expiry-banner-dismiss"`, `aria-label="Dismiss"`, visible `×`
  text):
  - On click, set `dismissed = true`. Must NOT call `extend()`.
- Inline `React.CSSProperties` only — no Tailwind, no component library (NFR-206).
- Suggested palette: `background: '#78350f'` (amber-900), `color: '#fef3c7'` (amber-100),
  `border: '1px solid #d97706'` (amber-600) — matches the dark slate aesthetic.

**Tests required** — `apps/web/src/features/auth/__tests__/expiry-banner.browser.spec.tsx`:

Use `vi.mock()` + `render()` + `screen` + `userEvent.setup()` pattern from
`login-form.browser.spec.tsx`. Mock the session context rather than mocking `useSession` directly.

- `ExpiryBanner — not rendered when session.state is active`
- `ExpiryBanner — renders with role="alert" and data-testid when state is expiring-soon`
- `ExpiryBanner — "Extend Session" button calls extend() on click`
- `ExpiryBanner — "Extend Session" button is disabled while extend() is in flight`
- `ExpiryBanner — dismiss button hides banner without calling extend()`
- `ExpiryBanner — banner disappears when session.state transitions away from expiring-soon`
- `ExpiryBanner — banner reappears after page reload (dismiss is local state)`

**Acceptance criteria:**

- AC-111: Element with `data-testid="expiry-banner"` and `role="alert"` present when
  `state === 'expiring-soon'`.
- AC-112: No `data-testid="expiry-banner"` in the DOM for any other state.
- AC-113: Dismiss hides the banner; `extend()` is NOT called.
- AC-114: Banner disappears when `session.state` transitions to any other value.
- All seven browser-spec tests pass; `npm run quality` passes.

---

### T5 — `DaemonUnreachable` component

**Files:**

- `apps/web/src/features/auth/components/daemon-unreachable.tsx` ← NEW
- `apps/web/src/features/auth/__tests__/daemon-unreachable.browser.spec.tsx` ← NEW

**Depends on:** T3 (`useSessionContext` must be available)

Create the full-width error screen shown when the daemon is temporarily unreachable. This screen
must clearly distinguish "daemon down" from "session expired" and offer a manual retry path without
redirecting to `/login`.

```typescript
// No props — data sourced from session context
export function DaemonUnreachable(): JSX.Element | null;
```

Implementation notes:

- Call `useSessionContext()` to read `session` and `refresh`. Render `null` when
  `session?.state !== 'daemon-unreachable'`.
- When rendered:
  - Outermost element: `role="status"`, `data-testid="daemon-unreachable"`, full-width block.
  - Copy must make clear the **Hydra daemon** is temporarily unavailable — NOT that the session
    expired. Example: "Hydra daemon is temporarily unavailable. Your session is still active."
  - **Retry button** (`data-testid="daemon-unreachable-retry"`, `aria-label="Check again"`,
    visible "Check again" text):
    - On click, call `refresh()` from the session context.
    - Track in-flight state locally to disable the button while retrying.
    - The button must remain focusable at all times (do not use `pointer-events: none`).
- Do NOT redirect to `/login` under any circumstances (FR-110, AC-117).
- Inline `React.CSSProperties` only (NFR-206). Suggested palette: `background: '#1e293b'`
  (slate-800), `color: '#f1f5f9'` (slate-100), error accent `'#f87171'` (red-400).

**Tests required** — `apps/web/src/features/auth/__tests__/daemon-unreachable.browser.spec.tsx`:

- `DaemonUnreachable — renders with role="status" and data-testid when state is daemon-unreachable`
- `DaemonUnreachable — not rendered when state is active or expiring-soon`
- `DaemonUnreachable — retry button calls refresh() and updates state on recovery`
- `DaemonUnreachable — retry button is disabled while refresh() is in flight`
- `DaemonUnreachable — retry button has accessible label`
- `DaemonUnreachable — does not redirect to /login`

**Acceptance criteria:**

- AC-116: Element with `data-testid="daemon-unreachable"` and `role="status"` is visible; workspace
  content is not rendered.
- AC-117: No redirect to `/login` occurs for `daemon-unreachable` state.
- AC-118: Retry button triggers `refresh()`; on `active` result, workspace content is restored.
- All six browser-spec tests pass; `npm run quality` passes.

---

### T6 — Workspace wiring (`workspace.tsx` + `LogoutButton`)

**Files:**

- `apps/web/src/features/auth/components/logout-button.tsx` ← NEW
- `apps/web/src/routes/workspace.tsx` ← MODIFY
- `apps/web/src/features/auth/__tests__/logout-button.browser.spec.tsx` ← NEW

**Depends on:** T3 (context required by `LogoutButton`), T4 (`ExpiryBanner` must exist), T5
(`DaemonUnreachable` must exist)

**`logout-button.tsx`** — standalone component:

```typescript
// No props — reads logout() from context; navigation is its own responsibility
export function LogoutButton(): JSX.Element;
```

- Must be a native `<button>` element (NFR-207). Visible text: "Log out".
- `data-testid="logout-button"`.
- On click: call `logout()` from `useSessionContext()`, then navigate to `/login` using TanStack
  Router's `useNavigate()`.
- Must be `disabled` while the `logout()` call is in flight (FR-109).
- Inline styles only (NFR-206).

**`workspace.tsx`** — three integration changes:

1. **`SessionProvider` wrapper (FR-107):** Wrap the entire `WorkspaceRoute` return value in
   `<SessionProvider>`. Do not place `SessionProvider` anywhere above `workspaceRoute` in the tree.
   The `beforeLoad` guard (already in `router.tsx`) remains unchanged for `null` / terminal states
   (FR-111).

2. **Session-conditional rendering (FR-108, FR-110):** Import and render `<DaemonUnreachable />`
   above `<Outlet />` and `<ExpiryBanner />` below the workspace header band and above the main
   content area. Both components render `null` for non-matching states, so no additional conditional
   is needed at the call site.

3. **Logout button in workspace header band (FR-109):** Render a workspace-level header band (a
   `<div>` above `<Outlet />`, inside `SessionProvider`) that contains `<LogoutButton />` on the
   right side. This header band is separate from `AppShell` — do not modify `app-shell.tsx`.

**Tests required** — `apps/web/src/features/auth/__tests__/logout-button.browser.spec.tsx`:

- `LogoutButton — is a native <button> element`
- `LogoutButton — calls logout() from context on click`
- `LogoutButton — navigates to /login after logout() resolves`
- `LogoutButton — is disabled while logout() is in flight`

**Acceptance criteria:**

- AC-115: Activating `data-testid="logout-button"` navigates to `/login` after `logout()` resolves.
- `ExpiryBanner` and `DaemonUnreachable` are reachable within the workspace component tree.
- All four browser-spec tests pass; `npm run quality` passes.
- No boundary violations: `@hydra/web` must not import from `lib/` or `apps/web-gateway/`.

---

### T7 — `SessionProvider` integration browser spec

**Files:**

- `apps/web/src/features/auth/__tests__/session-provider.browser.spec.tsx` ← NEW

**Depends on:** T3 (`SessionProvider` and `useSessionContext` must exist; T4–T6 not required)

Dedicated integration spec verifying that `SessionProvider` correctly propagates session state to
consumers and that the `useSessionContext()` guard fires outside the provider.

Mock `useSession` at the module level (`vi.mock('../hooks/use-session.ts', ...)`) so tests control
the session value directly without wiring `fetch` or WebSocket.

**Tests required:**

- `SessionProvider — useSessionContext() throws with descriptive message outside provider`
- `SessionProvider — useSessionContext() returns session value inside provider`
- `SessionProvider — useSessionContext() returns isLoading=true during initial fetch`
- `SessionProvider — extend() callable from consumer`
- `SessionProvider — logout() callable from consumer`
- `SessionProvider — pollInterval prop is forwarded to useSession`

**Acceptance criteria:**

- AC-108: `useSessionContext()` throws the missing-provider message when called outside a
  `SessionProvider`.
- Consumer components receive the correct `session`, `isLoading`, `extend`, and `logout` values.
- All six browser-spec tests pass; `npm run quality` passes.

---

### T8 — README updates

**Files:**

- `apps/web/README.md` ← MODIFY
- `apps/web-gateway/README.md` ← MODIFY

**Depends on:** T6 (the full session lifecycle must be wired before documenting end-to-end
behaviour)

Document the complete session lifecycle for operators and developers.

Changes to **both** README files:

- Add or update a **Session lifecycle** section covering:
  - The polling mechanism (default 60 s interval, ±5 % jitter, pauses in background tabs).
  - The WebSocket `/ws` subscription for real-time `SessionEvent` frames.
  - The expiry warning: what triggers the banner, how to extend, how to dismiss.
  - The daemon-unreachable state: what it means, how to retry, and that it does NOT redirect to
    `/login`.
  - The logout button: where it appears, that navigation to `/login` happens automatically.

Changes specific to **`apps/web/README.md`**:

- Replace any browser-console `fetch('/auth/login', ...)` workaround text with: "Navigate to
  `http://HOST:PORT/login` in your browser, enter your credentials, and the workspace will open
  automatically."

Changes specific to **`apps/web-gateway/README.md`**:

- Mirror the login-workaround replacement above.
- Add (or verify) a `/auth/reauth` row in the endpoints table.

**Acceptance criteria:**

- A developer reading either README understands the full session lifecycle without consulting the
  spec.
- No references to the browser-console login workaround remain.
- `npm run quality` passes.

---

## Dependency Order

```
T1 (reauth)
└── T2 (use-session)
    └── T3 (session-context + session-provider)
        ├── T4 (expiry-banner)          ┐
        ├── T5 (daemon-unreachable)     ├─ parallelisable after T3
        ├── T7 (session-provider spec)  ┘
        └── T6 (workspace wiring)  ← after T4 + T5
            └── T8 (README)
```

Execution notes:

- T1 and its unit test ship together as a single atomic commit.
- T4, T5, and T7 are fully independent of each other and can be developed in parallel once T3 is
  merged.
- T6 requires T4 and T5 to exist (it imports and renders both components), but does not depend on
  T7 (the spec test).
- T8 must be the final commit; it documents the completed, wired feature.

---

## Test IDs

Every interactive element introduced by this spec carries a `data-testid` attribute:

| Element                   | `data-testid`              |
| ------------------------- | -------------------------- |
| Expiry warning banner     | `expiry-banner`            |
| "Extend Session" button   | `extend-session-button`    |
| Banner dismiss button     | `expiry-banner-dismiss`    |
| Daemon-unreachable screen | `daemon-unreachable`       |
| Retry button              | `daemon-unreachable-retry` |
| Logout button             | `logout-button`            |

---

## Quality Gates

Before the PR is opened:

- `npm run quality` passes (`lint` + `format:check` + `typecheck` + `lint:cycles`) across all
  workspaces.
- `npm test` passes — picks up all unit test files (T1 × 4, T2 × 11).
- `npm --workspace @hydra/web run test:browser` passes — picks up all four `.browser.spec.tsx`
  files (T4, T5, T6, T7).
- No new boundary violations: `@hydra/web` must not import from `lib/` or `apps/web-gateway/`.
- `SessionProvider` is not present in `apps/web/src/app/providers.tsx` or `app-shell.tsx`.
- No `@ts-ignore` or `@ts-expect-error` suppressions without a co-located explanatory comment.
- All `data-testid` attributes listed above are present in the DOM under the correct conditions.
