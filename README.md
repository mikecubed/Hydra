# Hydra

[![CI](https://github.com/PrimeLocus/Hydra/actions/workflows/ci.yml/badge.svg)](https://github.com/PrimeLocus/Hydra/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Multi-Agent AI Orchestrator** — route your prompts to the right agent, or orchestrate all three together.

> **Status:** Active development. APIs may change between releases.

---

## Table of Contents

- [What Is Hydra?](#what-is-hydra)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Features](#features)
- [Essential Commands](#essential-commands)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Documentation](#documentation)
- [Security](#daemon-security)
- [License](#license)

---

## What Is Hydra?

```
   \ | //
    \\|//
   _\\|//_
  |  \|/  |
  |  /|\  |
  \_/ | \_/
    |   |
    |___|

  H Y D R A
```

Each AI coding agent has a distinct strength: Claude architects, Gemini analyzes, Codex implements. Running them separately means picking one perspective per task.

Hydra routes your prompt to the right agent — or orchestrates all three — through a shared daemon with intelligent dispatch, headless workers, and autonomous pipelines. One interface, every perspective.

Coordinates [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Codex CLI](https://github.com/openai/codex), and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through an event-sourced HTTP daemon with task queue, intelligent routing, and multi-round deliberation.

## Quick Start

**Requirements:** Node.js 20+, at least one AI CLI installed ([`gemini`](https://github.com/google-gemini/gemini-cli), [`codex`](https://github.com/openai/codex), or [`claude`](https://docs.anthropic.com/en/docs/claude-code))

```bash
# 1. Install
git clone https://github.com/PrimeLocus/Hydra.git && cd Hydra && npm install

# 2. Launch
npm run go             # operator console (no daemon required)
npm start              # daemon only
pwsh ./bin/hydra.ps1   # Windows: daemon + agent heads + operator

# 3. Register with your AI CLIs (one-time)
node lib/hydra-setup.mjs   # or: hydra setup (after PATH install)
```

Type a prompt in the operator console. Hydra routes it. Use `:help` to see all commands.

**Optional dependencies:**
- [`gh` CLI](https://cli.github.com) — GitHub integration (PRs, issue scanning)
- [`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api) — distributed tracing
- PowerShell 7+ — Windows launchers in `bin/`

## How It Works

Hydra has five dispatch modes. Pick one or let it choose:

| Mode | What it does |
|------|-------------|
| **Auto** | Classifies your prompt locally — zero extra API calls — then routes to a single agent, a tandem pair, or full council |
| **Smart** | Like Auto, but also auto-selects model tier (economy / balanced / performance) per prompt complexity |
| **Council** | Multi-round deliberation: Claude proposes → Gemini critiques → Claude refines → Codex implements |
| **Dispatch** | Headless pipeline — queues tasks for background workers, no interactive waiting |
| **Chat** | Conversational concierge — answers questions directly, escalates to agents only when real work is needed |

Switch modes with `:mode <name>` at any time. The daemon persists state across mode switches.

**Routing tiers within Auto / Smart:**
- **Single** — one agent handles the full task (fast path)
- **Tandem** — lead-follow pair: one agent analyzes, another implements
- **Council** — all three agents deliberate with structured synthesis

All routing decisions happen via a local heuristic. No API calls are made until an agent is dispatched.

## Features

### Intelligent Routing

- **Auto mode** — local heuristic classifies prompts into single / tandem / council routes without burning API tokens on routing
- **Smart mode** — extends Auto with per-prompt model tier selection (economy → balanced → performance based on complexity)
- **Intent gate** — pre-screens prompts before dispatch; catches off-topic or ambiguous inputs before they reach an agent
- **Tandem dispatch** — lead-follow agent pairs (e.g. Claude analyzes the problem, Codex implements the fix)
- **Affinity routing** — 10 task types mapped to optimal agents, with adaptive learning from past outcomes
- **Virtual sub-agents** — role-specialized agents (security-reviewer, test-writer, doc-generator, researcher) that resolve to physical agents at dispatch time

### Concierge Chat

- **Multi-provider front-end** — conversational AI with automatic failover: OpenAI → Anthropic → Google
- **Situational awareness** — "What's going on?" queries real-time daemon activity and agent status
- **Codebase knowledge** — questions about your architecture inject context from docs and the knowledge base
- **Fuzzy command matching** — catches `:stat` when you meant `:stats`, before falling back to AI suggestions
- **Persona system** — configurable identity, tone, verbosity, humor, and presets; interactive editor via `:persona`

### Automation Pipelines

- **Nightly runner** — scans TODO comments, `docs/TODO.md`, and GitHub issues → prioritizes → executes autonomously with budget tracking and commit attribution
- **Evolve** — 7-phase autonomous self-improvement loop with investigator self-healing, knowledge base accumulation, and a suggestions backlog for deferred improvements
- **Tasks runner** — per-task branch isolation, council-lite review for complex tasks, JSON + Markdown reports
- **Headless workers** — background agents claim tasks from the daemon queue, execute autonomously, and report results; permission modes configurable per agent

### Agent & Model Management

- **Per-agent model switching** — override any agent's model at runtime; interactive picker with type-to-filter and reasoning effort configuration
- **Custom agents** — add CLI-based or API-backed agents via wizard or config; built-in provider presets for GLM-5 and Kimi K2.5
- **Local agent** — API-backed fourth agent (`local`), no CLI install required; routes through OpenAI-compatible endpoints
- **Agent Forge** — multi-model agent creation pipeline: Gemini analyzes requirements, Claude designs, Gemini critiques, Claude refines, optional live test
- **Role system** — named roles (architect, analyst, implementer, etc.) map to agents and models; edit via `:roster`

### Monitoring & Safety

- **Circuit breaker** — per-model failure tracking; automatically opens after threshold failures and resets after cooldown
- **Rate limit resilience** — provider-level token bucket with exponential backoff and jitter on 429s across all providers
- **Three-tier budget tracking** — weekly, daily, and sliding-window token budgets with automatic model downgrade at thresholds
- **Per-provider usage tracking** — local session counters plus optional billing API queries (OpenAI and Anthropic admin keys)
- **Failure doctor** — diagnoses pipeline failures, detects recurring patterns, auto-creates follow-up tasks; `:doctor fix` runs an auto-remediation pipeline
- **5-line status bar** — persistent terminal footer with agent activity, token gauge, last dispatch route, session cost, and rolling event ticker

### Platform & Extensibility

- **MCP server** — 11 tools, 5 resources, 3 prompts via official SDK (protocol 2025-03-26); register with `hydra setup`
- **Hierarchical context** — scoped `HYDRA.md` files in any directory are auto-discovered and injected into agent calls for that path
- **Event-sourced daemon** — HTTP state management with replay from any sequence number, snapshots, and dead-letter queue
- **Git worktree isolation** — optional per-task isolated filesystems for parallel agent work without branch conflicts
- **Streaming middleware** — composable pipeline: rate limiting → circuit breaking → retry → telemetry → header capture → usage tracking
- **OTel tracing** — optional distributed tracing with GenAI semantic conventions; no-op when `@opentelemetry/api` is absent

## Essential Commands

### npm scripts

| Command | Description |
|---------|-------------|
| `npm run go` | Launch operator console |
| `npm start` | Start the daemon |
| `npm test` | Run all tests |
| `npm run council -- prompt="..."` | Full council deliberation |
| `npm run evolve` | Autonomous self-improvement |
| `npm run nightly` | Nightly task automation |
| `npm run tasks` | Scan & execute TODO/FIXME/issues |
| `npm run eval` | Routing evaluation against golden corpus |

### Operator console (inside `npm run go`)

| Command | Description |
|---------|-------------|
| `:help` | Show all commands |
| `:status` | Dashboard with agents & tasks |
| `:mode auto\|smart\|council\|dispatch\|chat` | Switch dispatch mode |
| `:model claude=sonnet` | Override agent model |
| `:model:select` | Interactive model + reasoning effort picker |
| `:workers start` | Start headless background workers |
| `:evolve` | Launch self-improvement session |
| `:nightly` | Interactive nightly run setup |
| `:doctor fix` | Auto-detect and fix pipeline issues |
| `:persona` | Edit concierge personality |
| `:resume` | Scan all resumable state |
| `!<prompt>` | Force dispatch, bypass concierge |

For the full command reference (80+ commands organized by category), see [docs/USAGE.md](docs/USAGE.md#operator-commands-reference).

## Configuration

Hydra is configured via `hydra.config.json` in the project root. Key sections:

| Section | Controls |
|---------|----------|
| `roles` | Role → agent → model mapping (architect, analyst, implementer, etc.) |
| `models` | Active model per agent, shorthand aliases, mode tier presets |
| `routing` | Route strategy, council gate, tandem dispatch, intent gate, worktree isolation |
| `workers` | Headless worker settings, permission modes, poll interval, auto-chain |
| `concierge` | Provider fallback chain, model, history length, persona |
| `persona` | Identity, voice, tone, verbosity, formality, humor, presets |
| `nightly` | Pipeline sources (TODO/GitHub), budget, AI discovery |
| `evolve` | Self-improvement rounds, suggestions backlog settings |
| `doctor` | Failure diagnosis, recurring pattern detection |
| `providers` | API keys, tier levels, rate limits, admin keys for usage queries |
| `github` | PR defaults, labels, reviewers |
| `modelRecovery` | Circuit breaker thresholds, fallback behavior, rate limit retry |

See [docs/USAGE.md](docs/USAGE.md#config-file) for the full config reference with all fields and defaults.

## Architecture

```
                    +-----------+
                    |  Operator |  (interactive REPL + concierge)
                    +-----+-----+
                          |
              +-----------+-----------+
              |                       |
        +-----v-----+          +------v----+
        | Concierge |          |  Workers  |
        | (chat AI) |          | (headless)|
        +-----+-----+          +------+----+
              |                       |
              +-----------+-----------+
                          |
                    +-----v-----+
                    |   Daemon  |  (HTTP, port 4173, event-sourced)
                    +--+--+--+--+
                       |  |  |
          +------------+  |  +-----------+
          v               v              v
     +---------+    +-----------+    +--------+
     | Gemini  |    |  Codex    |    | Claude |
     | (3 Pro) |    | (GPT-5.4) |    |(Sonnet)|
     +---------+    +-----------+    +--------+
       Analyst       Implementer      Architect

  Concierge fallback chain: OpenAI → Anthropic → Google
  Virtual sub-agents: security-reviewer, test-writer,
                      doc-generator, researcher
  Local agent: API-backed (no CLI), routes via OpenAI-compat endpoint
```

**Routing flow:**

```
Prompt → Intent Gate → Concierge → Route Classifier
                                        ↓
                          single / tandem / council
                                        ↓
                              Daemon task queue
                                        ↓
                          Worker(s) claim & execute
                                        ↓
                              Result + checkpoint
```

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/USAGE.md](docs/USAGE.md) | Full command reference, config fields, daemon API, MCP tools |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module reference, dispatch modes, route strategies |
| [docs/INSTALL.md](docs/INSTALL.md) | Detailed installation and setup |
| [docs/MODEL_PROFILES.md](docs/MODEL_PROFILES.md) | Agent model options, reasoning effort, aliases |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow, test patterns, conventions |

## Daemon Security

The HTTP daemon binds to `127.0.0.1` (localhost only) by default. It is designed for local, single-user use and does not include authentication. Do not expose port 4173 externally.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE)
