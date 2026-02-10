# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branch Workflow

Always work on `dev`. Never commit to or switch to `master` unless explicitly told (e.g. "merge to master", "push d>m").

### Commit Rules

1. **Update documentation before every commit.** Before staging and committing, review what changed and update the relevant docs:
   - `CLAUDE.md` — if architecture, modules, exports, commands, or conventions changed.
   - `README.md` — if user-facing features, setup steps, or usage changed. The **Operator Commands** table in README.md must be updated whenever a command is added/removed/renamed.
   - Inline code comments — only where logic isn't self-evident.
   - Skip doc updates only if the change is purely cosmetic or has zero doc impact.

2. **Always commit to `dev` first.** Never commit directly to `master`. When the user asks to merge or push to master, the flow is:
   - Ensure all changes are committed on `dev`.
   - Checkout `master`, merge `dev` into `master`, then switch back to `dev`.
   - Shorthand: "push d>m" or "merge to master" triggers this flow.

## Commands

```bash
npm test                    # Run all tests (Node.js native test runner)
node --test test/hydra-ui.test.mjs  # Run a single test file
npm start                   # Start the daemon (port 4173)
npm run go                  # Launch operator console (interactive REPL)
npm run council -- prompt="..." # Run council deliberation
npm run evolve              # Run autonomous self-improvement
npm run evolve:suggestions  # Manage evolve suggestions backlog
npm run nightly             # Run nightly task automation
npm run tasks               # Scan & execute TODO/FIXME/issues autonomously
npm run tasks:review        # Interactive merge of tasks/* branches
npm run tasks:status        # Show latest tasks run report
npm run tasks:clean         # Delete all tasks/* branches
```

No linter or build step — pure ESM, runs directly with Node.js.

## Architecture

Hydra orchestrates three AI coding agents (Claude Code CLI, Gemini CLI, Codex CLI) through a shared HTTP daemon with task queue, intelligent routing, and multiple dispatch modes.

### Core Flow

```
Operator Console (REPL)
    ├── Concierge (multi-provider streaming: OpenAI → Anthropic → Google fallback)
    └── Daemon (HTTP API, port 4173, event-sourced state)
         ├── Gemini  (analyst role, gemini-3-pro-preview)
         ├── Codex   (implementer role, gpt-5.3-codex)
         └── Claude  (architect role, claude-opus-4-6)
```

### Key Modules

