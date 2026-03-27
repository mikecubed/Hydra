# Login Page — Implementation Task List

> **SDD slice:** `web-session-auth` (login sub-slice)
> **Status:** Planned — not yet started
> **Branch convention:** `feat/web-session-auth-login`

The gateway auth backend is fully implemented (session cookies, `POST /auth/login`,
`GET /session/info`, contracts in `@hydra/web-contracts`). This task list covers the
browser-side work only.

---

## Background

The web workspace currently has no login screen. Users see `Gateway 401: No valid session found`
when they navigate to `/workspace` because no `__session` cookie exists. A manual browser-console
fetch to `POST /auth/login` is the only current workaround.

See [06-phases-and-sdd.md](06-phases-and-sdd.md) — this is the first deliverable slice of
**Phase 1 / `web-session-auth`**.

---

## What the Backend Already Provides

| Endpoint            | Description                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /auth/login`  | Body `{ identity, secret }` → sets `__session` (HttpOnly) + `__csrf` cookies; returns `LoginResponse` |
| `GET /session/info` | Returns `SessionInfo` if session valid; `401 SESSION_NOT_FOUND` if not                                |
| `POST /auth/logout` | Clears cookies; returns `{ success: true }`                                                           |
| `POST /auth/reauth` | Re-authenticates an existing session (extend after idle warning)                                      |

Contracts in `@hydra/web-contracts`:

- `LoginRequest` — `{ identity: string, secret: string }`
- `LoginResponse` — `{ operatorId, expiresAt, state: SessionState }`
- `SessionInfo` — `{ operatorId, state, expiresAt, lastActivityAt, createdAt }`
- `SessionState` — `'active' | 'expiring-soon' | 'expired' | 'invalidated' | 'logged-out' | 'daemon-unreachable'`

---

## Files to Create / Modify

```
apps/web/src/
  features/auth/
    api/
      auth-client.ts                     ← NEW
    components/
      login-form.tsx                     ← NEW
    __tests__/
      auth-client.test.ts                ← NEW
      login-form.browser.spec.tsx        ← NEW
  routes/
    login.tsx                            ← NEW
  app/
    router.tsx                           ← MODIFY
apps/web/README.md                       ← MODIFY
apps/web-gateway/README.md               ← MODIFY
```

---

## Tasks

### T1 — Auth API client

**File:** `apps/web/src/features/auth/api/auth-client.ts`

Create three exported async functions:

```typescript
login(identity: string, secret: string): Promise<LoginResponse>
getSessionInfo(): Promise<SessionInfo | null>   // null on 401
logout(): Promise<void>
```

Implementation notes:

- Use `fetch` with `credentials: 'include'` on all calls.
- Import `LoginRequest`, `LoginResponse`, `SessionInfo` from `@hydra/web-contracts`.
- `login()` — `POST /auth/login` with `JSON.stringify({ identity, secret })`. Parse response
  with `LoginResponse.parse()`. Throw a typed error on non-2xx (include `code` and `message`
  from the JSON body).
- `getSessionInfo()` — `GET /session/info`. Return `null` on `401`. Parse response with
  `SessionInfo.parse()` on success.
- `logout()` — `POST /auth/logout` with `credentials: 'include'`. Read the `__csrf` cookie and
  send its value as the `x-csrf-token` header (required for browser calls where an `Origin` header
  is present — the gateway enforces double-submit CSRF on all mutating routes). Swallow errors
  gracefully.

---

### T2 — Login form component

**File:** `apps/web/src/features/auth/components/login-form.tsx`

Props:

```typescript
interface LoginFormProps {
  onSuccess: (operatorId: string) => void;
}
```

Behaviour:

- Two controlled inputs: identity and secret (type `password` for the secret field).
- Submit button disabled while `loading === true`.
- On submit: call `login()` from auth-client, call `onSuccess(operatorId)` on success, display
  error message on failure.
- Error display: map known `code` values to human messages:
  - `INVALID_CREDENTIALS` → "Invalid identity or password."
  - `ACCOUNT_LOCKED` → "Account locked — try again in a few minutes."
  - `RATE_LIMITED` → "Too many attempts — please wait before trying again."
  - fallback → use the error's `message` field.

Styling:

- Inline `React.CSSProperties` — no Tailwind, no component library.
- Dark slate palette matching the rest of the app:
  - Background: `#0f172a` / `rgba(15, 23, 42, 0.85)`
  - Input background: `rgba(30, 41, 59, 0.8)`
  - Border: `rgba(148, 163, 184, 0.2)`
  - Text: `#e2e8f0`
  - Button: `#3b82f6` (blue-500), disabled: `rgba(59, 130, 246, 0.4)`
  - Error text: `#f87171` (red-400)

