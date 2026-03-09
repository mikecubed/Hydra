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

- **`pre-commit`** — runs lint-staged: auto-fixes ESLint + Prettier on staged `.mjs` files; auto-formats staged `.json/.md/.yml/.yaml` files. Fixes are staged automatically.
- **`pre-push`** — runs the full test suite (`npm test`). Push is blocked if any tests fail.

Run the full quality check manually before opening a PR:

```bash
npm run quality       # lint + format check + typecheck (no auto-fix)
npm run lint:fix      # ESLint with auto-fix
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

## Questions?

Open an issue or start a discussion — we're happy to help.
