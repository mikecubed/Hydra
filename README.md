# Hydra

**Multi-Agent AI Orchestrator** for Gemini, Codex, and Claude.

```
   \\ | //
    \\|//
   _\\|//_
  |  \|/  |
  |  /|\  |
  \_/ | \_/
    |   |
    |___|

  H Y D R A
```

Hydra coordinates three AI coding agents (Gemini CLI, Codex CLI, Claude Code) through a shared task queue, affinity-based routing, and multi-round deliberation. Built for Windows with PowerShell, zero external dependencies beyond Node.js and picocolors.

## Quick Start

```powershell
# 1. Clone and install
cd E:\Dev\Hydra
npm install

# 2. Initialize for your project
cd E:\Dev\YourProject
node E:/Dev/Hydra/lib/orchestrator-client.mjs init

# 3. Launch everything (daemon + 3 agent heads + operator)
pwsh -File E:/Dev/Hydra/bin/hydra.ps1
```

## Features

- **Concierge front-end**: Conversational AI layer powered by `gpt-5.2-codex` — answers questions directly, only escalates to agents when real work is needed
- **Five orchestration modes**: Auto (triage + delegate), Council (multi-round deliberation), Dispatch (headless pipeline), Smart (auto-select model tier per prompt complexity), Chat (concierge conversation)
- **Affinity-based task routing**: 10 task types x 3 agents = intelligent work assignment
- **Per-agent model switching**: `hydra model claude=sonnet` to trade quality for speed/cost
- **Interactive model picker**: Arrow-key browser with type-to-filter, discovers models via API/CLI, sets reasoning effort
- **Per-command agent selection**: `agents=claude,gemini` to control which agents participate per-prompt
- **Token usage monitoring**: Reads Claude Code's stats cache, auto-switches models at critical levels
- **Metrics dashboard**: Per-agent call counts, response times, estimated tokens, success rates
- **Contingency planning**: When approaching rate limits, offers model switching, agent handoff, or progress saving
- **Project-aware verification**: Auto-detects verification command by stack (or uses explicit config)
- **Cross-model verification**: Route output through a paired verifier agent for correctness checks
- **Spec-driven task anchoring**: Complex prompts generate a spec document to anchor all downstream work
- **Checkpoint/resume**: Save and restore intermediate progress during long-running tasks
- **Event-sourced mutation log**: Monotonic sequence numbers, typed categories, and full replay support
- **Atomic task claiming**: Claim tokens prevent race conditions in rapid parallel dispatch
- **Git worktree isolation**: Per-task isolated filesystems for true parallel agent work
- **Codex MCP integration**: Multi-turn context via JSON-RPC over stdio (when Codex MCP server available)
- **Hydra MCP server**: Expose daemon as an MCP server so agents can self-coordinate
- **Session fork/spawn**: Fork sessions to explore alternatives, spawn children for focused subtasks
- **Session pause/resume**: Pause active sessions with reason tracking, resume with stale recovery
- **Fast-path dispatch**: Simple prompts bypass council for lower latency single-agent handoffs
- **Stale task detection**: Auto-detect tasks idle for 30+ minutes with `/tasks/stale` endpoint
- **Ghost text prompts**: Claude Code CLI-style greyed-out placeholder hints that cycle contextually and disappear on keystroke
- **Command-aware concierge**: Typos and near-miss commands are caught and corrected by the concierge AI instead of dead-end errors
- **5-line status bar**: Persistent terminal footer with agent activity, token gauge, dispatch context, and rolling event ticker
- **Agent terminal auto-launch**: Operator spawns Windows Terminal/PowerShell windows per agent head
- **HTTP daemon**: Shared state management with event sourcing, auto-archiving, and cycle detection
- **PowerShell-native**: Branded multi-terminal launcher with per-agent polling heads
- **Project-agnostic**: Works with any Node.js, Rust, Go, or Python project

## Architecture

