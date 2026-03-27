# @hydra/web

Browser-native Hydra chat workspace — React 19, TypeScript, and Vite 8.

## What It Does

This workspace provides a real-time operator interface for the Hydra multi-agent orchestrator.
The key areas are:

- **Chat workspace** — multi-conversation transcript with streaming turn updates, a prompt
  composer, and agent control actions (approve / reject / cancel).
- **Connection state** — transport, sync, session, and daemon status tracking with automatic
  reconnect and operator-visible banners.
- **Artifact inspection** — inline rendering and detail panels for structured artifacts returned by
  agents.
- **Gateway error handling** — typed parsing, category classification, and recovery helpers for
  structured gateway error responses.

## Using the Current Web App

The current browser surface is best understood as a **chat workspace with an operations sidebar**.
It is usable today, but it is still an operator-facing development surface rather than a polished
product walkthrough.

### What exists today

- **Conversation workspace** at `/workspace`
  - conversation list in the left column
  - transcript in the main panel
  - composer for sending new instructions
- **Turn actions**
  - cancel when a turn is cancellable
  - retry / branch for completed or failed turns
  - follow-up on the latest completed turn
- **Artifact inspector**
  - select an artifact from the transcript to open the side panel
  - close the panel to return to the normal transcript/composer flow
- **Connection/session banners**
  - visible status for reconnecting, daemon recovery, expired sessions, and related issues
- **Operations panels (US1–US6, all phases complete)**
  - authoritative queue visibility in the sidebar (work-item ordering, status labels, conversation/session relationship hints)
  - work-item selection with checkpoint detail, routing, and execution panels
  - health, budget, and risk signals with global/item scope separation
  - routing, mode, agent, and council execution history visibility
  - daemon-authorized operational controls (routing/mode/agent/council changes with pending, accepted, rejected, stale, and superseded outcomes)
  - dense multi-agent and council timeline rendering with availability affordances (partial/unavailable states)
  - refresh/reconnect/multi-tab regression-safe operations synchronization
  - operations panel error boundary preserving chat workspace ownership on panel failure
  - `minWidth: 0` grid hardening preventing chat column blowout during operations reflows

### What is not there yet

- no browser-side settings or operator preferences UI
- no end-user product walkthrough

### How to run it

The browser app expects the web gateway and static assets to be served from the **same origin**.

For real use, serve the built frontend behind the gateway (or a reverse proxy in front of both) so
these all share one origin:

- browser assets
- REST routes such as `/conversations/*`, `/approvals/*`, `/artifacts/*`, `/operations/*`
- WebSocket endpoint at `/ws`

Standalone `npm run dev` in `apps/web` is still useful for frontend iteration, but API and WebSocket
behavior will fail unless you provide your own proxy to the gateway.

### Full local stack commands

To run the browser, gateway, and daemon together in a way that supports a real same-origin browser
session:

1. Start the Hydra daemon from the repo root:

   ```bash
   npm start
   ```

2. In a second terminal, build and serve the web app through the gateway on `http://127.0.0.1:4174`:

   ```bash
   HYDRA_WEB_OPERATOR_ID=admin \
   HYDRA_WEB_OPERATOR_SECRET=password123 \
   npm --workspace @hydra/web-gateway run start:with-web
   ```

3. Open `http://127.0.0.1:4174` in your browser.

4. **Log in** — Navigate to `http://127.0.0.1:4174/login` in your browser, enter your
   credentials, and the workspace will open automatically.

   The `HYDRA_WEB_OPERATOR_ID` / `HYDRA_WEB_OPERATOR_SECRET` values seed a local operator
   record on first start — use those same values as your identity and secret on the login screen.

5. Open `http://127.0.0.1:4174/workspace` (or let the index redirect take you there).

Notes:

- The gateway serves the built frontend from `apps/web/dist`, proxies browser API calls to the
  daemon at `http://127.0.0.1:4173`, and owns the WebSocket endpoint at `/ws`.
- The seeded `HYDRA_WEB_OPERATOR_ID` / `HYDRA_WEB_OPERATOR_SECRET` values seed a local operator
  record in `~/.hydra/web-gateway/operators.json` at startup. Use those values as your identity
  and secret on the `/login` screen to create a session.
- **`Gateway 401: No valid session found`** always means no `__session` cookie. Navigate to
  `/login` to create a session.

### Remote host setup

To serve the app from a remote server (e.g., `truenas-2.example.com`):

```bash
HYDRA_WEB_GATEWAY_HOST=0.0.0.0 \
HYDRA_WEB_GATEWAY_ORIGIN=http://truenas-2.example.com:4174 \
HYDRA_DAEMON_URL=http://truenas-2.example.com:4173 \
HYDRA_WEB_OPERATOR_ID=admin \
HYDRA_WEB_OPERATOR_SECRET=password123 \
npm --workspace @hydra/web-gateway run start:with-web
```

Key differences from the local command:

- `HYDRA_WEB_GATEWAY_HOST=0.0.0.0` — bind to all network interfaces (default `127.0.0.1` is
  loopback-only and is not reachable from other machines).