`data-testid` attributes required on:

- Form element: `login-form`
- Identity input: `login-identity`
- Secret input: `login-secret`
- Submit button: `login-submit`
- Error container (when visible): `login-error`

---

### T3 — Login route component

**File:** `apps/web/src/routes/login.tsx`

Behaviour:

- On mount: call `getSessionInfo()`. If it returns a non-null `SessionInfo` with a non-terminal
  state, navigate immediately to `/workspace` (or `?redirectTo` search param value).
- Render `LoginForm` centred on the page.
- `onSuccess` handler: navigate to the `redirectTo` search param if present and same-origin,
  otherwise navigate to `/workspace`.

---

### T4 — Router: `/login` route + session guard

**File:** `apps/web/src/app/router.tsx`

Changes:

1. Import `LoginRoute` from `../routes/login.tsx`.
2. Import `getSessionInfo` from `../features/auth/api/auth-client.ts`.
3. Add a `loginRoute` at path `'login'`.
4. Add `beforeLoad` on the existing `workspaceRoute`:
   ```typescript
   beforeLoad: async () => {
     const session = await getSessionInfo();
     if (session == null) throw redirect({ to: '/login' });
   },
   ```
5. Update the `indexRoute` component to redirect to `/login` instead of `/workspace`
   (the workspace `beforeLoad` will forward authenticated users onward).

---

### T5 — Unit tests for auth-client

**File:** `apps/web/src/features/auth/__tests__/auth-client.test.ts`

Use `vi.fn()` / `vi.stubGlobal('fetch', ...)` pattern. Test cases:

- `login()` sends `POST /auth/login` with correct JSON body and `credentials: 'include'`
- `login()` returns parsed `LoginResponse` on 200
- `login()` throws with `code: 'INVALID_CREDENTIALS'` on 401
- `login()` throws with `code: 'RATE_LIMITED'` on 429
- `getSessionInfo()` returns `SessionInfo` on 200
- `getSessionInfo()` returns `null` on 401
- `logout()` sends `POST /auth/logout` with `credentials: 'include'` and the `x-csrf-token` header
- `logout()` resolves without throwing even when server returns 500

---

### T6 — Browser spec for login form

**File:** `apps/web/src/features/auth/__tests__/login-form.browser.spec.tsx`

Use `@testing-library/react` + `userEvent`. Test cases:

- Renders identity input, secret input, and submit button
- Submit is disabled while `loading` is true (mock `login` to return a never-resolving promise)
- Calls `login(identity, secret)` with values from the inputs on submit
- Calls `onSuccess(operatorId)` after successful login
- Displays error message when `login()` rejects with `INVALID_CREDENTIALS`
- Displays error message when `login()` rejects with `RATE_LIMITED`
- Clears the error message on the next submit attempt

---

### T7 — README updates

**Files:** `apps/web/README.md`, `apps/web-gateway/README.md`

- Replace the browser-console `fetch('/auth/login', ...)` workaround in both local and remote
  host sections with: "Navigate to `http://HOST:PORT/login` in your browser, enter your
  credentials, and the workspace will open automatically."
- Remove the `data-testid`-based login step from the "How to use" section.
- Keep the `HYDRA_WEB_OPERATOR_ID` / `HYDRA_WEB_OPERATOR_SECRET` notes — they still seed the
  operator record.

---

## Dependency Order

```
T1
├── T2 → T3 → T4
├── T5
└── T6 (via T2)
         T7 (after T3 + T4)
```

T1 and T5 can start in parallel with T2 and T6 once T1 is done.
T3 requires T1 + T2. T4 requires T1 + T3. T7 requires T3 + T4.

---

## Quality Gates

Before the PR is opened:

- `npm run quality` passes (lint + format:check + typecheck + lint:cycles)
- `npm --workspace @hydra/web run test:browser` passes (T6 browser spec)
- `npm test` passes (T5 unit tests picked up by root runner)
- No new boundary violations (`@hydra/web` must not import from `lib/` or `apps/web-gateway/`)
