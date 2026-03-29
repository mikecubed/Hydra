# Contributing to Hydra

Thanks for your interest in contributing! This guide covers the essentials.

## Getting Started

1. **Fork** the repo and clone your fork
2. **Create a feature branch** from `main` (e.g. `feat/my-feature`, `fix/my-bug`)
3. **Install** dependencies: `npm ci`
4. **Test** your changes: `npm test`
5. **Open a PR** targeting `main`

## Branch Rules

- **`main`** — stable branch; all PRs target here
- Feature branches follow the naming convention: `feat/...`, `fix/...`, `docs/...`, `chore/...`

Never commit directly to `main`.

## Code Conventions

- **ESM only** — `import`/`export`, no CommonJS
- **No build step** — pure ESM, runs directly with Node.js 20+
- **Terminal colors** — use `picocolors` (`pc`), never chalk
- **Agent names** — always lowercase: `claude`, `gemini`, `codex`, `local`
- **Tests** — Node.js native `node:test` + `node:assert/strict`
- **Dependencies** — keep them minimal; check with maintainers before adding new ones

## Code Quality & Hooks

Git hooks install automatically when you run `npm install` or `npm ci` (via the `prepare` script). They enforce quality on every commit and push:

- **`pre-commit`** — runs lint-staged: auto-fixes ESLint + Prettier on staged `.ts/.tsx/.mjs` files; validates Mermaid blocks and formats staged `.md` files; auto-formats staged `.json/.yml/.yaml` files. Fixes are staged automatically.
- **`pre-push`** — runs the full test suite (`npm test`). Push is blocked if any tests fail.

Run the full quality check manually before opening a PR:

```bash
npm run quality       # lint + format check + typecheck (no auto-fix)
npm run lint:fix      # ESLint with auto-fix
npm run lint:mermaid  # Validate Mermaid code fences in tracked Markdown
npm run format        # Prettier format all files
npm run typecheck     # TypeScript --checkJs
```

Use `npm run setup:hooks` to manually reinstall hooks if needed (e.g. after a fresh clone without `npm install`).

## Running Tests

```bash
npm test                              # all tests
node --test test/hydra-ui.test.mjs    # single file
```

## PR Checklist

- [ ] `npm run quality` passes (lint, format, typecheck)
- [ ] Tests pass (`npm test`)
- [ ] Docs updated if you changed architecture, commands, or exports
- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)
- [ ] No secrets or personal paths in committed files
- [ ] Commits are focused and have clear messages

## Web Interface — Contributor Verification

The web initiative lives in three workspace packages (`apps/web`, `apps/web-gateway`,
`packages/web-contracts`). If your change touches any of these, run the verification sequence below
before opening a PR.

### Quick verification sequence

```bash
# 1. Quality gates (lint + format + typecheck + cycle detection + web typecheck)
npm run quality

# 2. Full test suite (core + web-gateway + browser component tests)
npm test

# 3. Packaging evidence (dry-run tarball manifest + packaging integration tests)
npm run package:evidence
```

All three must pass before a web-interface PR is ready for review.

### Running the web stack locally

The browser app requires the daemon and gateway running together. From the repo root:

```bash
# Terminal 1 — start the daemon
npm start

# Terminal 2 — build the browser bundle and start the gateway
HYDRA_WEB_OPERATOR_ID=admin \
HYDRA_WEB_OPERATOR_SECRET=password123 \
npm --workspace @hydra/web-gateway run start:with-web
```

Open `http://127.0.0.1:4174/login` to verify the workspace loads. If the browser bundle is already
built, use `npm --workspace @hydra/web-gateway run start` to skip the rebuild.

For packaged-runtime testing (npm tarball), start `node dist/web-runtime/server.js` instead of the
workspace gateway command. The `dist/web-runtime/` directory is created by `npm pack` (via
`prepack`).

### Troubleshooting

- **Gateway won't start / port 4174 already in use** — kill any existing gateway process and retry.
  The gateway binds to port 4174 by default.
- **`dist/web-runtime/` missing** — run `npm pack` from the repo root. The `prepack` script builds
  the browser bundle and assembles the packaged runtime directory.
- **Browser tests fail with `vitest` errors** — ensure workspace dependencies are installed:
  `npm ci` from the repo root installs all workspace packages.
- **ESLint boundary violations** — web packages must not import from `lib/` directly. Shared types
  go through `packages/web-contracts`. See
  [`docs/web-interface/07-boundaries-and-governance.md`](docs/web-interface/07-boundaries-and-governance.md).
- **Typecheck errors in `apps/web`** — run
  `npm --workspace @hydra/web run typecheck:workspace` to isolate web-specific type issues.
- **Standalone exe does not include the web interface** — this is intentional. The standalone
  executable is CLI-only; web support is available via source checkout and npm package only.
- **Mermaid diagram validation failures** — run `npm run lint:mermaid` to check Mermaid code fences
  in Markdown files before committing.

## Questions?

Open an issue or start a discussion — we're happy to help.
