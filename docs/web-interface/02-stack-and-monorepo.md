# Stack and Monorepo Strategy

## Language Choice

Choose **TypeScript end-to-end** for the web initiative.

### Why TypeScript over Python

- Hydra already lives in the Node/TypeScript ecosystem.
- Shared schemas and contracts across browser, gateway, and daemon are a major advantage.
- The frontend ecosystem for rich chat-style products is much stronger in TypeScript.
- Tooling for linting, type safety, boundaries, and agent-authored changes is simpler when the
  whole web stack uses one language.
- A Python web stack would add a second runtime and duplicate too much tooling and contract work.

## Frontend Recommendation

Choose **React + TypeScript + Vite** for `apps/web`.

### Why this combination

- React has the strongest ecosystem for complex streaming chat/workspace interfaces.
- TypeScript support is mature and reliable.
- Vite keeps the browser app simple and fast without introducing full-stack framework magic.
- Hydra does not need SEO-oriented or marketing-page server rendering for this product surface.

### Frontend library guidance

Keep the browser stack disciplined and small. The likely direction is:

- React + TypeScript for UI composition;
- TanStack Router for explicit route and layout modeling;
- TanStack Query for non-stream server state;
- a small accessible component layer built on well-audited primitives;
- Zod at runtime boundaries.

## Gateway Recommendation

Choose **Hono + TypeScript** for `apps/web-gateway`.

### Why Hono

- TypeScript-native route and middleware model;
- lightweight enough for a local browser gateway without falling back to raw `node:http`;
- suitable for cookie/session handling, validation, and WebSocket or SSE-adjacent transport needs;
- easier to keep small and auditable than a heavier general-purpose server stack;
- still isolated from the core runtime because it lives in its own workspace.

### Why not raw `node:http`

The daemon can stay minimal on raw Node primitives because it is already established and narrowly
scoped. The browser gateway is a different trust boundary with more security-sensitive concerns:
session cookies, origin checks, rate limiting, CSRF defenses, and browser transport handling.
Using a small framework here reduces handwritten security-critical plumbing.

## Workspace Strategy

The web work should extend the repo without polluting the existing Hydra runtime.

### Recommended layout

```text
/
  apps/
    web/
    web-gateway/
  packages/
    web-contracts/
    web-ui/
    web-test-helpers/
  lib/
  test/
  docs/
    WEB_INTERFACE.md
    web-interface/
```

### Boundary rules

- `lib/` remains the Hydra core runtime.
- `apps/web/` depends on shared contracts and UI packages, not daemon internals.
- `apps/web-gateway/` depends on shared contracts and daemon-facing public APIs, not hidden web-only
  business logic.
- shared contracts belong in `packages/web-contracts`.
- durable orchestration semantics still belong in daemon-owned code.

### Adoption approach

Adopt workspaces **incrementally**.

- Keep the current root `lib/`, `bin/`, `test/`, and `scripts/` structure intact at first.
- Add `apps/web/`, `apps/web-gateway/`, and `packages/web-contracts/` as new workspace members.
- Only consider moving existing Hydra core code into a dedicated workspace later if the benefits are
  proven by actual implementation pressure.

This keeps phase zero focused on enabling the web effort rather than forcing a high-risk repo
restructure before it is necessary.

## Workspace Tooling

Start with **npm workspaces** because Hydra already uses npm. That is the least disruptive path.

If the web initiative grows enough to justify additional orchestration, `turbo` can be added later
as an optimization rather than as a prerequisite.
