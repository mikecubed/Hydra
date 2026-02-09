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

- **Concierge front-end**: Multi-provider conversational AI layer (OpenAI → Anthropic → Google fallback chain) — answers questions directly, only escalates to agents when real work is needed
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
- **Command-aware concierge**: Typos and near-miss commands are caught locally via fuzzy matching (Levenshtein) before falling back to AI suggestion
- **Runtime model switching**: `:chat model sonnet` switches the concierge provider/model on the fly
- **Conversation export**: `:chat export` saves concierge history to JSON for analysis
- **Token cost estimation**: Per-turn cost display after each concierge response
- **Headless workers**: Background agent execution with claim-execute-report loop, per-agent permission modes
- **Autonomous self-improvement**: 7-phase evolve pipeline with budget tracking, investigator self-healing, and knowledge accumulation
- **Nightly automation**: Scheduled task processing with safety guardrails and review workflow
- **Virtual sub-agents**: Role-specialized agents (security-reviewer, test-writer, doc-generator, researcher) that resolve to physical agents for dispatch
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
    hydra-evolve.ps1         # Autonomous self-improvement launcher
    hydra-nightly.ps1        # Nightly task automation launcher
    install-hydra-profile.ps1 # PowerShell profile installer
  lib/
    daemon/
      read-routes.mjs         # GET/SSE route handlers
      write-routes.mjs        # POST/mutating route handlers
    hydra-agents.mjs         # Agent registry, model management, task routing
    hydra-anthropic.mjs      # Anthropic Messages API streaming client
    hydra-concierge.mjs      # Multi-provider conversational concierge (intent detection, cost estimation)
    hydra-concierge-providers.mjs # Provider abstraction + fallback chain orchestration
    hydra-config.mjs         # Project detection, config loading
    hydra-context.mjs        # Tiered context builders
    hydra-council.mjs        # Multi-round deliberation (with agent filtering + specs)
    hydra-dispatch.mjs       # Single-shot pipeline
    hydra-env.mjs            # Minimal .env loader (auto-loads on import)
    hydra-evolve.mjs         # Autonomous self-improvement pipeline (7-phase rounds)
    hydra-evolve-guardrails.mjs # Evolve safety guardrails
    hydra-evolve-investigator.mjs # Self-healing failure diagnosis
    hydra-evolve-knowledge.mjs # Knowledge accumulation across evolve rounds
    hydra-evolve-review.mjs  # Evolve round review and status
    hydra-google.mjs         # Google Gemini API streaming client
    hydra-mcp.mjs            # MCP client for Codex (JSON-RPC over stdio)
    hydra-mcp-server.mjs     # Hydra daemon as MCP server (8 tools)
    hydra-metrics.mjs        # Call metrics collection
    hydra-models.mjs         # Model discovery (API/CLI/config) and listing
    hydra-models-select.mjs  # Interactive model + reasoning effort picker
    hydra-nightly.mjs        # Nightly task automation
    hydra-nightly-guardrails.mjs # Nightly safety guardrails
    hydra-nightly-queue.mjs  # Nightly task queue management
    hydra-nightly-review.mjs # Nightly round review and status
    hydra-openai.mjs         # OpenAI API streaming client
    hydra-operator.mjs       # Interactive command center
    hydra-prompt-choice.mjs  # Interactive numbered-choice prompt UI
    hydra-statusbar.mjs      # Persistent 5-line terminal status bar
    hydra-sub-agents.mjs     # Built-in virtual sub-agent definitions
    hydra-sync-md.mjs        # HYDRA.md sync across projects
    hydra-ui.mjs             # Terminal UI components
    hydra-usage.mjs          # Token usage monitor
    hydra-utils.mjs          # Shared utilities (+ spec generation, async model calls)
    hydra-verification.mjs   # Project-aware verification command resolver
    hydra-version.mjs        # Runtime version string
    hydra-worker.mjs         # Headless background agent execution
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
    hydra-agents.test.mjs                  # Agent registry + sub-agent tests
    hydra-concierge-providers.test.mjs     # Provider detection + fallback chain tests
    hydra-mcp.test.mjs                     # MCP client unit tests
    hydra-metrics.test.mjs                 # Metrics collection tests
    hydra-streaming-clients.test.mjs       # Anthropic/Google client + concierge multi-provider tests
    hydra-sync-md.test.mjs                 # HYDRA.md sync tests
    hydra-ui.test.mjs                      # UI formatting + color tests
    hydra-utils.test.mjs                   # Utility function tests
    hydra-verification.test.mjs            # Verification resolver unit tests
    daemon-extended.integration.test.mjs   # Extended daemon endpoint tests
    orchestrator-daemon.integration.test.mjs # Core daemon endpoint integration tests
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
| `npm run evolve` | Run autonomous self-improvement |
| `npm run nightly` | Run nightly task automation |
| `npm run evolve:review` | Review evolve round results |
| `npm run nightly:review` | Review nightly round results |
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