- **`hydra-operator.mjs`** — Interactive command center. 5 orchestration modes (auto, council, dispatch, smart, chat). Manages workers, status bar, concierge, model switching. Smart ghost text: after `:status` with blocked tasks, shows Tab-submittable suggestion (deterministic + async AI upgrade via `conciergeSuggest()`). This is the largest module (~115KB).
- **`orchestrator-daemon.mjs`** — HTTP server with event-sourced state. Routes split into `daemon/read-routes.mjs` and `daemon/write-routes.mjs`. Handles task lifecycle, handoffs, sessions, worktrees.
- **`hydra-agents.mjs`** — Agent registry. Each agent has CLI commands, invoke modes (interactive/nonInteractive/headless), task affinities, council roles. Contains `getActiveModel()`, task classification, best-agent routing. Exports `MODEL_REASONING_CAPS` (model prefix → reasoning capabilities lookup), `getModelReasoningCaps(modelId)`, `getEffortOptionsForModel(modelId)`, `formatEffortDisplay(modelId, effortValue)`. `getModelFlags()` adds `--reasoning-effort` for o-series (codex). Note: Claude thinking budget is API-only (handled in `hydra-anthropic.mjs`) — the CLI does not support `--thinking-budget`.
- **`hydra-config.mjs`** — Central config with `HYDRA_ROOT`, project detection, `loadHydraConfig()`/`saveHydraConfig()`, `getRoleConfig(roleName)`. Config file: `hydra.config.json`. Config sections include `github` (enabled, defaultBase, draft, labels, reviewers, prBodyFooter), `evolve.suggestions` (enabled, autoPopulateFromRejected, autoPopulateFromDeferred, maxPendingSuggestions, maxAttemptsPerSuggestion), `nightly` (enabled, baseBranch, branchPrefix, maxTasks, maxHours, perTaskTimeoutMs, sources, aiDiscovery, budget, tasks, investigator), `providers` (openai.adminKey, anthropic.adminKey, google), `modelRecovery` (enabled, autoPersist, headlessFallback), `rateLimits` (maxRetries, baseDelayMs, maxDelayMs).
- **`hydra-council.mjs`** — 4-phase deliberation: propose (Claude) → critique (Gemini) → refine (Claude) → implement (Codex). Async agent calls via `executeAgentWithRecovery()` with rate limit retry (backoff + 1 retry on 429), doctor notification on phase failure, and recovery tracking in transcript.
- **`hydra-evolve.mjs`** — 7-phase autonomous improvement rounds with budget tracking, investigator self-healing, knowledge accumulation, and rate limit resilience (exponential backoff on 429/RESOURCE_EXHAUSTED for Gemini direct API and all agents via `executeAgentWithRetry`).
- **`hydra-concierge.mjs`** — Multi-provider conversational front-end (OpenAI → Anthropic → Google fallback chain). Detects `[DISPATCH]` intent to escalate. Enriched system prompt with git info, recent completions, active workers. Bidirectional daemon communication via `POST /events/push`. Imports `COST_PER_1K` and `estimateCost` from `hydra-provider-usage.mjs` (re-exports `COST_PER_1K` for backward compat). Exports `getActiveProvider()`, `getConciergeModelLabel()`, `switchConciergeModel()`, `exportConversation()`, `getRecentContext()`, `conciergeSuggest()` (stateless one-shot suggestion for ghost text).
- **`hydra-concierge-providers.mjs`** — Provider abstraction layer. `detectAvailableProviders()`, `buildFallbackChain()`, `streamWithFallback()`. Lazy-loads provider modules via `await import()`.
- **`hydra-anthropic.mjs`** — Streaming client for Anthropic Messages API. Mirrors `hydra-openai.mjs` pattern. Supports extended thinking via `cfg.thinkingBudget` (adds `thinking.budget_tokens` to request body). Records provider usage via `hydra-provider-usage.mjs`.
- **`hydra-google.mjs`** — Streaming client for Google Gemini Generative Language API. Records provider usage via `hydra-provider-usage.mjs`.
- **`hydra-metrics.mjs`** — In-memory metrics store with file persistence. Handle-based API: `recordCallStart(agent, model)` returns handle, `recordCallComplete(handle, result)` accepts `result.stdout` or `result.output`. Extracts real tokens from Claude JSON and Codex JSONL output. Exports `getRecentTokens(agentName, windowMs)` for sliding window calculations, `getSessionUsage()`, `getMetricsSummary()`, `metricsEmitter` (EventEmitter).
- **`hydra-usage.mjs`** — Token usage monitor. Reads Claude Code's `stats-cache.json` + hydra-metrics fallback. Three budget tiers: weekly (primary, matches Claude's actual limit structure), daily (secondary), and sliding window (`windowHours`/`windowTokenBudget`). `checkUsage()` returns combined assessment with `weekly` sub-object. Uses local dates for stats-cache comparison (not UTC). Distinguishes `hydra-metrics-real` vs `hydra-metrics-estimate` sources. Standalone CLI: `node lib/hydra-usage.mjs`.
- **`hydra-worker.mjs`** — `AgentWorker` class (EventEmitter). Headless background agent execution with claim→execute→report loop. Records per-call metrics. Codex workers use `--json` for JSONL output with real token usage extraction. Events include `title` for contextual display.
- **`hydra-ui.mjs`** — All terminal rendering. Uses `picocolors` (`pc`) exclusively — never chalk. Exports `AGENT_COLORS`, `AGENT_ICONS`, `stripAnsi`, formatters. `createSpinner()` supports themed styles with per-style colors: `solar` (yellow, dispatch agents), `orbital` (magenta, council deliberation), `stellar` (yellow, concierge thinking), `eclipse` (white, dispatch handoff). Custom color via `opts.color`.
- **`hydra-statusbar.mjs`** — 5-line persistent ANSI footer. SSE event streaming preferred, polling fallback. Ticker events show task/handoff context (title/summary) alongside IDs.
- **`hydra-prompt-choice.mjs`** — Interactive numbered-choice prompt with rounded box UI. Dynamic width (60-120 cols, 90% terminal), word-wrapped context values, cooperative readline lock, auto-accept mode, freeform input support, animated box draw-in.
- **`hydra-roster.mjs`** — Inline REPL editor for role→agent→model assignments. Walks each role in `config.roles`, offers keep/change/skip, then agent→model→reasoning pickers. Uses `promptChoice()` and `getEffortOptionsForModel()`. Exports `runRosterEditor(rl)`. Accessed via `:roster` command.
- **`hydra-openai.mjs`** — Shared `streamCompletion()` for OpenAI API. Callers must always pass `cfg.model`. Records provider usage via `hydra-provider-usage.mjs`.
- **`hydra-sub-agents.mjs`** — Built-in virtual sub-agent definitions (security-reviewer, test-writer, doc-generator, researcher, evolve-researcher, failure-doctor). Registered at startup via `registerBuiltInSubAgents()`.
- **`hydra-agent-forge.mjs`** — Multi-model agent creation pipeline. 5-phase: ANALYZE (Gemini) → DESIGN (Claude) → CRITIQUE (Gemini) → REFINE (Claude) → TEST (optional). Exports `runForgeWizard()`, `forgeAgent()`, `runForgePipeline()`, `analyzeCodebase()`, `validateAgentSpec()`, `testForgedAgent()`, `persistForgedAgent()`, `removeForgedAgent()`, `loadForgeRegistry()`/`saveForgeRegistry()`, `listForgedAgents()`, `generateSamplePrompt()`. Metadata stored in `docs/coordination/forge/FORGE_REGISTRY.json`. Config: `forge.enabled`, `.autoTest`, `.phaseTimeoutMs`, `.storageDir`.
- **`hydra-model-recovery.mjs`** — Post-hoc model error detection, rate limit handling, and fallback. Detects model unavailability errors and offers fallback selection. Also detects rate limit / quota errors (429, RESOURCE_EXHAUSTED, QUOTA_EXHAUSTED) with exponential backoff support. Exports `detectModelError(agent, result)`, `detectRateLimitError(agent, result)`, `calculateBackoff(attempt, opts)`, `getFallbackCandidates(agent, failedModel)`, `recoverFromModelError(agent, failedModel, opts)`, `isModelRecoveryEnabled()`. Interactive mode uses `promptChoice()` for user selection; headless mode auto-selects first candidate. Config: `modelRecovery.enabled`, `.autoPersist`, `.headlessFallback`; `rateLimits.maxRetries`, `.baseDelayMs`, `.maxDelayMs`.
- **`hydra-env.mjs`** — Minimal `.env` loader. Auto-loads on import. Real env vars take priority.
- **`hydra-github.mjs`** — GitHub integration via `gh` CLI. Exports `gh()`, `isGhAvailable()`, `isGhAuthenticated()`, `detectRepo()`, `createPR()`, `listPRs()`, `getPR()`, `mergePR()`, `closePR()`, `pushBranchAndCreatePR()`, `getGitHubConfig()`. Auto-generates PR title/body from branch name and commit log. Applies config defaults (labels, reviewers, draft, footer).
- **`hydra-shared/`** — Shared infrastructure for nightly and evolve pipelines:
  - `git-ops.mjs` — Git helpers (parameterized baseBranch): `git()`, `getCurrentBranch()`, `checkoutBranch()`, `createBranch()`, `getBranchStats()`, `smartMerge()`, plus remote sync helpers: `getRemoteUrl()`, `parseRemoteUrl()`, `fetchOrigin()`, `pushBranch()`, `hasRemote()`, `getTrackingBranch()`, `isAheadOfRemote()`.
  - `constants.mjs` — `BASE_PROTECTED_FILES`, `BASE_PROTECTED_PATTERNS`, `BLOCKED_COMMANDS`
  - `guardrails.mjs` — `verifyBranch()`, `isCleanWorkingTree()`, `buildSafetyPrompt()` (supports `attribution` param for commit trailers), `scanBranchViolations()`
  - `budget-tracker.mjs` — Base `BudgetTracker` class with configurable thresholds
  - `agent-executor.mjs` — Unified `executeAgent()` with stdin piping, stderr capture, progress ticking. Auto-resolves codex model via `getActiveModel()`. Returns `{ output, stdout, stderr, ... }` (`stdout` alias for metrics compatibility). Accepts `opts.reasoningEffort` for role-specific overrides. Adds `--reasoning-effort` for o-series (codex). Note: Claude thinking budget is API-only — not passed as CLI flag. Also exports `executeAgentWithRecovery()` — wraps `executeAgent()` with automatic model-error detection and fallback retry via `hydra-model-recovery.mjs`.
  - `review-common.mjs` — Interactive review helpers: `handleBranchAction()` (with `[p]r` option when `gh` available, `useSmartMerge` option for auto-rebase), `loadLatestReport()`, `cleanBranches()`
