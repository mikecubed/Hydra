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

- **Five orchestration modes**: Auto (intelligent 3-way routing), Council (multi-round deliberation), Dispatch (headless pipeline), Smart (auto-select model tier per prompt complexity), Chat (concierge conversation)
- **Intelligent route classification**: Local heuristic classifies prompts into single/tandem/council routes with zero agent CLI calls
- **Tandem dispatch**: 2-agent lead-follow pairs (e.g., claude analyzes, codex implements) for moderate prompts — skips expensive mini-round triage
- **Council gate**: Warns when council mode is overkill, offering efficient alternatives
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
- **Failure doctor**: Higher-level diagnostic layer that fires on non-trivial pipeline failures. Calls the investigator for diagnosis, triages into follow-up actions (daemon tasks, evolve suggestions, KB entries), and detects recurring error patterns across sessions. Configurable via `doctor` config section.
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
- **Nightly automation**: Config-driven 5-phase pipeline (scan, AI discovery, prioritize, execute, report) with multi-source task scanning, intelligent agent routing, and smart merge review
- **Commit attribution**: Automated pipeline commits include `Originated-By:` and `Executed-By:` git trailers for provenance tracking. Safety prompts instruct agents to include trailers; `stageAndCommit()` also appends them programmatically.
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
           +-----v-----+    +------v----+
           | Concierge |    |  Workers  |
           | (chat AI) |    | (headless)|
           +-----+-----+    +------+----+
                 |                 |
                 +--------+--------+
                          |
                    +-----v-----+
                    |   Daemon  |  (HTTP state + events)
                    +--+--+--+--+
                       |  |  |
          +------------+  |  +-----------+
          v               v              v
     +---------+  +---------------+  +--------+
     | Gemini  |  |     Codex     |  | Claude |
     | (3 Pro) |  |(GPT-5.3 Codex)|  | (Opus) |
     +---------+  +---------------+  +--------+
       Analyst       Implementer      Architect

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
    hydra-doctor.mjs         # Failure diagnostic and triage layer (doctor agent)
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
    hydra-nightly.mjs        # Nightly 5-phase pipeline (scan/discover/prioritize/execute/report)
    hydra-nightly-discovery.mjs # AI-powered task suggestion for nightly
    hydra-nightly-review.mjs # Nightly review with smart merge
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
| `npm run tasks` | Scan & execute TODO/FIXME/issues autonomously |
| `npm run tasks:review` | Review tasks runner branches |
| `npm run evolve:review` | Review evolve round results |
| `npm run nightly:review` | Review nightly round results |
| `npm test` | Run unit + integration tests |

## Operator Commands

These commands are available inside the interactive operator console (`npm run go`).