```
                    +-----------+
                    |  Operator |  (interactive REPL)
                    +-----+-----+
                          |
                 +--------+--------+
                 |                 |
           +-----v-----+    +-----v-----+
           | Concierge |    |  Workers  |
           | (chat AI) |    | (headless)|
           +-----+-----+    +-----+-----+
                 |                 |
                 +--------+--------+
                          |
                    +-----v-----+
                    |   Daemon  |  (HTTP state + events)
                    +--+--+--+--+
                       |  |  |
              +--------+  |  +--------+
              v           v           v
         +---------+ +---------+ +---------+
         | Gemini  | |  Codex  | | Claude  |
         | (Pro)   | |(GPT-5.3)| | (Opus)  |
         +---------+ +---------+ +---------+
          Analyst    Implementer  Architect

  Concierge: OpenAI → Anthropic → Google fallback chain
  Sub-agents: security-reviewer, test-writer, doc-generator,
              researcher, evolve-researcher (virtual → physical)
```

## Project Structure

```
hydra/
  bin/
    hydra.ps1               # Main launcher (daemon + heads + operator)
    hydra-head.ps1           # Agent polling head
    hydra-launch.ps1         # Multi-terminal launcher
    hydra-stats.ps1          # Stats dashboard shortcut
    install-hydra-profile.ps1 # PowerShell profile installer
  lib/
    daemon/
      read-routes.mjs         # GET/SSE route handlers
      write-routes.mjs        # POST/mutating route handlers
    hydra-agents.mjs         # Agent registry, model management, verifier pairings
    hydra-concierge.mjs      # Conversational concierge (OpenAI streaming, intent detection)
    hydra-config.mjs         # Project detection, config loading
    hydra-context.mjs        # Tiered context builders
    hydra-council.mjs        # Multi-round deliberation (with agent filtering + specs)
    hydra-dispatch.mjs       # Single-shot pipeline
    hydra-mcp.mjs            # MCP client for Codex (JSON-RPC over stdio)
    hydra-mcp-server.mjs     # Hydra daemon as MCP server (8 tools)
    hydra-metrics.mjs        # Call metrics collection
    hydra-models.mjs         # Model discovery (API/CLI/config) and listing
    hydra-models-select.mjs  # Interactive model + reasoning effort picker
    hydra-operator.mjs       # Interactive command center
    hydra-statusbar.mjs      # Persistent 5-line terminal status bar
    hydra-ui.mjs             # Terminal UI components
    hydra-usage.mjs          # Token usage monitor
    hydra-utils.mjs          # Shared utilities (+ spec generation, async model calls)
    hydra-verification.mjs   # Project-aware verification command resolver
    hydra-worktree.mjs       # Git worktree isolation per task
    orchestrator-client.mjs  # CLI client for daemon
    orchestrator-daemon.mjs  # HTTP server + event-sourced state manager
    sync.mjs                 # Legacy sync CLI
  docs/
    INSTALL.md               # Installation guide
    USAGE.md                 # Command reference
    ARCHITECTURE.md          # System design
    CONTRIBUTING.md          # Extension guide
    coordination/
      specs/                 # Generated spec documents for complex prompts
  hydra.config.json          # Model + usage + worktree + MCP + verification + concierge config
  package.json
  test/
    hydra-mcp.test.mjs                     # MCP client unit tests
    hydra-verification.test.mjs            # Verification resolver unit tests
    orchestrator-daemon.integration.test.mjs # Daemon endpoint integration tests
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the daemon |
| `npm run go` | Launch operator console |
| `npm run stats` | View metrics dashboard |
| `npm run usage` | Check token usage |
| `npm run model` | Show/set active models |
| `npm run models` | List all available models per agent |
| `npm run models:select` | Interactive model + effort picker |
| `npm run council` | Full multi-round deliberation |
| `npm run dispatch` | Headless pipeline |
| `npm test` | Run unit + integration tests |

## Documentation

- [Installation](docs/INSTALL.md)
- [Usage & Commands](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](docs/CONTRIBUTING.md)

## Requirements

- Node.js 20+
- PowerShell 7+ (for launchers)
- At least one AI CLI: `gemini`, `codex`, or `claude`

## License

Private project.