- **`hydra-evolve-suggestions.mjs`** — Persistent suggestions backlog for evolve pipeline. Stores improvement ideas from failed/deferred rounds, user input, and review sessions. Exports `loadSuggestions()`, `saveSuggestions()`, `addSuggestion()`, `updateSuggestion()`, `removeSuggestion()`, `getPendingSuggestions()`, `getSuggestionById()`, `searchSuggestions()`, `createSuggestionFromRound()`, `promptSuggestionPicker()`, `getSuggestionStats()`, `formatSuggestionsForPrompt()`. Storage: `docs/coordination/evolve/SUGGESTIONS.json`.
- **`hydra-evolve-suggestions-cli.mjs`** — Standalone CLI for managing suggestions backlog. Subcommands: `list`, `add`, `remove`, `reset`, `import`, `stats`.
- **`hydra-activity.mjs`** — Real-time activity digest for concierge situational awareness. `detectSituationalQuery()` classifies "What's going on?" style queries. `buildActivityDigest()` fetches `GET /activity` + merges local state. `formatDigestForPrompt()` renders structured digest. `generateSitrep()` produces AI-narrated situation reports via the concierge provider chain (falls back to raw digest if no provider available). Ring buffer via `pushActivity()`/`getRecentActivity()`. Annotation helpers: `annotateDispatch()`, `annotateHandoff()`, `annotateCompletion()`.
- **`hydra-codebase-context.mjs`** — Codebase knowledge injection for concierge. `loadCodebaseContext()` parses CLAUDE.md sections + builds module index. `detectCodebaseQuery()` classifies architecture questions by topic. `getTopicContext(topic)` returns focused context (12 topics: dispatch, council, config, workers, agents, concierge, evolve, daemon, ui, modules, github, metrics). `getBaselineContext()` returns permanent baseline for system prompt. `searchKnowledgeBase()` queries evolve KB. `getConfigReference()` formats config sections.
- **`hydra-tasks-scanner.mjs`** — Aggregates work items from code comments (git grep TODO/FIXME/HACK/XXX), `docs/TODO.md` unchecked items, and GitHub issues. Exports `scanAllSources()`, `scanTodoComments()`, `scanTodoMd()`, `scanGitHubIssues()`, `createUserTask()`, `deduplicateTasks()`, `prioritizeTasks()`, `taskToSlug()`. Returns `ScannedTask[]` with id, title, slug, source, taskType, suggestedAgent, complexity, priority.
- **`hydra-tasks.mjs`** — Autonomous tasks runner. Interactive setup (scan → select → budget) then executes per-task lifecycle: CLASSIFY → PLAN (complex only) → EXECUTE → VERIFY → DECIDE (council-lite for complex). Branch isolation (`tasks/{date}/{slug}`), BudgetTracker with 4 thresholds, investigator self-healing, model recovery. Generates JSON + Markdown reports to `docs/coordination/tasks/`.
- **`hydra-tasks-review.mjs`** — Post-run interactive review. Subcommands: `review` (walk branches, merge/skip/diff/delete/PR), `status` (show latest report), `clean` (delete all `tasks/*` branches). Same pattern as `hydra-nightly-review.mjs`.
- **`hydra-nightly.mjs`** — Autonomous overnight task execution. 6-phase pipeline: SCAN → DISCOVER → PRIORITIZE → SELECT (optional, `--interactive`) → EXECUTE → REPORT. SELECT phase presents tasks grouped by source with interactive pick/add/confirm. EXECUTE phase renders a live progress dashboard (task checklist with status icons, budget gauge, elapsed time, per-task agent progress). Config-driven via `nightly` section. Supports `--dry-run`, `--no-discovery`, `--interactive`, CLI overrides.
- **`hydra-nightly-discovery.mjs`** — AI discovery phase for nightly pipeline. Dispatches an agent (default: gemini) to analyze the codebase and propose improvement tasks. Returns `ScannedTask[]` for merging. Non-blocking (failures return `[]`). Exports `runDiscovery(projectRoot, opts)`.
- **`hydra-nightly-review.mjs`** — Post-run interactive review. Reads `baseBranch` from report JSON. Smart merge via `smartMerge()` (auto-rebases when base has advanced). Dev-advanced detection warns when base has diverged. Subcommands: `review`, `status`, `clean`.
- **`hydra-mcp-server.mjs`** — MCP server exposing Hydra tools via JSON-RPC over stdio. Two modes: **standalone** (`hydra_ask` works without daemon — directly invokes agent CLIs via `executeAgent()`) and **daemon** (task queue, handoffs, council tools when daemon is running). Registered as `hydra` MCP server for Claude Code.
- **`hydra-investigator.mjs`** — Re-exports from `hydra-evolve-investigator.mjs`. Self-healing failure diagnosis (shared).
- **`hydra-knowledge.mjs`** — Re-exports from `hydra-evolve-knowledge.mjs`. Persistent knowledge base (shared).
- **`hydra-doctor.mjs`** — Higher-level failure diagnostic and triage layer. Fires on non-trivial failures in evolve/nightly/tasks. Calls existing investigator for diagnosis, triages into follow-ups (daemon task, suggestion backlog entry, or KB learning), and tracks recurring error patterns via append-only NDJSON log. Exports `initDoctor()`, `isDoctorEnabled()`, `diagnose(failure)`, `getDoctorStats()`, `getDoctorLog(limit)`, `resetDoctor()`. Storage: `docs/coordination/doctor/DOCTOR_LOG.ndjson`. Config: `doctor.enabled`, `.autoCreateTasks`, `.autoCreateSuggestions`, `.addToKnowledgeBase`, `.recurringThreshold`, `.recurringWindowDays`. Accessible via `:doctor` operator command.
- **`hydra-resume-scanner.mjs`** — Unified resumable state detection. Scans daemon (paused/stale/handoffs), evolve session state, council checkpoints, unmerged branches (evolve/nightly/tasks), and pending suggestions in parallel via `Promise.allSettled`. Exports `scanResumableState({ baseUrl, projectRoot })` returning `ResumableItem[]`. Used by the unified `:resume` command.
- **`hydra-provider-usage.mjs`** — Per-provider token usage tracking (local + external billing APIs). Single source of truth for `COST_PER_1K` pricing table (moved from concierge). Two-layer: session counters from streaming calls + external API queries (OpenAI/Anthropic admin keys). Exports `recordProviderUsage()`, `getProviderUsage()`, `getProviderSummary()`, `getExternalSummary()`, `loadProviderUsage()`, `saveProviderUsage()`, `resetSessionUsage()`, `refreshExternalUsage()`, `COST_PER_1K`, `estimateCost()`. Persistence: `docs/coordination/provider-usage.json` (7-day retention). Config: `providers.openai.adminKey`, `providers.anthropic.adminKey` (or env `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`).

