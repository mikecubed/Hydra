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

<!-- TODO: 6 groups -->

## Essential Commands

<!-- TODO: cheat sheet -->

## Configuration

<!-- TODO: config table -->

## Architecture

<!-- TODO: diagram -->

## Documentation

<!-- TODO: links -->

## Daemon Security

<!-- TODO: security note -->

## License

<!-- TODO: license -->