| Command | Description |
|---------|-------------|
| `:help` | Show help |
| `:status` | Dashboard with agents & tasks |
| `:sitrep` | AI-narrated situation report |
| `:mode auto` | Mini-round triage then delegate/escalate |
| `:mode smart` | Auto-select model tier per prompt complexity |
| `:mode handoff` | Direct handoffs (fast, no triage) |
| `:mode council` | Full council deliberation |
| `:mode dispatch` | Headless pipeline (Claude->Gemini->Codex) |
| `:model` | Show mode & active models |
| `:model claude=sonnet` | Override agent model |
| `:model reset` | Clear all overrides |
| `:model:select` | Interactive model picker |
| `:roles` | Show role->agent->model mapping & recommendations |
| `:roster` | Edit role->agent->model assignments interactively |
| `:persona` | Edit personality settings interactively |
| `:persona show` | Show current personality config |
| `:persona <preset>` | Apply preset (default/professional/casual/analytical/terse) |
| `:usage` | Token usage & contingencies |
| `:stats` | Agent metrics & performance |
| `:resume` | Scan all resumable state (daemon, evolve, branches, suggestions) |
| `:pause [reason]` | Pause the active session |
| `:unpause` | Resume a paused session |
| `:fork` | Fork current session |
| `:spawn <focus>` | Spawn child session |
| `:tasks` | List active daemon tasks |
| `:tasks scan` | Scan codebase for TODO/FIXME/issues |
| `:tasks run` | Launch autonomous tasks runner |
| `:tasks review` | Interactive branch review & merge |
| `:tasks status` | Show latest tasks run report |
| `:tasks clean` | Delete all tasks/* branches |
| `:handoffs` | List pending & recent handoffs |
| `:cancel <id>` | Cancel a task |
| `:clear` | Interactive menu to select clear target |
| `:clear all` | Cancel all tasks & ack all handoffs |
| `:clear concierge` | Clear conversation history |
| `:clear metrics` | Reset session metrics |
| `:clear screen` | Clear terminal |
| `:archive` | Archive completed work & trim events |
| `:events` | Show recent event log |
| `:workers` | Show worker status |
| `:workers start [agent]` | Start worker(s) |
| `:workers stop [agent]` | Stop worker(s) |
| `:workers restart` | Restart all workers |
| `:workers mode <mode>` | Change permission mode |
| `:watch <agent>` | Open visible terminal for agent |
| `:chat` | Toggle concierge on/off |
| `:chat model` | Show active model & fallback chain |
| `:chat model <name>` | Switch model (e.g. sonnet, flash) |
| `:chat export` | Export conversation to file |
| `:evolve` | Launch evolve session |
| `:evolve status` | Show latest evolve report |
| `:evolve resume` | Resume interrupted session |
| `:evolve knowledge` | Browse knowledge base |
| `:nightly` | Launch nightly run (interactive setup + task selection) |
| `:nightly dry-run` | Scan & prioritize without executing |
| `:nightly review` | Interactive branch review & merge |
| `:nightly status` | Show latest nightly run report |
| `:nightly clean` | Delete all nightly/* branches |
| `:github` | GitHub status |
| `:github prs` | List open pull requests |
| `:pr create [branch]` | Push branch & create PR |
| `:pr list` | List open pull requests |
| `:pr view <number>` | Show PR details |
| `:forge` | Interactive agent creation wizard |
| `:forge list` | List forged agents |
| `:forge delete <name>` | Remove a forged agent |
| `:agents` | List all registered agents |
| `:agents info <name>` | Show agent details & config |
| `:doctor` | Diagnostic stats & recent log entries |
| `:doctor log` | Show last 25 diagnostic entries |
| `:doctor fix` | Auto-detect and fix issues via action pipeline |
| `:doctor diagnose <text>` | Investigate a failure via GPT-5.3 |
| `:kb` | Knowledge base stats & recent entries |
| `:kb <query>` | Search knowledge base entries |
| `:cleanup` | Scan & clean stale branches, tasks, artifacts |
| `:sync` | Sync HYDRA.md to agent instruction files |
| `:confirm` | Show/toggle dispatch confirmations |
| `:shutdown` | Stop the daemon |
| `:quit` | Exit operator console |
| `!<prompt>` | Force dispatch (bypass concierge) |

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

## Failure Doctor

The doctor layer fires when evolve, nightly, or tasks encounters a non-trivial failure. It calls the investigator for diagnosis, triages the result into actionable follow-ups, and tracks recurring patterns.

**Config** (`hydra.config.json`):
```json
{
  "doctor": {
    "enabled": true,
    "autoCreateTasks": true,
    "autoCreateSuggestions": true,
    "addToKnowledgeBase": true,
    "recurringThreshold": 3,
    "recurringWindowDays": 7
  }
}
```

**How it works:**
- On failure, builds an error signature (agent + phase + error snippet)
- Checks `DOCTOR_LOG.ndjson` for recurring patterns (same signature 3+ times in 7 days)
- Rate limits and simple timeouts are skipped (already handled by retry logic)
- Calls the investigator for diagnosis when available
- Triages: fundamental → suggestion ticket, fixable → daemon task (fallback: suggestion), transient → log only
- Recurring transient failures get escalated to tickets
- Non-transient findings are added to the evolve knowledge base
- All diagnoses are logged to `docs/coordination/doctor/DOCTOR_LOG.ndjson`

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

## Nightly Runner

Config-driven autonomous overnight pipeline. Scans multiple sources for tasks, optionally uses AI discovery to suggest improvements, prioritizes and executes with intelligent agent routing and budget-aware handoff.

**5-phase pipeline:** SCAN → DISCOVER → PRIORITIZE → EXECUTE → REPORT

**Sources:** TODO/FIXME code comments, `docs/TODO.md`, GitHub issues, static config tasks, AI discovery (via agent analysis)

**Features:**
- Multi-source task scanning via `hydra-tasks-scanner.mjs`
- Optional AI discovery phase (default: gemini analyzes codebase for improvements)
- Intelligent agent routing: `classifyTask()` + `bestAgentFor()` picks optimal agent per task
- Budget-aware handoff: switches to economy agent (codex/o4-mini) at configurable threshold
- Model recovery and investigator self-healing on failures
- Smart merge review: auto-rebases when base branch has advanced
- `--dry-run` mode for scan + prioritize without executing
- Fully unattended — no interactive prompts

**Config** (`hydra.config.json`):
```json
{
  "nightly": {
    "baseBranch": "dev",
    "branchPrefix": "nightly",
    "maxTasks": 5,
    "maxHours": 4,
    "sources": {
      "todoMd": true,
      "todoComments": true,
      "githubIssues": true,
      "configTasks": true,
      "aiDiscovery": true
    },
    "aiDiscovery": {
      "agent": "gemini",
      "maxSuggestions": 5,
      "focus": []
    },
    "budget": {
      "softLimit": 400000,
      "hardLimit": 500000,
      "handoffThreshold": 0.70,
      "handoffAgent": "codex",
      "handoffModel": "o4-mini"
    },
    "tasks": [],
    "investigator": { "enabled": true }
  }
}
```

**CLI flags:**
```bash
node lib/hydra-nightly.mjs                         # defaults from config
node lib/hydra-nightly.mjs --dry-run               # scan + prioritize only
node lib/hydra-nightly.mjs --no-discovery          # skip AI discovery
node lib/hydra-nightly.mjs --interactive           # interactive task selection
node lib/hydra-nightly.mjs max-tasks=3 max-hours=2 # override limits
```

## Tasks Runner

The tasks runner scans the codebase for actionable work items (TODO/FIXME code comments, unchecked items in `docs/TODO.md`, open GitHub issues) and executes them autonomously with per-task branch isolation.

**Per-task lifecycle:** CLASSIFY → PLAN (complex only) → EXECUTE → VERIFY → DECIDE (council-lite review for complex tasks)

**Features:**
- Multi-source scanning: code comments, TODO.md, GitHub issues
- Budget presets (light/medium/heavy) with 4-tier threshold system
- Branch isolation: `tasks/{date}/{slug}` per task
- Self-healing via investigator on execution failures
- Council-lite review: verifier agent reviews diffs for complex tasks
- JSON + Markdown reports in `docs/coordination/tasks/`

**Operator commands:**
| Command | Description |
|---------|-------------|
| `:tasks scan` | Scan codebase for work items |
| `:tasks run` | Launch tasks runner |
| `:tasks review` | Interactive branch review & merge |
| `:tasks status` | Show latest run report |
| `:tasks clean` | Delete all tasks/* branches |

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
