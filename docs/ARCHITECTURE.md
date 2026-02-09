# Architecture

## Module Dependency Graph

```
hydra-config.mjs ──────────────────────────────┐
       │                                        │
       v                                        v
hydra-agents.mjs ──> hydra-metrics.mjs    hydra-usage.mjs
       │                    │                   │
       v                    v                   │
hydra-utils.mjs <───────────┘                   │
       │                                        │
       ├──────────┬──────────┐                  │
       v          v          v                  │
hydra-dispatch  hydra-council  hydra-operator <─┘
       │          │          │
       v          v          v
hydra-context.mjs   hydra-ui.mjs
                         │
                         v
                    picocolors

orchestrator-daemon.mjs ──> hydra-agents, hydra-ui, hydra-config,
                            hydra-metrics, hydra-usage, hydra-verification,
                            hydra-worktree, hydra-mcp
       │
       └──> daemon/read-routes.mjs + daemon/write-routes.mjs

hydra-concierge.mjs ──> hydra-config, hydra-agents,
       │                    hydra-concierge-providers
       └──> Multi-provider fallback (OpenAI → Anthropic → Google)

hydra-concierge-providers.mjs ──> hydra-config
       │
       ├──> hydra-openai.mjs (lazy)
       ├──> hydra-anthropic.mjs (lazy)
       └──> hydra-google.mjs (lazy)

hydra-anthropic.mjs ──> Anthropic Messages API (streaming)
hydra-google.mjs ──> Google Gemini Generative Language API (SSE streaming)

hydra-sub-agents.mjs ──> hydra-agents (registerAgent), hydra-config

hydra-mcp-server.mjs ──> HTTP daemon API (standalone stdio MCP server)

hydra-worktree.mjs ──> git CLI (child_process.execSync)

hydra-mcp.mjs ──> Codex MCP server (JSON-RPC over stdio)

orchestrator-client.mjs ──> hydra-utils, hydra-ui, hydra-agents,
                            hydra-usage
```

## Data Flow

### Prompt Dispatch (Auto Mode)

```
User prompt
     │
     v
[Operator] ──> classifyPrompt() ──> tier: simple | moderate | complex
     │
     ├── simple ──> fast-path delegation (bypass council entirely)
     │                   │
     │                   └── bestAgentFor(taskType) ──> single handoff
     │
     ├── moderate ──> mini-round triage (1 fast council round)
     │     │
     │     ├── recommendation=handoff ──> create daemon handoffs for each agent
     │     │                                    │
     │     │                              [Agent Heads] poll /next, pick up handoffs
     │     │
     │     └── recommendation=council ──> full council deliberation
     │
     └── complex ──> generateSpec() ──> anchoring spec document
                          │
                          v
                     full council deliberation (spec injected into every phase)
                          │
                     Claude (propose)
                          │
                     Gemini (critique)
                          │
                     Claude (refine)
                          │
                     Codex (implement)
                          │
                     cross-model verification (optional)
                          │
                     publish tasks/decisions/handoffs
```

### Fast-Path Dispatch

Simple prompts bypass the council entirely for lower latency:

```
classifyPrompt(prompt) ──> tier: simple
     │
     v
publishFastPathDelegation(prompt, agents)
     │
     ├── bestAgentFor(taskType, filteredAgents) ──> recommended agent
     │
     └── create single handoff to recommended agent
           │
           v
     [Agent Head] picks up handoff via /next polling
```

Fast-path respects the `agents=` filter — if only specific agents are allowed, the best match within that set is chosen.

### Smart Mode

Smart mode (`smart`) auto-selects the model tier based on prompt complexity:

```
User prompt
     │
     v
classifyPrompt(prompt) ──> { tier: simple | moderate | complex }
     │
     v
SMART_TIER_MAP:
  simple   ──> economy tier   (fast/cheap models)
  medium   ──> balanced tier   (default + fast mix)
  complex  ──> performance tier (default/best models)
     │
     v
Temporarily override mode ──> run auto dispatch ──> restore original mode
```

### Concierge (Multi-Provider Conversational Front-End)

The concierge is a multi-provider conversational AI layer with automatic fallback (OpenAI → Anthropic → Google). It sits in front of the dispatch pipeline and is active by default (`autoActivate: true`).

