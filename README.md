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

### Orchestration & Routing

- **Five orchestration modes**: Auto (triage + delegate), Council (multi-round deliberation), Dispatch (headless pipeline), Smart (auto-select model tier per prompt complexity), Chat (concierge conversation)
- **Affinity-based task routing**: 10 task types x 3 agents = intelligent work assignment
- **Fast-path dispatch**: Simple prompts bypass council for lower latency single-agent handoffs
- **Per-command agent selection**: `agents=claude,gemini` to control which agents participate per-prompt
- **Virtual sub-agents**: Role-specialized agents (security-reviewer, test-writer, doc-generator, researcher) that resolve to physical agents for dispatch
- **Spec-driven task anchoring**: Complex prompts generate a spec document to anchor all downstream work

### Concierge Chat

- **Multi-provider front-end**: Conversational AI layer (OpenAI → Anthropic → Google fallback chain) — answers questions directly, only escalates to agents when real work is needed
- **Situational awareness**: Ask "What's going on?", "What is claude working on?", "What's that handoff about?" — concierge fetches real-time activity digest from daemon and agent state
- **Codebase knowledge**: Ask "How does dispatch work?", "What config options exist for workers?" — concierge injects topic-specific architecture context from CLAUDE.md, module index, and evolve knowledge base
- **Command-aware**: Typos and near-miss commands caught locally via fuzzy matching (Levenshtein) before falling back to AI suggestion
- **Runtime model switching**: `:chat model sonnet` switches the concierge provider/model on the fly
- **Conversation export**: `:chat export` saves concierge history to JSON for analysis
- **Token cost estimation**: Per-turn cost display after each concierge response

### Agent & Model Management

- **Per-agent model switching**: `hydra model claude=sonnet` to trade quality for speed/cost
- **Interactive model picker**: Arrow-key browser with type-to-filter, discovers models via API/CLI, sets reasoning effort
- **Headless workers**: Background agent execution with claim-execute-report loop, per-agent permission modes
- **Cross-model verification**: Route output through a paired verifier agent for correctness checks
- **Agent terminal auto-launch**: Operator spawns Windows Terminal/PowerShell windows per agent head
- **Agent Forge**: Multi-model agent creation pipeline (`:forge`) — Gemini analyzes codebase, Claude designs spec, Gemini critiques, Claude refines, optional live test. Persists to config and auto-registers. MCP tools: `hydra_forge`, `hydra_forge_list`

### Monitoring & Safety

- **Token usage monitoring**: Three-tier budget tracking (weekly primary, daily secondary, sliding window) from Claude Code's `stats-cache.json`. Per-agent breakdown in `:usage`. Auto-switches models at critical levels.
- **Metrics dashboard**: Per-agent call counts, response times, real + estimated tokens, success rates
- **Model recovery**: Automatic detection and fallback when a configured model is unavailable. Interactive mode offers choice; headless mode auto-selects fallback. Integrated into evolve, workers, and MCP.
- **Rate limit resilience**: Detects 429/RESOURCE_EXHAUSTED/QUOTA_EXHAUSTED errors across all providers. Exponential backoff with jitter and server Retry-After support. Evolve pipeline retries rate-limited agents without wasting API calls on investigator diagnosis. Configurable via `rateLimits` config section.
- **Contingency planning**: When approaching rate limits, offers model switching, agent handoff, or progress saving
- **Project-aware verification**: Auto-detects verification command by stack (or uses explicit config)
- **5-line status bar**: Persistent terminal footer with agent activity, token gauge, dispatch context, and rolling event ticker

### Task & Session Management

- **Checkpoint/resume**: Save and restore intermediate progress during long-running tasks
- **Session fork/spawn**: Fork sessions to explore alternatives, spawn children for focused subtasks
- **Session pause/resume**: Pause active sessions with reason tracking, resume with stale recovery
- **Stale task detection**: Auto-detect tasks idle for 30+ minutes with `/tasks/stale` endpoint
- **Atomic task claiming**: Claim tokens prevent race conditions in rapid parallel dispatch

### Automation & CI

- **Autonomous self-improvement**: 7-phase evolve pipeline with budget tracking, investigator self-healing, and knowledge accumulation
- **Evolve suggestions backlog**: Persistent improvement ideas from rejected/deferred rounds, user input, and review sessions — interactive picker at session start, CLI management, Jaccard dedup
- **Nightly automation**: Scheduled task processing with safety guardrails and review workflow
- **GitHub integration**: PR creation from operator (`:pr create`), review flow PR option, repo detection, open PR listing — requires `gh` CLI

### Platform & Infrastructure

