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
(`${location.host}/ws`) with cookie-based session auth. There is no Vite proxy configured to
forward these requests. In practice this means:

- **Production / integration use** — the built app must be served behind the web-gateway (or an
  equivalent reverse proxy) that places the API, WebSocket, and static assets on the same origin.
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