```
User input at hydra⬢[gpt-5.2]> prompt
     │
     ├── starts with ':'?
     │     │
     │     ├── recognized command ──> execute directly (bypass concierge)
     │     │
     │     ├── fuzzy match (Levenshtein ≤ 2) ──> suggest correct command locally
     │     │
     │     └── unrecognized ──> concierge suggests the correct command
     │
     ├── starts with '!'?
     │     │
     │     └── strip prefix ──> bypass concierge ──> dispatch pipeline directly
     │
     └── normal text ──> conciergeTurn(userMsg, context)
               │
               ├── streamWithFallback() ──> try primary provider
               │     │
               │     ├── primary OK ──> stream response
               │     ├── primary fail ──> try next in fallback chain
               │     └── all fail ──> throw combined error
               │
               ├── response starts with [DISPATCH]?
               │     │
               │     ├── yes ──> extract cleaned prompt ──> dispatch pipeline
               │     │            post concierge:dispatch event to daemon
               │     │
               │     └── no  ──> chat response streamed to user in blue
               │                  display cost estimate [~$0.0042]
               │
               ├── API error?
               │     │
               │     ├── 401/403 ──> auto-disable concierge, revert to normal prompt
               │     └── other   ──> show error, keep concierge active
               │
               └── every 5 turns ──> post concierge:summary event to daemon
```

The concierge maintains an in-memory conversation history (capped at 40 messages). Its system prompt is rebuilt with context-hash invalidation (fingerprint changes OR TTL expiry) and includes: project name, mode, open tasks, agent models, git branch/status, recent completions, recent errors, and active workers. It includes a full command reference for typo correction.

**Provider fallback chain** (configurable via `concierge.fallbackChain`):
1. OpenAI (`gpt-5.2-codex`) — primary
2. Anthropic (`claude-sonnet-4-5-20250929`) — first fallback
3. Google (`gemini-2.5-flash`) — last resort

Provider modules are lazy-loaded via `await import()` to avoid loading unused ones.

**Bidirectional communication**: The concierge posts events to the daemon via `POST /events/push`:
- `concierge:dispatch` — when escalating to dispatch pipeline (includes conversation context)
- `concierge:summary` — every 5 turns (turn count, topic, tokens used)
- `concierge:error` — on provider errors
- `concierge:model_switch` — when switching models at runtime

**Prompt shows active model**: `hydra⬢[gpt-5.2]>` or `hydra⬢[sonnet ↓]>` (↓ indicates fallback).

Modules: `lib/hydra-concierge.mjs`, `lib/hydra-concierge-providers.mjs`, `lib/hydra-anthropic.mjs`, `lib/hydra-google.mjs`.

### Ghost Text (Placeholder Prompts)

The operator console shows greyed-out placeholder text after the cursor, similar to Claude Code CLI:

```
hydra⬢[gpt-5.2]> Chat naturally — prefix ! to dispatch
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
         dim ghost text, disappears on first keystroke
```

Implementation:
- `rl.prompt()` is wrapped to append dim ghost text via ANSI after each fresh prompt
- A one-shot `stdin` data listener fires `\x1b[K` (erase to EOL) on the first keystroke
- `rl.prompt(true)` (mid-typing refreshes) does NOT show ghost text
- Messages rotate from a contextual pool (concierge-aware vs normal hints)
- Ghost text cleanup listener is removed on `rl.close()`

### Agent Terminal Auto-Launch

On Windows, the operator console can auto-spawn terminal windows for each agent:

```
Operator init
     │
     v
findPowerShell() ──> pwsh or powershell
findWindowsTerminal() ──> wt.exe (optional)
     │
     v
For each agent (gemini, codex, claude):
     │
     ├── Windows Terminal available?
     │   ├── yes ──> wt.exe new-tab -p "PowerShell" -d <cwd> pwsh -EncodedCommand ...
     │   └── no  ──> Start-Process pwsh -EncodedCommand ...
     │
     └── Each terminal runs: hydra-head.ps1 -Agent <name> -Url <daemonUrl>
```

Agent heads poll the daemon and auto-claim handoffs and owned tasks (`claim_owned_task` action).

### Agent Filtering