- **HTTP daemon**: Shared state management with event sourcing, auto-archiving, and cycle detection
- **Event-sourced mutation log**: Monotonic sequence numbers, typed categories, and full replay support
- **Git worktree isolation**: Per-task isolated filesystems for true parallel agent work
- **Codex MCP integration**: Multi-turn context via JSON-RPC over stdio (when Codex MCP server available)
- **Hydra MCP server**: Expose Hydra as MCP server for Claude Code — `hydra_ask` invokes Gemini/Codex directly (no daemon needed), plus daemon tools for task queue/handoffs/council when running
- **Ghost text prompts**: Claude Code CLI-style greyed-out placeholder hints that cycle contextually and disappear on keystroke
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
         |(3 Pro)  | |(GPT-5.3 Codex)| | (Opus)  |
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
    hydra-evolve-suggestions.mjs # Suggestions backlog for evolve pipeline
    hydra-evolve-suggestions-cli.mjs # CLI for managing evolve suggestions
    hydra-evolve-review.mjs  # Evolve round review and status
    hydra-activity.mjs       # Real-time activity digest for concierge situational awareness
    hydra-codebase-context.mjs # Codebase knowledge injection for concierge
    hydra-github.mjs         # GitHub integration via gh CLI (PRs, repo detection)
    hydra-google.mjs         # Google Gemini API streaming client
    hydra-mcp.mjs            # MCP client for Codex (JSON-RPC over stdio)
    hydra-mcp-server.mjs     # Hydra MCP server (9 tools, standalone + daemon modes)
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
    hydra-activity.test.mjs                 # Activity digest detection + formatting tests
    hydra-agents.test.mjs                  # Agent registry + sub-agent tests
    hydra-codebase-context.test.mjs        # Codebase knowledge detection + topic mapping tests
    hydra-concierge-providers.test.mjs     # Provider detection + fallback chain tests
    hydra-evolve-suggestions.test.mjs      # Evolve suggestions backlog tests
    hydra-github.test.mjs                  # GitHub integration + parseRemoteUrl tests
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
| `npm run evolve:suggestions` | Manage evolve suggestions backlog |
| `npm run nightly` | Run nightly task automation |
| `npm run evolve:review` | Review evolve round results |
| `npm run nightly:review` | Review nightly round results |
| `npm test` | Run unit + integration tests |

## GitHub Integration

Hydra can create pull requests, list PRs, and integrate with the review flow via the `gh` CLI.

**Setup:**
```bash
# Install gh CLI: https://cli.github.com
gh auth login
```

**Operator commands:**
| Command | Description |
|---------|-------------|
| `:github` | Show GitHub status (gh installed, auth, repo, open PRs) |
| `:github prs` | List open pull requests |
| `:pr create [branch]` | Push branch and create a pull request |
| `:pr list` | List open pull requests |
| `:pr view <number>` | Show PR details (title, state, changes, URL) |

**Config** (`hydra.config.json`):
```json
{
  "github": {
    "enabled": false,
    "defaultBase": "",
    "draft": false,
    "labels": [],
    "reviewers": [],
    "prBodyFooter": ""
  }
}
```

When `gh` is installed, the evolve and nightly review flows automatically show a `[p]r` option alongside merge/skip/diff/delete.

## Evolve Suggestions Backlog

The evolve pipeline maintains a persistent backlog of improvement ideas sourced from rejected/deferred rounds, user input, and review sessions. At the start of each evolve session, pending suggestions are presented in an interactive picker.

**How it works:**
- Rejected evolve rounds with valid improvement text are auto-backlogged (configurable)
- Deferred rounds can also auto-populate the backlog
- Jaccard similarity deduplication prevents near-duplicate entries
- Picking a suggestion skips RESEARCH + DELIBERATE phases — goes straight to PLAN
- Suggestions track attempts, scores, and learnings across retries
- Status lifecycle: `pending` → `exploring` → `completed` | `rejected` | `abandoned`
- During review, `[r]etry` creates a suggestion from the rejected round

**CLI** (`npm run evolve:suggestions`):
| Subcommand | Description |
|------------|-------------|
| `list` | List suggestions (default: pending; `status=all` for all) |
| `add` | Add a suggestion (interactive or `title=... area=...`) |
| `remove <ID>` | Mark suggestion as abandoned |
| `reset <ID>` | Reset suggestion back to pending |
| `import` | Scan decision artifacts for retryable rounds |
| `stats` | Show backlog statistics by status and area |

**Config** (`hydra.config.json`):
```json
{
  "evolve": {
    "suggestions": {
      "enabled": true,
      "autoPopulateFromRejected": true,
      "autoPopulateFromDeferred": true,
      "maxPendingSuggestions": 50,
      "maxAttemptsPerSuggestion": 3
    }
  }
}
```

## Documentation

- [Installation](docs/INSTALL.md)
- [Usage & Commands](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](docs/CONTRIBUTING.md)

## Requirements

- Node.js 20+
- PowerShell 7+ (for launchers)
- At least one AI CLI: `gemini`, `codex`, or `claude`
- Optional: `gh` CLI for GitHub integration (PRs, repo detection)

## License

Private project.