- `HYDRA_WEB_GATEWAY_ORIGIN` — **required for remote use**. Must be the exact scheme, hostname,
  and port that browsers use to reach the gateway. The gateway uses this for origin validation; a
  mismatch rejects all requests.
- Do **not** set `HYDRA_WEB_GATEWAY_HOST` to a remote hostname — it is a bind address, not a
  public URL. Use `0.0.0.0` or a specific local interface IP instead.

After starting, log in from any browser by navigating to
`http://truenas-2.example.com:4174/login`, entering your credentials, and the workspace will
open automatically.

### How to use it in its current state

1. Start the full stack and log in as described in **Full local stack commands** above.
2. The index route redirects to `/workspace`.
3. Use the **Conversations** panel to:
   - pick an existing conversation
   - start a new conversation
4. Use the **Transcript** panel to:
   - read streamed turn output
   - inspect prompts and system/activity entries
   - trigger turn actions when they are available
5. Use the **Composer** panel to send a new instruction.
   - Click **Send**, or press `Ctrl+Enter` / `Cmd+Enter`.
6. If a transcript entry exposes artifacts, open them in the **Artifact Inspector** side panel.
7. Use the **Operations** sidebar to monitor the current work queue and select a work item to
   inspect its checkpoint detail.
   - The panels are read-only in the current phase.
   - They reflect loading, empty, and live states based on the latest snapshot.

### Current operator expectations

- The daemon and gateway remain authoritative.
- The browser is a safe view/edit surface for the delivered chat workflow, not a second control
  plane.
- If connection, session, or daemon health degrades, expect the banner state to explain why the UI
  is limited.

## Source Layout

```
src/
  app/                   # Root shell, providers, and TanStack Router setup
  features/
    chat-workspace/
      api/               # Gateway and stream client modules
      components/        # UI components (transcript, composer, conversation list, etc.)
      model/             # Workspace reducer, store, selectors, and domain types
      render/            # Artifact renderers and safe-text utilities
      __tests__/         # Unit and workflow integration tests
  routes/                # Route components (index redirect → /workspace)
  shared/                # Cross-feature utilities (session state, gateway errors)
  main.tsx               # Application entry point
  test-setup.ts          # Vitest global setup (@testing-library/jest-dom)
```

## Same-Origin Requirement

The workspace uses **same-origin REST** (`baseUrl: ''`) and **same-origin WebSocket**
(`ws(s)://${location.host}/ws`) with cookie-based session auth. There is no Vite proxy configured to
forward these requests. In practice this means:

- **Production / integration use** — the built app must be served by a same-origin static
  host/reverse proxy that fronts the web gateway so the API routes, WebSocket endpoint, and static
  assets all share one origin.
- **Standalone `npm run dev` / `npm run preview`** — useful for frontend iteration (component
  development, styling, routing) but API and WebSocket calls will fail unless you provide your own
  proxy that forwards the gateway routes (`/auth/*`, `/session/*`, `/conversations/*`,
  `/approvals/*`, `/turns/*`, `/artifacts/*`) and `/ws` to the gateway.

## Scripts

Run from the workspace root (`apps/web/`) or via `npm -w @hydra/web`:

| Command                       | Description                                          |
| ----------------------------- | ---------------------------------------------------- |
| `npm run dev`                 | Vite dev server (frontend-only — see above)          |
| `npm run build`               | Production build via Vite                            |
| `npm run preview`             | Preview production build (frontend-only — see above) |
| `npm run test:browser`        | Run Vitest browser specs (single run)                |
| `npm run test:browser:watch`  | Run Vitest in watch mode                             |
| `npm run typecheck:workspace` | TypeScript type-check (no emit)                      |

## Testing

Two distinct test paths exist:

- **Browser specs** (`npm run test:browser` inside `apps/web/`) — Vitest 4 + Testing Library specs
  under `src/`. These cover component rendering, hooks, and browser-level integration.
- **Workspace `.test.ts` suites** — any `*.test.ts` files that live in this package are also picked
  up by the repo-root `npm test` (Node.js native test runner). This is the primary CI validation
  path and the one checked by the pre-push hook.

## Technology Stack

| Layer         | Choice                                                        |
| ------------- | ------------------------------------------------------------- |
| Framework     | React 19 (StrictMode)                                         |
| Bundler       | Vite 8 with `@vitejs/plugin-react`                            |
| Routing       | TanStack Router (type-safe, intent preloading)                |
| State model   | Custom reducer/store for workspace state                      |
| Query layer   | TanStack React Query provider available for REST cache wiring |
| Schema / DTOs | Zod (via `@hydra/web-contracts`)                              |
| Testing       | Vitest 4, Testing Library (React + user-event)                |
| Test env      | jsdom                                                         |

## Workspace Boundaries

`@hydra/web` may import from `@hydra/web-contracts` only. It must **not** import from `lib/`
(Hydra core) or `apps/web-gateway/`. These rules are enforced by ESLint boundary checks.

See [docs/web-interface/07-boundaries-and-governance.md](../../docs/web-interface/07-boundaries-and-governance.md)
for the full boundary rules, ownership, and governance process.