When `agents=claude,gemini` is specified, only those agents participate:
- Fast-path: `suggestedAgent` falls back to best match within the filtered set
- Council: `COUNCIL_FLOW` phases filtered to only include allowed agents
- Handoffs: only created for agents in the filter

### Cross-Model Verification

```
Producer agent output
     │
     v
shouldCrossVerify(tier, config) ──> mode: always | on-complex | off
     │
     ├── skip ──> return output as-is
     │
     └── verify ──> getVerifier(producer) ──> paired verifier agent
                         │
                         v
                    modelCall(verifier, reviewPrompt)
                         │
                         v
                    { approved, issues[], suggestions[] }
                         │
                         ├── approved ──> return original output
                         └── issues ──> append verification notes to result
```

### Checkpoint Flow

```
Long-running task (council or multi-step)
     │
     ├── phase complete ──> POST /task/checkpoint
     │                         { taskId, name, context, agent }
     │                              │
     │                              v
     │                         task.checkpoints[] appended
     │
     └── failure/timeout ──> GET /task/:id/checkpoints
                                  │
                                  v
                             resume from last checkpoint context
```

### Session Fork/Spawn

```
Active session
     │
     ├── :fork ──> POST /session/fork
     │                 │
     │                 v
     │            Copy current state snapshot
     │            Create sibling session (type: 'fork', parentId: original)
     │
     └── :spawn focus="subtask" ──> POST /session/spawn
                                        │
                                        v
                                   Fresh session (type: 'spawn', parentId: original)
                                   Focus field anchors the child's scope
```

### Session Pause/Resume

```
:pause [reason]
     │
     v
POST /session/pause { reason }
     │
     └── activeSession.status = 'paused'
         activeSession.pauseReason = reason
         activeSession.pausedAt = ISO timestamp

:unpause
     │
     v
POST /session/resume
     │
     └── activeSession.status = 'active'
         clear pauseReason/pausedAt
```

The operator `:resume` command handles stale recovery: acks pending handoffs, resets stale tasks to `todo`, and optionally relaunches agent terminals.

### Agent Invocation

```
modelCall(agent, prompt, timeout)
     │
     ├── recordCallStart(agent, model)  [metrics]
     │
     ├── resolve model flags from config/env
     │
     ├── Windows? ──> pipe via stdin (8191 char limit workaround)
     │   │
     │   └── codex? ──> exec mode with output file
     │
     └── recordCallComplete/Error  [metrics]

modelCallAsync(agent, prompt, timeout, opts)
     │
     ├── agent === 'codex' && MCP enabled?
     │   │
     │   ├── yes ──> codexMCP(prompt, opts) ──> JSON-RPC over stdio
     │   │               │
     │   │               └── threadId? ──> multi-turn via codex-reply tool
     │   │
     │   └── no ──> fall back to modelCall() (CLI spawn)
     │
     └── other agents ──> modelCall() directly
```

### Model Resolution

```
Priority chain:
  1. HYDRA_CLAUDE_MODEL env var
  2. hydra.config.json models.claude.active (when override is not "default")
  3. hydra.config.json modeTiers[mode].claude preset
  4. hydra.config.json models.claude.default

Shorthand resolution:
  "sonnet" ──> MODEL_ALIASES.claude.sonnet ──> "claude-sonnet-4-5-20250929"
  "fast"   ──> config.models.claude.fast   ──> "claude-sonnet-4-5-20250929"
```

## Status Bar

The operator console renders a persistent 5-line status bar pinned to the terminal bottom using ANSI scroll regions:

```
initStatusBar(agents)
     │
     ├── Set scroll region: rows 1 through (rows - 5)
     │
     ├── Register agents ──> initialize agentState Map
     │
     └── Listen to metricsEmitter events:
              │
              ├── call:start  ──> setAgentActivity(agent, 'working', model)
              ├── call:complete ──> setAgentActivity(agent, 'idle')
              └── call:error  ──> setAgentActivity(agent, 'error', message)

Data sources (preferred order):
  1. SSE /events/stream ──> real-time daemon events (handoffs, claims, task updates)
  2. Fallback polling /next?agent=... ──> periodic daemon state checks
  3. metricsEmitter ──> local agent call lifecycle events
```

