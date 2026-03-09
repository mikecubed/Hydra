# Hydra — Copilot Agent Instructions

> This file helps AI coding agents work efficiently in this repository from first contact.

## What Is Hydra?

Hydra is a **multi-agent AI orchestrator** that routes prompts to the right AI coding agent (Claude Code, Gemini CLI, Codex CLI) or orchestrates all three together through a shared HTTP daemon with task queue, intelligent routing, and multi-round deliberation.

```
Operator Console (REPL)
    ├── Concierge (multi-provider streaming: OpenAI → Anthropic → Google fallback)
    └── Daemon (HTTP API, port 4173, event-sourced state)
         ├── Gemini  (analyst role)
         ├── Codex   (implementer role)
         └── Claude  (architect role)
```

---

## Critical Rules — Read First

1. **Always work on a feature branch**, never commit directly to `main`. All changes go through pull requests targeting `main`.
2. **ESM only** — all files use `import`/`export`. Never use `require()` or CommonJS.
3. **No build step** — pure ESM, runs directly with `node`. No compilation needed.
4. **Quality gates must pass** — ESLint, Prettier, and TypeScript type-check run on every PR. Run `npm run quality` before pushing.
5. **Git hooks install automatically** via the `prepare` script when you run `npm install`. `pre-commit` runs lint-staged (auto-fixes ESLint + Prettier on staged `.mjs` files, auto-formats `.json/.md/.yml`); `pre-push` runs the full test suite and blocks the push on failure. Use `npm run setup:hooks` only to manually reinstall or verify hooks.
6. **Update docs before committing** — see [Documentation Requirements](#documentation-requirements).
7. **Agent names are always lowercase strings**: `claude`, `gemini`, `codex`, `local`.

---

## Repository Layout

```
lib/                    # All source modules (ESM .mjs)
  hydra-operator.mjs    # Interactive console / main entry point (~115KB, largest)
  orchestrator-daemon.mjs  # HTTP daemon, event-sourced state
  hydra-config.mjs      # Config loading, caching, role lookups
  hydra-agents.mjs      # Agent plugin registry (data-driven agent definitions)
  hydra-shared/         # Shared utilities (agent-executor.mjs is the core runner)
  hydra-ui.mjs          # Terminal UI, color helpers, isTruecolor export
  hydra-utils.mjs       # HTTP request() helper for daemon calls
  hydra-council.mjs     # Multi-round deliberation pipeline
  hydra-dispatch.mjs    # Headless task dispatch
  hydra-context.mjs     # Hierarchical HYDRA.md context injection
  hydra-intent-gate.mjs # Pre-dispatch prompt pre-screening
  hydra-env.mjs         # Minimal .env loader (imported early in entrypoints)
  ...                   # Many more — see docs/ARCHITECTURE.md for full reference
bin/                    # CLI entry points and PowerShell launchers
test/                   # Tests (Node.js native test runner)
docs/                   # Architecture, usage, install guides
scripts/                # Dev utilities (setup-hooks.mjs, build-exe.mjs, etc.)
.husky/                 # Git hooks (pre-commit: lint-staged; pre-push: npm test)
eslint.config.mjs       # ESLint flat config (strict rules + unicorn + node plugins)
.prettierrc.json        # Prettier config (singleQuote, trailingComma all, printWidth 100, LF)
jsconfig.json           # TypeScript --checkJs config for lib/, bin/, scripts/
hydra.config.json       # Primary runtime configuration
.env.example            # Template for environment variables
```

---

## Commands

```bash
# Testing
npm test                    # Run all tests (Node.js native test runner)
node --test test/<file>.mjs # Run a single test file

# Code quality (run before pushing)
npm run lint                # ESLint on entire codebase
npm run lint:fix            # ESLint with auto-fix
npm run format              # Prettier — format all files
npm run format:check        # Prettier — check only (no write)
npm run typecheck           # tsc --noEmit type check (jsconfig.json)
npm run quality             # lint + format:check + typecheck combined

# Git hooks (install once after cloning)
npm run setup:hooks         # Install/verify pre-commit and pre-push hooks

# Runtime
npm start                   # Start the daemon (port 4173)
npm run go                  # Launch operator console (interactive REPL)
npm run council -- prompt="..." # Run council deliberation
npm run evolve              # Run autonomous self-improvement
npm run tasks               # Scan & execute TODO/FIXME/issues autonomously
npm run tasks:review        # Interactive merge of tasks/* branches
npm run tasks:clean         # Delete all tasks/* branches
npm run eval                # Run routing evaluation against golden corpus
npm run setup               # Register Hydra MCP server in all detected AI CLIs
npm run init                # Generate HYDRA.md in current project
npm run nightly             # Run nightly task automation
```

---

## Code Conventions

### Language and Modules

- **ESM only** — `"type": "module"` in `package.json`. Every file is `.mjs`.
- No TypeScript source files. No compile step. Code is plain JavaScript checked by `tsc --checkJs`.
- `jsconfig.json` + `tsc --checkJs` for type checking on `lib/`, `bin/`, and `scripts/`.

### Code Quality Toolchain

The project uses a full quality toolchain. **Always run `npm run quality` before pushing.**

| Tool               | Config file         | What it enforces                                                                                    |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------- |
| **ESLint v10**     | `eslint.config.mjs` | `no-var`, `prefer-const`, `eqeqeq`, `no-eval`, `node:` protocol prefix, unicorn best-practice rules |
| **Prettier**       | `.prettierrc.json`  | `singleQuote`, `trailingComma: all`, `printWidth: 100`, LF line endings                             |
| **TypeScript tsc** | `jsconfig.json`     | `--checkJs` strict type checking across `lib/`, `bin/`, `scripts/`                                  |

**Git hooks (Husky v9 + lint-staged):**

- `pre-commit` — runs lint-staged: ESLint `--fix` + Prettier auto-write on staged `.mjs` files; Prettier auto-write on staged `.json/.md/.yml`. Fixes are staged automatically.
- `pre-push` — runs the full `npm test` suite. Push is blocked if tests fail.
- Hooks install automatically via `npm install` (the `prepare` script). Use `npm run setup:hooks` to manually reinstall or verify.
- CI disables hooks with `HUSKY=0` during `npm ci`.

### Dependencies

Keep dependencies minimal. The four production dependencies are:

- `picocolors` — terminal colors. **Always use `picocolors` (`pc`), never `chalk`.**
- `cross-spawn` — cross-platform process spawning. **Use for all external CLIs.**
- `@modelcontextprotocol/sdk` — MCP server/tools
- `zod` — schema validation for MCP tools

Optional peer: `@opentelemetry/api` (tracing, gracefully no-ops when absent).

### Terminal Colors

```js
import pc from 'picocolors';
console.log(pc.green('Success'));
```

### Spawning External Processes

```js
import spawn from 'cross-spawn'; // default import
```

Use `cross-spawn` for external CLIs — it handles Windows `.cmd`/`.bat` shims without needing `shell: true`.

### Config Access

```js
import { loadHydraConfig, getRoleConfig, getActiveModel } from './hydra-config.mjs';
const config = await loadHydraConfig(); // cached
const model = getActiveModel('claude'); // never hardcode model IDs
```

### HTTP Daemon Calls

```js
import { request } from './hydra-utils.mjs';
const result = await request('POST', '/task/submit', payload);
```

The status bar uses `fetch()` directly for lightweight polling, but all other daemon calls go through `request()`.

### Prompt/Interactive UI

Use `promptChoice()` from `hydra-prompt-choice.mjs` with the cooperative readline lock. Boxes dynamically size to terminal width (60-120 columns).

### Agent Plugin System

Agent behavior is **data-driven** via plugin fields in `hydra-agents.mjs`:

- `features`, `parseOutput`, `modelBelongsTo`, `quotaVerify`, `economyModel`, `readInstructions`, `taskRules`
- Defaults are applied by `registerAgent()` and consumed by `lib/hydra-shared/agent-executor.mjs`.
- Never hardcode per-agent logic outside the plugin definition.

### Truecolor Detection

```js
import { isTruecolor } from './hydra-ui.mjs'; // centralized boolean
```

### Environment Variables

`lib/hydra-env.mjs` is the minimal `.env` loader. Entrypoints (`hydra-operator.mjs`, `orchestrator-daemon.mjs`) import it early before reading config.

---

## Testing

### Framework

Node.js native `node:test` + `node:assert/strict`. No external test framework.

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
```

### Test Types

- **Unit tests** — `test/hydra-*.test.mjs` — import and test module functions directly
- **Integration tests** — `test/*.integration.test.mjs` — spin up the daemon on an ephemeral port and test HTTP endpoints

### Config Override in Tests

```js
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.mjs';
// Override config in-memory for a test:
_setTestConfig({ routing: { mode: 'economy' } });
// Reset after test:
invalidateConfigCache();
```

### Running Tests

```bash
npm test                                    # all tests
node --test test/hydra-ui.test.mjs          # single file
node --test test/hydra-agent-executor.test.mjs test/hydra-agents-plugin.test.mjs  # multiple files
```

---

## Documentation Requirements

Before every commit, update affected docs:

| Changed area                                   | Docs to update                                        |
| ---------------------------------------------- | ----------------------------------------------------- |
| Architecture, modules, dispatch logic, exports | `docs/ARCHITECTURE.md`                                |
| Workflow, commands, conventions                | `CLAUDE.md`                                           |
| User-facing features, setup, operator commands | `README.md` (especially **Operator Commands** table)  |
| Complex logic                                  | Inline comments (only where logic isn't self-evident) |

Skip doc updates only for purely cosmetic changes with zero doc impact.

---

## Configuration (`hydra.config.json`)

Key sections:

```json
{
  "mode": "auto|smart|council|dispatch|chat",
  "models": { "claude": { "default": "...", "fast": "...", "cheap": "...", "active": "default" } },
  "routing": { "mode": "economy|balanced|performance", "intentGate": {}, "worktreeIsolation": {} },
  "agents": { "customAgents": [] },
  "usage": { "dailyTokenBudget": {}, "weeklyTokenBudget": {} },
  "roles": {},
  "context": { "hierarchical": { "enabled": true } }
}
```

- `routing.mode` — shifts agent affinity (`economy` favors `local`, `performance` favors flagship models)
- `routing.worktreeIsolation.enabled` — defaults to `false`; enables per-task git worktrees
- Model IDs are config-driven — always use `getActiveModel(agent)` or `getRoleConfig(role)`, never hardcode

---

## CI / GitHub Actions

Three workflows:

- **`ci.yml`** — syntax check (`node --check`) + full test matrix (Ubuntu + Windows, Node 20 + 22). PRs must pass before merge.
- **`quality.yml`** — ESLint, Prettier, TypeScript type-check, and PR title enforcement (conventional commits). Runs on PRs to `main` (changed files only) and on pushes to `main`/`dev`/`fix/**`/`feat/**`/`feature/**` (full codebase). ESLint full-codebase check uses `continue-on-error` until a clean baseline is reached.
- **`build-windows-exe.yml`** — builds standalone Windows executable; triggered on version tags or `workflow_dispatch`.

All CI workflows set `HUSKY=0` to skip git hooks during `npm ci`, and use `permissions: {}` (deny-all) at the workflow level with per-job grants.

---

## Security Notes

- Verification commands execute via system shell (`exec`/`spawn`). `resolveVerificationPlan()` in `hydra-verification.mjs` determines the command and can disable unsafe config commands.
- Never commit secrets, API keys, or personal paths.
- `.env` files are gitignored (see `.env.example` for the template).
- `SECURITY.md` describes the responsible disclosure process.

---

## Common Pitfalls

| Mistake                                       | Correct approach                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Using `require()` or `.js` extensions         | Use `import`/`export` and `.mjs` extensions                                                                      |
| Importing `chalk`                             | Use `picocolors` (`import pc from 'picocolors'`)                                                                 |
| Hardcoding model IDs like `"claude-opus-4-6"` | Use `getActiveModel('claude')` or config lookups                                                                 |
| Using `child_process.spawn` for CLIs          | Use `cross-spawn` default import                                                                                 |
| Committing directly to `main`                 | Always use a feature branch and open a PR targeting `main`                                                       |
| Making daemon HTTP calls with raw `fetch`     | Use `request()` from `hydra-utils.mjs`                                                                           |
| Adding new dependencies without discussion    | Keep deps minimal; check with maintainers                                                                        |
| Pushing without running quality checks        | Run `npm run quality` before pushing; `pre-commit` auto-fixes lint+format on staged files; `pre-push` runs tests |
| Skipping lint on staged files                 | The `pre-commit` hook auto-fixes ESLint + Prettier on staged `.mjs` files via lint-staged                        |

---

## Key Files for Common Tasks

| Task                                | Primary file(s)                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Add/modify operator console command | `lib/hydra-operator.mjs`                                                                   |
| Add/modify daemon HTTP endpoint     | `lib/orchestrator-daemon.mjs`, `lib/daemon/read-routes.mjs`, `lib/daemon/write-routes.mjs` |
| Add/modify agent behavior           | `lib/hydra-agents.mjs` (plugin definition) + `lib/hydra-shared/agent-executor.mjs`         |
| Change routing logic                | `lib/hydra-dispatch.mjs`, `lib/hydra-intent-gate.mjs`                                      |
| Add config option                   | `lib/hydra-config.mjs` (add to schema + loader)                                            |
| Add MCP tool/resource               | `lib/hydra-mcp-server.mjs`                                                                 |
| Modify council deliberation         | `lib/hydra-council.mjs`                                                                    |
| Add custom agent preset             | `lib/hydra-agents-wizard.mjs` + `hydra.config.json`                                        |