### Commit Attribution

Automated pipelines (evolve, nightly, tasks) add git trailers to commits for provenance:
```
Originated-By: hydra-evolve
Executed-By: codex
```
- `buildSafetyPrompt()` accepts `attribution: { pipeline, agent }` to instruct agents to include trailers
- `stageAndCommit()` accepts `opts.originatedBy` and `opts.executedBy` to append trailers programmatically

### Dispatch Modes

1. **Auto** — Classifies prompt complexity → fast-path simple tasks, mini-round triage for complex
2. **Council** — Full multi-round deliberation across agents
3. **Dispatch** — Sequential pipeline: Claude → Gemini → Codex
4. **Smart** — Auto-selects model tier (economy/balanced/performance) per prompt
5. **Chat** — Concierge conversational layer, escalates with `!` prefix or `[DISPATCH]` intent

### Task Routing

10 task types (planning, architecture, review, refactor, implementation, analysis, testing, security, research, documentation) × 3 physical agents + 6 virtual sub-agents with affinity scores. `classifyTask()` in hydra-agents.mjs selects the optimal agent. Virtual sub-agents (e.g. `security-reviewer`) resolve to their base physical agent for CLI dispatch via `resolvePhysicalAgent()`.

## Code Conventions

- **ESM only** (`"type": "module"` in package.json). All files use `import`/`export`.
- **Two dependencies**: `picocolors` for terminal colors, `cross-spawn` for cross-platform process spawning. Everything else is pure Node.js.
- **Agent names** are always lowercase strings: `claude`, `gemini`, `codex`.
- **HTTP helpers**: Use `request()` from `hydra-utils.mjs` for daemon calls. Status bar uses `fetch()` directly (lightweight polling).
- **Config access**: `loadHydraConfig()` returns cached config. `getRoleConfig(roleName)` for role-specific model/agent lookups.
- **Model references**: Config-driven via `roles` and `models` sections in `hydra-config.mjs`. Don't hardcode model IDs — use `getActiveModel(agent)` or `getRoleConfig(role)`. Codex always requires an explicit `--model` flag (its own `~/.codex/config.toml` may differ from Hydra's config).
- **Interactive prompts**: Use `promptChoice()` from `hydra-prompt-choice.mjs` with cooperative readline lock. Boxes dynamically size to terminal width (60-120 columns, 90% of terminal width) and word-wrap long context values.
- **PowerShell launchers** in `bin/` — `hydra.ps1` starts the full system (daemon + agent heads + operator).