Agent activity metadata: `{ status, action, model, taskTitle, phase, step, updatedAt }`.

Context line displays: mode icon, open task count, dispatch context/last route, session cost, and today's token count.

Module: `lib/hydra-statusbar.mjs`.

## State Management

### Daemon Write Queue

All state mutations go through `enqueueMutation()`:

```
Request ──> enqueueMutation(label, mutator, detail)
                │
                v
           readState() ──> mutator(state) ──> writeState(state)
                │                                    │
                v                                    v
           appendSyncLog()                    appendEvent(type, detail)
                │                                    │
                v                                    v
           writeStatus()                   { id, seq, at, type, category, payload }
                                                     │
                                                     v
                                              broadcastEvent() ──> SSE clients
```

This ensures serialized writes even with concurrent HTTP requests. The write queue is **fault-tolerant** — a failed mutation does not poison subsequent ones. Each mutation's rejection is isolated while the queue continues processing.

### State File Structure

`AI_SYNC_STATE.json`:
- `activeSession` - Current coordination session
- `tasks[]` - Task queue with status, owner, blockedBy, claimToken, worktreePath, checkpoints[]
- `decisions[]` - Recorded decisions
- `blockers[]` - Active blockers
- `handoffs[]` - Agent handoffs (acknowledged or pending)
- `childSessions[]` - Forked/spawned child sessions with parentId, type, focus

### Auto-Behaviors

- **Auto-unblock**: When a task completes, blocked dependents move to `todo`
- **Cycle detection**: `blockedBy` mutations are checked for circular dependencies
- **Auto-archive**: When >20 completed tasks, move to archive file
- **Auto-verify**: Project-aware verification runs on task completion
  (configurable command or auto-detected by stack)

## Event System

NDJSON append-only log at `AI_ORCHESTRATOR_EVENTS.ndjson`:

```json
{"id":"...", "seq":1, "at":"ISO", "type":"mutation", "category":"task", "payload":{"label":"task:add ..."}}
{"id":"...", "seq":2, "at":"ISO", "type":"agent_call_start", "category":"system", "payload":{"agent":"claude"}}
{"id":"...", "seq":3, "at":"ISO", "type":"daemon_start", "category":"system", "payload":{"host":"127.0.0.1","port":4173}}
```

Each event has a **monotonic sequence number** (`seq`) and a **category** for filtered replay.

Event types:
- `daemon_start`, `daemon_stop`
- `mutation` (any state change)
- `auto_archive`
- `verification_start`, `verification_complete`
- `agent_call_start`, `agent_call_complete`, `agent_call_error`

Event categories (auto-classified from event type/label):
- `task` — task mutations (add, update, claim, checkpoint)
- `handoff` — handoff creation, acknowledgment
- `decision` — decision recording
- `blocker` — blocker creation/resolution
- `session` — session start, fork, spawn
- `concierge` — concierge dispatch, summary, error, model switch events
- `system` — daemon lifecycle, agent calls, archive, verification

### Event Replay

`GET /events/replay?from=N&category=X` returns all events since sequence number N, optionally filtered by category. On startup, `initEventSeq()` reads the last event from the NDJSON file to restore the sequence counter.

### Atomic Task Claiming

`POST /task/claim` returns a `claimToken` (UUID) on success. Subsequent `/task/update` calls can include the `claimToken` — if it doesn't match, the update is rejected (preventing stale updates from racing agents). Pass `force: true` to override claim validation for operator/human use.

## Context Tiers

Three context levels matched to agent capabilities:

| Tier | Agent | Contents |
|------|-------|----------|
| **Minimal** | Codex | Task files + types + signatures only |
| **Medium** | Claude | Summary + priorities + git rules (Claude reads more via tools) |
| **Large** | Gemini | Full context + recent git changes + TODO.md + task files |

Context is cached for 60 seconds to avoid redundant file reads.

## Agent Affinity System

Each agent has affinity scores (0-1) for 10 task types:

| Task Type | Gemini | Codex | Claude |
|-----------|--------|-------|--------|
| planning | 0.70 | 0.20 | 0.95 |
| architecture | 0.75 | 0.15 | 0.95 |
| review | 0.95 | 0.40 | 0.85 |
| refactor | 0.65 | 0.70 | 0.80 |
| implementation | 0.60 | 0.95 | 0.60 |
| analysis | 0.98 | 0.30 | 0.75 |
| testing | 0.65 | 0.85 | 0.50 |
| research | 0.90 | 0.25 | 0.70 |
| documentation | 0.50 | 0.40 | 0.80 |
| security | 0.85 | 0.35 | 0.70 |

Task type is auto-classified from title/description via regex patterns. The `POST /task/route` endpoint uses these scores to recommend the best agent.

## Usage Monitoring

```
~/.claude/stats-cache.json
     │
     v
findStatsCache() ──> parseStatsCache()
     │
     v
checkUsage() ──> { level, percent, todayTokens, ... }
     │
     ├── normal ──> no action
     ├── warning ──> one-line alert
     └── critical ──> auto-switch model + contingency menu
```

Contingency options:
1. Switch to fast/cheap model
2. Hand off to Gemini
3. Hand off to Codex
4. Save progress and pause

## Metrics Collection

```
modelCall() ──> recordCallStart(agent, model) ──> handle
     │
     ├── success ──> recordCallComplete(handle, result)
     └── error ──> recordCallError(handle, error)
     │
     v
metricsStore.agents[name] = {
  callsTotal, callsToday, callsSuccess, callsFailed,
  estimatedTokensToday, totalDurationMs, avgDurationMs,
  lastCallAt, lastModel, history[last 20]
}
     │
     v
persistMetrics() ──> hydra-metrics.json (every 30s + on shutdown)
```

Token estimation: ~0.25 tokens per output character (rough heuristic).

## Git Worktree Isolation

When `worktrees.enabled=true` in config, tasks can be assigned isolated git worktrees:

```
POST /task/add { ..., worktree: true }
     │
     v
createWorktree(taskId, baseBranch)
     │
     ├── git worktree add .hydra/worktrees/<taskId> -b hydra/<taskId>
     │
     └── store worktreePath on task record
            │
            v
     modelCall(..., { cwd: worktreePath })  ──> agent works in isolation
            │
            v
     task complete ──> autoCleanup?
            │
            ├── yes ──> removeWorktree(taskId)
            └── no  ──> worktree persists for manual merge
```

Module: `lib/hydra-worktree.mjs` — exports `createWorktree()`, `removeWorktree()`, `getWorktreePath()`, `listWorktrees()`, `mergeWorktree()`, `isWorktreeEnabled()`.

## Codex MCP Integration

When `mcp.codex.enabled=true`, Codex calls use a persistent MCP server process instead of one-shot CLI spawns:

```
modelCallAsync('codex', prompt, timeout, opts)
     │
     v
getCodexMCPClient() ──> lazy init MCPClient
     │
     ├── MCPClient.start() ──> spawn 'codex mcp-server' subprocess
     │       │
     │       └── JSON-RPC over stdin/stdout
     │
     ├── codexMCP(prompt) ──> callTool('codex', { prompt })
     │       │
     │       └── threadId? ──> callTool('codex-reply', { thread_id, message })
     │
     └── idle timeout (300s) ──> auto-close; re-opened on next call
```

Module: `lib/hydra-mcp.mjs` — exports `MCPClient`, `getCodexMCPClient()`, `codexMCP()`, `closeCodexMCP()`.

## Hydra MCP Server

Hydra can be exposed as an MCP server so that AI agents can self-coordinate:

```
Agent (Gemini/Codex/Claude)
     │
     └── MCP tool call (JSON-RPC over stdio)
              │
              v
         hydra-mcp-server.mjs
              │
              └── HTTP request to daemon API
                       │
                       v
                  orchestrator-daemon.mjs
```

8 exposed MCP tools:
- `hydra_tasks_list` — list open tasks with filters
- `hydra_tasks_claim` — claim a task atomically
- `hydra_tasks_update` — update task status/notes
- `hydra_tasks_checkpoint` — save checkpoint
- `hydra_handoffs_pending` — get pending handoffs for an agent
- `hydra_handoffs_ack` — acknowledge a handoff
- `hydra_council_request` — request council deliberation
- `hydra_status` — get daemon health summary

Module: `lib/hydra-mcp-server.mjs` — run with `node lib/hydra-mcp-server.mjs`.
