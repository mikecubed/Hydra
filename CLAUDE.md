# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branch Workflow

Always work on `dev`. Never commit to or switch to `master` unless explicitly told (e.g. "merge to master", "push d>m").

## Commands

```bash
npm test                    # Run all tests (Node.js native test runner)
node --test test/hydra-ui.test.mjs  # Run a single test file
npm start                   # Start the daemon (port 4173)
npm run go                  # Launch operator console (interactive REPL)
npm run council -- prompt="..." # Run council deliberation
npm run evolve              # Run autonomous self-improvement
npm run nightly             # Run nightly task automation
```

No linter or build step — pure ESM, runs directly with Node.js.

## Architecture

Hydra orchestrates three AI coding agents (Claude Code CLI, Gemini CLI, Codex CLI) through a shared HTTP daemon with task queue, intelligent routing, and multiple dispatch modes.

### Core Flow

```
Operator Console (REPL)
    ├── Concierge (multi-provider streaming: OpenAI → Anthropic → Google fallback)
    └── Daemon (HTTP API, port 4173, event-sourced state)
         ├── Gemini  (analyst role, gemini-2.5-pro)
         ├── Codex   (implementer role, gpt-5.3)
         └── Claude  (architect role, claude-opus-4-6)
```

### Key Modules

- **`hydra-operator.mjs`** — Interactive command center. 5 orchestration modes (auto, council, dispatch, smart, chat). Manages workers, status bar, concierge, model switching. This is the largest module (~115KB).
- **`orchestrator-daemon.mjs`** — HTTP server with event-sourced state. Routes split into `daemon/read-routes.mjs` and `daemon/write-routes.mjs`. Handles task lifecycle, handoffs, sessions, worktrees.
- **`hydra-agents.mjs`** — Agent registry. Each agent has CLI commands, invoke modes (interactive/nonInteractive/headless), task affinities, council roles. Contains `getActiveModel()`, task classification, best-agent routing.
- **`hydra-config.mjs`** — Central config with `HYDRA_ROOT`, project detection, `loadHydraConfig()`/`saveHydraConfig()`, `getRoleConfig(roleName)`. Config file: `hydra.config.json`.
- **`hydra-council.mjs`** — 4-phase deliberation: propose (Claude) → critique (Gemini) → refine (Claude) → implement (Codex).
- **`hydra-evolve.mjs`** — 7-phase autonomous improvement rounds with budget tracking, investigator self-healing, and knowledge accumulation.
- **`hydra-concierge.mjs`** — Multi-provider conversational front-end (OpenAI → Anthropic → Google fallback chain). Detects `[DISPATCH]` intent to escalate. Enriched system prompt with git info, recent completions, active workers. Bidirectional daemon communication via `POST /events/push`. Exports `getActiveProvider()`, `getConciergeModelLabel()`, `switchConciergeModel()`, `exportConversation()`, `getRecentContext()`.
- **`hydra-concierge-providers.mjs`** — Provider abstraction layer. `detectAvailableProviders()`, `buildFallbackChain()`, `streamWithFallback()`. Lazy-loads provider modules via `await import()`.
- **`hydra-anthropic.mjs`** — Streaming client for Anthropic Messages API. Mirrors `hydra-openai.mjs` pattern.
- **`hydra-google.mjs`** — Streaming client for Google Gemini Generative Language API.
- **`hydra-worker.mjs`** — `AgentWorker` class (EventEmitter). Headless background agent execution with claim→execute→report loop.
- **`hydra-ui.mjs`** — All terminal rendering. Uses `picocolors` (`pc`) exclusively — never chalk. Exports `AGENT_COLORS`, `AGENT_ICONS`, `stripAnsi`, formatters.
- **`hydra-statusbar.mjs`** — 5-line persistent ANSI footer. SSE event streaming preferred, polling fallback.
- **`hydra-openai.mjs`** — Shared `streamCompletion()` for OpenAI API. Callers must always pass `cfg.model`.
- **`hydra-sub-agents.mjs`** — Built-in virtual sub-agent definitions (security-reviewer, test-writer, doc-generator, researcher, evolve-researcher). Registered at startup via `registerBuiltInSubAgents()`.
- **`hydra-env.mjs`** — Minimal `.env` loader. Auto-loads on import. Real env vars take priority.

### Dispatch Modes

1. **Auto** — Classifies prompt complexity → fast-path simple tasks, mini-round triage for complex
2. **Council** — Full multi-round deliberation across agents
3. **Dispatch** — Sequential pipeline: Claude → Gemini → Codex
4. **Smart** — Auto-selects model tier (economy/balanced/performance) per prompt
5. **Chat** — Concierge conversational layer, escalates with `!` prefix or `[DISPATCH]` intent

### Task Routing

10 task types (planning, architecture, review, refactor, implementation, analysis, testing, security, research, documentation) × 3 physical agents + 5 virtual sub-agents with affinity scores. `classifyTask()` in hydra-agents.mjs selects the optimal agent. Virtual sub-agents (e.g. `security-reviewer`) resolve to their base physical agent for CLI dispatch via `resolvePhysicalAgent()`.

## Code Conventions

- **ESM only** (`"type": "module"` in package.json). All files use `import`/`export`.
- **Single dependency**: `picocolors` for terminal colors. Everything else is pure Node.js.
- **Agent names** are always lowercase strings: `claude`, `gemini`, `codex`.
- **HTTP helpers**: Use `request()` from `hydra-utils.mjs` for daemon calls. Status bar uses `fetch()` directly (lightweight polling).
- **Config access**: `loadHydraConfig()` returns cached config. `getRoleConfig(roleName)` for role-specific model/agent lookups.
- **Model references**: Config-driven via `roles` and `models` sections in `hydra-config.mjs`. Don't hardcode model IDs — use `getActiveModel(agent)` or `getRoleConfig(role)`.
- **Interactive prompts**: Use `promptChoice()` from `hydra-prompt-choice.mjs` with cooperative readline lock.
- **PowerShell launchers** in `bin/` — `hydra.ps1` starts the full system (daemon + agent heads + operator).

## Test Patterns

Tests use Node.js native `node:test` module with `node:assert`. No external test framework.

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
```

Integration tests (`*.integration.test.mjs`) spin up the daemon on an ephemeral port and test HTTP endpoints.