## Test Patterns

Tests use Node.js native `node:test` module with `node:assert`. No external test framework.

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
```

Integration tests (`*.integration.test.mjs`) spin up the daemon on an ephemeral port and test HTTP endpoints.

## MCP Tool Escalation

Two MCP servers are available when working in this project. Use them to get second opinions, delegate work, or cross-verify your reasoning.

### `hydra_ask` — Ask Gemini or Codex directly

Invokes the agent CLI headlessly. No daemon needed.

- **`agent: "gemini"`** — Gemini 3 Pro. Best for: code review, architecture critique, analysis, research, identifying edge cases, security review.
- **`agent: "codex"`** — Codex (GPT-5.3 Codex). Best for: implementation, refactoring, code generation, writing tests, quick prototyping.

**When to use:**
- Reviewing your own generated code for bugs or missed edge cases
- Getting an alternative implementation approach
- Security or concurrency analysis on tricky code
- When the user explicitly asks for a second opinion

**When NOT to use:**
- Trivial/obvious changes (a typo fix doesn't need review)
- Asking questions you already know the answer to
- Every single code change (be cost-conscious)

### `ask_gpt53` / `ask_gpt_fast` — OpenAI API calls

Direct OpenAI Responses API calls (separate from Hydra's agent CLIs).

- **`ask_gpt_fast`** (gpt-4.1-mini) — Cheap/fast. Quick summaries, small refactors, simple reviews.
- **`ask_gpt53`** (GPT-5.3) — Deep reasoning. Architecture decisions, complex bugs, security analysis.
- **`ask_gpt52`** — Alias for `ask_gpt53` (backward compat).
