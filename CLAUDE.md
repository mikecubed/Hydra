# CLAUDE.md

> **Note:** This file is internal developer tooling configuration for [Claude Code](https://claude.ai/code). It is not user-facing documentation — see [README.md](README.md) for project overview and usage.

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
npm run init                # Generate HYDRA.md in current project
npm run nightly             # Run nightly task automation
npm run setup               # Register Hydra MCP server in all detected AI CLIs
npm run tasks               # Scan & execute TODO/FIXME/issues autonomously
npm run tasks:review        # Interactive merge of tasks/* branches
npm run tasks:status        # Show latest tasks run report
npm run tasks:clean         # Delete all tasks/* branches
npm run eval                # Run routing evaluation against golden corpus
```

No linter or build step — pure ESM, runs directly with Node.js.

## Architecture

Hydra orchestrates three AI coding agents (Claude Code CLI, Gemini CLI, Codex CLI) through a shared HTTP daemon with task queue, intelligent routing, and multiple dispatch modes.

### Core Flow

```
Operator Console (REPL)
    ├── Concierge (multi-provider streaming: OpenAI → Anthropic → Google fallback)
    └── Daemon (HTTP API, port 4173, event-sourced state)
         ├── Gemini  (analyst role, gemini-3.1-pro-preview)
         ├── Codex   (implementer role, gpt-5.4)
         └── Claude  (architect role, claude-opus-4-6)
```

### Key Modules

- **`hydra-operator.mjs`** — Interactive command center. 5 orchestration modes (auto, council, dispatch, smart, chat). Auto mode uses 3-way routing: single (fast-path), tandem (`publishTandemDelegation()` creates 2 tasks + 2 handoffs), or council (direct, skipping mini-round triage). Council gate warns when council is overkill. Manages workers, status bar, concierge, model switching. `:dry-run` toggle previews dispatch route/agent selection without creating tasks. Smart ghost text: after `:status` with blocked tasks, shows Tab-submittable suggestion (deterministic + async AI upgrade via `conciergeSuggest()`). This is the largest module (~115KB).
- **`orchestrator-daemon.mjs`** — HTTP server with event-sourced state. Routes split into `daemon/read-routes.mjs` and `daemon/write-routes.mjs`. Handles task lifecycle, handoffs, sessions, worktrees. Heartbeat-based crash recovery: stale detector runs every 60s, requeues tasks with expired heartbeats (configurable timeout), moves exhausted-retry tasks to dead-letter queue. Dead-letter queue for exhausted-retry tasks (failCount >= maxAttempts). Event snapshots (`docs/coordination/snapshots/`) with auto-compaction. Idempotency keys (5min TTL) for mutation endpoints. Endpoints: `GET /dead-letter`, `POST /dead-letter/retry`, `POST /admin/compact`, `POST /task/:id/heartbeat`. Config: `workers.retry.maxAttempts`, `workers.heartbeatTimeoutMs`, `daemon.snapshot.everyNEvents`, `.retentionCount`.
- **`hydra-model-profiles.mjs`** — Single source of truth for model data (benchmarks, pricing, speed, capabilities, rate limits). Zero Hydra imports — sits at the bottom of the import tree. Exports `MODEL_PROFILES` (17 models), `ROLE_DEFAULTS` (6 roles), `AGENT_PRESETS` (3 agents × 3 tiers). Query functions: `getProfile(modelId)`, `getProfilesForAgent(agent)`, `getAgentPresets(agent)`, `getRoleRecommendation(role)`, `getFallbackOrder(agent, excludeId)`, `formatBenchmarkAnnotation(modelId, opts?)`, `getDefaultRoles()`, `getCostTable()`, `getReasoningCapsMap()`, `getShortName(modelId)`, `getConciergeFallbackChain()`, `getModeTiers()`, `getRateLimits(modelId, tier)`. Each profile includes per-tier `rateLimits` (RPM, TPM/ITPM/OTPM, RPD) keyed by tier number or `'free'`. Drives defaults in hydra-config, pricing in hydra-provider-usage, reasoning caps in hydra-agents, short names in hydra-ui, fallback ordering in hydra-model-recovery, rate limits in hydra-rate-limits, and benchmark annotations in hydra-roster and hydra-models-select. Source data: `docs/MODEL_PROFILES.md`.
- **`hydra-agents.mjs`** — Agent registry. Each agent has CLI commands, invoke modes (interactive/nonInteractive/headless), task affinities, council roles. Contains `getActiveModel()`, task classification, best-agent routing with adaptive affinity learning. `recordTaskOutcome(agent, taskType, outcome)` tracks success rates and adjusts affinity scores (persisted to `docs/coordination/agent-affinities.json`). `bestAgentFor(taskType)` merges learned overrides with base affinities when `agents.affinityLearning.enabled`. Exports `MODEL_REASONING_CAPS` (derived from hydra-model-profiles.mjs), `getModelReasoningCaps(modelId)`, `getEffortOptionsForModel(modelId)`, `formatEffortDisplay(modelId, effortValue)`, `recordTaskOutcome(agent, taskType, outcome)`, `invalidateAffinityCache()`. `getModelFlags()` adds `--reasoning-effort` for o-series (codex). Config: `agents.affinityLearning.enabled`, `.decayFactor`, `.minSampleSize`. Note: Claude thinking budget is API-only (handled in `hydra-anthropic.mjs`) — the CLI does not support `--thinking-budget`.
- **`hydra-config.mjs`** — Central config with `HYDRA_ROOT`, project detection, `loadHydraConfig()`/`saveHydraConfig()`, `getRoleConfig(roleName)`. Config file: `hydra.config.json`. Model defaults, roles, recommendations, modeTiers, and concierge fallbackChain are derived from hydra-model-profiles.mjs (user config still overrides via mergeWithDefaults). Config sections include `github` (enabled, defaultBase, draft, labels, reviewers, prBodyFooter), `evolve.suggestions` (enabled, autoPopulateFromRejected, autoPopulateFromDeferred, maxPendingSuggestions, maxAttemptsPerSuggestion), `nightly` (enabled, baseBranch, branchPrefix, maxTasks, maxHours, perTaskTimeoutMs, sources, aiDiscovery, budget, tasks, investigator), `providers` (openai.adminKey, openai.tier, anthropic.adminKey, anthropic.tier, google.tier), `routing` (useLegacyTriage, councilGate, tandemEnabled, councilMode, councilTimeoutMs), `modelRecovery` (enabled, autoPersist, headlessFallback), `rateLimits` (maxRetries, baseDelayMs, maxDelayMs), `persona` (enabled, name, tone, verbosity, formality, humor, identity, voice, agentFraming, processLabels, presets). Provider `tier` values: OpenAI 1-5, Anthropic 1-4, Google `'free'`/1/2 — used by `hydra-rate-limits.mjs` for capacity tracking.
- **`hydra-council.mjs`** — Two execution modes via `routing.councilMode`. **Sequential** (default): propose (Claude) → critique (Gemini) → refine (Claude) → implement (Codex). **Adversarial** (`'adversarial'`): DIVERGE (all 3 agents answer independently in parallel) → ATTACK (all 3 agents attack each other's strongest assumptions in parallel) → SYNTHESIZE (Claude as designated decider, scores criteria, reversibility tiebreaker) → IMPLEMENT (Codex). Both modes use structured convergence: explicit decision criteria (`correctness`, `complexity`, `reversibility`, `user_impact`), assumption challenges, final synthesis object with owner/confidence/nextAction/reversibleFirstStep — no majority vote. `runCrossVerification()` extended with `strongestAssumption`, `attackVector`, `criteriaScores`. Exports `COUNCIL_DECISION_CRITERIA`, `buildStepPrompt()`, `synthesizeCouncilTranscript()`. Async agent calls via `executeAgentWithRecovery()` with rate limit retry (backoff + 1 retry on 429), timeout retry (strips transcript context via empty transcript to `buildStepPrompt()`, retries once with bare prompt — shown as `(compacted retry)` in spinner), doctor notification on phase failure, and recovery tracking in transcript. Phase timeout configurable via `routing.councilTimeoutMs` (default: 420000ms / 7min).
- **`hydra-evolve.mjs`** — 7-phase autonomous improvement rounds with budget tracking, investigator self-healing, knowledge accumulation, and rate limit resilience (exponential backoff on 429/RESOURCE_EXHAUSTED for Gemini direct API and all agents via `executeAgentWithRetry`).
- **`hydra-concierge.mjs`** — Multi-provider conversational front-end (OpenAI → Anthropic → Google fallback chain). Detects `[DISPATCH]` intent to escalate. Enriched system prompt with git info, recent completions, active workers. Bidirectional daemon communication via `POST /events/push`. Imports `COST_PER_1K` and `estimateCost` from `hydra-provider-usage.mjs` (re-exports `COST_PER_1K` for backward compat). Exports `getActiveProvider()`, `getConciergeModelLabel()`, `switchConciergeModel()`, `exportConversation()`, `getRecentContext()`, `conciergeSuggest()` (stateless one-shot suggestion for ghost text).
- **`hydra-concierge-providers.mjs`** — Provider abstraction layer with capacity-aware fallback. `detectAvailableProviders()`, `buildFallbackChain()`, `streamWithFallback()`. Dynamically reorders providers by remaining capacity (healthiest first via `getHealthiestProvider()`), performs pre-request capacity checks (`canMakeRequest()`), and skips exhausted providers. Lazy-loads provider modules via `await import()`.
- **`hydra-anthropic.mjs`** — Streaming client for Anthropic Messages API. Supports extended thinking via `cfg.thinkingBudget`. Uses `hydra-streaming-middleware.mjs` pipeline for all cross-cutting concerns. Core function handles Anthropic-specific SSE format, system message extraction, and rate limit header parsing.
- **`hydra-google.mjs`** — Streaming client for Google Gemini Generative Language API. Uses `hydra-streaming-middleware.mjs` pipeline. Core function handles Google-specific role mapping, `systemInstruction`, and `RESOURCE_EXHAUSTED` detection. Returns `rateLimits: null` (Google doesn't send rate limit headers on success).
- **`hydra-metrics.mjs`** — In-memory metrics store with file persistence. Handle-based API: `recordCallStart(agent, model)` returns handle, `recordCallComplete(handle, result)` accepts `result.stdout` or `result.output` with optional `result.outcome` (`success`/`partial`/`failed`/`rejected`). Extracts real tokens from Claude JSON and Codex JSONL output. Latency percentiles (p50/p95/p99) via `calculatePercentiles()`. SLO checking: `checkSLOs(sloConfig)` compares per-agent p95 latency and error rate against thresholds. Cost analysis: `getCostByOutcome(agentName?)` aggregates history by outcome. Exports `getRecentTokens(agentName, windowMs)`, `getSessionUsage()`, `getMetricsSummary()`, `checkSLOs(sloConfig)`, `getCostByOutcome(agentName?)`, `metricsEmitter` (EventEmitter). Config: `metrics.slo.{agent}.maxP95Ms`, `.maxErrorRate`, `metrics.alerts.enabled`.
- **`hydra-usage.mjs`** — Token usage monitor. Reads Claude Code's `stats-cache.json` + hydra-metrics fallback. Three budget tiers: weekly (primary, matches Claude's actual limit structure), daily (secondary), and sliding window (`windowHours`/`windowTokenBudget`). `checkUsage()` returns combined assessment with `weekly` sub-object. Uses local dates for stats-cache comparison (not UTC). Distinguishes `hydra-metrics-real` vs `hydra-metrics-estimate` sources. Standalone CLI: `node lib/hydra-usage.mjs`.
- **`hydra-worker.mjs`** — `AgentWorker` class (EventEmitter). Headless background agent execution with claim→execute→report loop. Sends periodic heartbeats to daemon during task execution (`POST /task/:id/heartbeat`) for crash recovery. Records per-call metrics. Codex workers use `--json` for JSONL output with real token usage extraction. Events include `title` for contextual display. Config: `workers.heartbeatIntervalMs` (default: 30s), `workers.heartbeatTimeoutMs` (default: 90s).
- **`hydra-ui.mjs`** — All terminal rendering. Uses `picocolors` (`pc`) exclusively — never chalk. Exports `AGENT_COLORS`, `AGENT_ICONS`, `stripAnsi`, formatters. `createSpinner()` supports themed styles with per-style colors: `solar` (yellow, dispatch agents), `orbital` (magenta, council deliberation), `stellar` (yellow, concierge thinking), `eclipse` (white, dispatch handoff). Custom color via `opts.color`.
- **`hydra-statusbar.mjs`** — 5-line persistent ANSI footer. SSE event streaming preferred, polling fallback. Ticker events show task/handoff context (title/summary) alongside IDs.
- **`hydra-prompt-choice.mjs`** — Interactive numbered-choice prompt with rounded box UI. Dynamic width (60-120 cols, 90% terminal), word-wrapped context values, cooperative readline lock, auto-accept mode, freeform input support, animated box draw-in. Supports `multiSelect: true` mode with checkbox rendering (`[x]`/`[ ]`), toggle input (numbers, ranges `1-3`, `a` for all), and `preSelected` values. Exports `parseMultiSelectInput()`, `confirmActionPlan(rl, opts)` for action plan summary + binary confirm.
- **`hydra-roster.mjs`** — Inline REPL editor for role→agent→model assignments. Walks each role in `config.roles`, offers keep/change/skip, then agent→model→reasoning pickers. Uses `promptChoice()` and `getEffortOptionsForModel()`. Exports `runRosterEditor(rl)`. Accessed via `:roster` command.
- **`hydra-persona.mjs`** — Unified personality layer. Config-driven identity, voice, tone knobs, presets, and interactive editor. Exports `getPersonaConfig()`, `isPersonaEnabled()`, `getConciergeIdentity()`, `getAgentFraming(agentName)`, `getProcessLabel(processKey)`, `invalidatePersonaCache()`, `applyPreset(presetName)`, `listPresets()`, `showPersonaSummary()`, `runPersonaEditor(rl)`. Config: `persona.enabled`, `.name`, `.tone` (formal/balanced/casual/terse), `.verbosity` (minimal/concise/detailed), `.formality` (formal/neutral/informal), `.humor`, `.identity`, `.voice`, `.agentFraming`, `.processLabels`, `.presets`. Accessed via `:persona` command.
- **`hydra-openai.mjs`** — Shared `streamCompletion()` for OpenAI API. Callers must always pass `cfg.model`. Uses `hydra-streaming-middleware.mjs` pipeline for rate limiting, circuit breaking, retry, usage tracking, header capture, telemetry, and latency measurement. Core function handles only HTTP call + SSE parsing.
- **`hydra-sub-agents.mjs`** — Built-in virtual sub-agent definitions (security-reviewer, test-writer, doc-generator, researcher, evolve-researcher, failure-doctor). Registered at startup via `registerBuiltInSubAgents()`.
- **`hydra-agent-forge.mjs`** — Multi-model agent creation pipeline. 5-phase: ANALYZE (Gemini) → DESIGN (Claude) → CRITIQUE (Gemini) → REFINE (Claude) → TEST (optional). Exports `runForgeWizard()`, `forgeAgent()`, `runForgePipeline()`, `analyzeCodebase()`, `validateAgentSpec()`, `testForgedAgent()`, `persistForgedAgent()`, `removeForgedAgent()`, `loadForgeRegistry()`/`saveForgeRegistry()`, `listForgedAgents()`, `generateSamplePrompt()`. Metadata stored in `docs/coordination/forge/FORGE_REGISTRY.json`. Config: `forge.enabled`, `.autoTest`, `.phaseTimeoutMs`, `.storageDir`.
- **`hydra-model-recovery.mjs`** — Post-hoc model error detection, rate/usage limit handling, circuit breaker, Codex-specific error detection, and fallback. Four detection tiers: (1) `detectUsageLimitError()` — long-term account quota exhaustion (days until reset, NO retries); (2) `detectRateLimitError()` — transient rate limits (retry with backoff); (3) `detectCodexError()` — Codex-specific non-model errors that should NOT be retried with a different model. Expanded categories: sandbox, auth, invocation, internal ("something went wrong", "unexpected error"), config, context-overflow, timeout, network, signal, silent-crash, codex-jsonl-error, codex-unknown (catch-all with rich diagnostics — ensures no Codex failure goes undetected); (4) `detectModelError()` — model unavailability (fallback selection). Circuit breaker: `recordModelFailure(model)` tracks failures per model within a window; `isCircuitOpen(model)` returns true when failure threshold exceeded (auto-resets after window). `detectRateLimitError()` automatically skips usage-limit matches to prevent double-detection. Exports `detectUsageLimitError(agent, result)`, `formatResetTime(seconds)`, `detectCodexError(agent, result)`, `detectModelError(agent, result)`, `detectRateLimitError(agent, result)`, `calculateBackoff(attempt, opts)`, `getFallbackCandidates(agent, failedModel)`, `recoverFromModelError(agent, failedModel, opts)`, `isModelRecoveryEnabled()`, `recordModelFailure(model)`, `isCircuitOpen(model)`, `getCircuitState()`, `resetCircuitBreaker(model)`. Config: `modelRecovery.enabled`, `.autoPersist`, `.headlessFallback`, `.circuitBreaker.enabled`, `.circuitBreaker.failureThreshold`, `.circuitBreaker.windowMs`; `rateLimits.maxRetries`, `.baseDelayMs`, `.maxDelayMs`.
- **`hydra-rate-limits.mjs`** — Proactive rate limit awareness. Lightweight, no timers — state updated passively on each API request. Tracks RPM (sliding 60s window), TPM (token sliding window), and RPD (daily counter, critical for Google free tier). Captures real remaining capacity from provider response headers when fresh (<60s), falls back to estimated tracking otherwise. Health scoring integrates PeakEWMA latency from `hydra-streaming-middleware.mjs` alongside capacity percentages. Exports `recordApiRequest(provider, model, usage)`, `updateFromHeaders(provider, headers)`, `canMakeRequest(provider, model, estimatedTokens?)`, `getRemainingCapacity(provider, model?)`, `getHealthiestProvider(candidates)`, `getRateLimitSummary()`, `loadRpdState(data)`, `getRpdState()`, `_resetState()`. RPD state persisted alongside `provider-usage.json`.
- **`hydra-env.mjs`** — Minimal `.env` loader. Auto-loads on import. Real env vars take priority.
- **`hydra-github.mjs`** — GitHub integration via `gh` CLI. Exports `gh()`, `isGhAvailable()`, `isGhAuthenticated()`, `detectRepo()`, `createPR()`, `listPRs()`, `getPR()`, `mergePR()`, `closePR()`, `pushBranchAndCreatePR()`, `verifyRequiredChecks()`, `getGitHubConfig()`. Auto-generates PR title/body from branch name and commit log. PR template detection (checks `.github/pull_request_template.md` variants), auto-label detection from changed files via pattern matching. `verifyRequiredChecks()` validates CI checks against `config.github.requiredChecks`. Config: `github.requiredChecks`, `github.autolabel` (label→pattern map).
- **`hydra-shared/`** — Shared infrastructure for nightly and evolve pipelines:
  - `git-ops.mjs` — Git helpers (parameterized baseBranch): `git()`, `getCurrentBranch()`, `checkoutBranch()`, `createBranch()`, `getBranchStats()`, `smartMerge()`, plus remote sync helpers: `getRemoteUrl()`, `parseRemoteUrl()`, `fetchOrigin()`, `pushBranch()`, `hasRemote()`, `getTrackingBranch()`, `isAheadOfRemote()`.
  - `constants.mjs` — `BASE_PROTECTED_FILES`, `BASE_PROTECTED_PATTERNS`, `BLOCKED_COMMANDS`
  - `guardrails.mjs` — `verifyBranch()`, `isCleanWorkingTree()`, `buildSafetyPrompt()` (supports `attribution` param for commit trailers), `scanBranchViolations()`, `scanForSecrets(projectRoot, changedFiles)` (filename + content pattern matching), `checkDiffSize(projectRoot, branchName, opts)` (enforces `maxDiffLines`). Config: `verification.secretsScan`, `.maxDiffLines`.
  - `budget-tracker.mjs` — Base `BudgetTracker` class with configurable thresholds
  - `agent-executor.mjs` — Unified `executeAgent()` with stdin piping, stderr capture, progress ticking, OTel span instrumentation. Auto-resolves codex model via `getActiveModel()`. Returns `{ output, stdout, stderr, exitCode, signal, errorCategory?, errorDetail?, errorContext?, ... }` (`stdout` alias for metrics compatibility). Accepts `opts.reasoningEffort` for role-specific overrides, `opts.permissionMode` to override permission level (claude: `'plan'`|`'auto-edit'`, codex: `'read-only'`|`'full-auto'`). Adds `--reasoning-effort` for o-series (codex). Note: Claude thinking budget is API-only — not passed as CLI flag. Also exports `diagnoseAgentError(agent, result)` — post-hoc error classification that enriches failed results with `errorCategory` (auth/sandbox/permission/invocation/network/server/parse/internal/oom/crash/signal/silent-crash/codex-jsonl-error/unclassified) and `errorDetail`. For Codex, extracts structured JSONL error events from `--json` output before falling back to generic exit code interpretation. Called automatically on every failed `executeAgent()` result. Also exports `executeAgentWithRecovery()` — wraps `executeAgent()` with OTel pipeline span, usage limit detection (no retry), rate limit retry (backoff, configurable retries), circuit breaker check, and model-error fallback via `hydra-model-recovery.mjs`. Used by operator (cross-model verification) and dispatch pipeline (sequential agent calls).
  - `review-common.mjs` — Interactive review helpers: `handleBranchAction()` (with `[p]r` option when `gh` available, `useSmartMerge` option for auto-rebase), `loadLatestReport()`, `cleanBranches()`
- **`hydra-evolve-suggestions.mjs`** — Persistent suggestions backlog for evolve pipeline. Stores improvement ideas from failed/deferred rounds, user input, and review sessions. Exports `loadSuggestions()`, `saveSuggestions()`, `addSuggestion()`, `updateSuggestion()`, `removeSuggestion()`, `getPendingSuggestions()`, `getSuggestionById()`, `searchSuggestions()`, `createSuggestionFromRound()`, `promptSuggestionPicker()`, `getSuggestionStats()`, `formatSuggestionsForPrompt()`. Storage: `docs/coordination/evolve/SUGGESTIONS.json`.
- **`hydra-evolve-suggestions-cli.mjs`** — Standalone CLI for managing suggestions backlog. Subcommands: `list`, `add`, `remove`, `reset`, `import`, `stats`.
- **`hydra-activity.mjs`** — Real-time activity digest for concierge situational awareness. `detectSituationalQuery()` classifies "What's going on?" style queries. `buildActivityDigest()` fetches `GET /activity` + merges local state. `formatDigestForPrompt()` renders structured digest. `generateSitrep()` produces AI-narrated situation reports via the concierge provider chain (falls back to raw digest if no provider available). Ring buffer via `pushActivity()`/`getRecentActivity()`. Session summaries: `saveSessionSummary(text)` persists to `docs/coordination/session-summaries.json` (max 10), `getSessionContext()` returns recent activity + last 3 prior sessions for cross-session continuity. Annotation helpers: `annotateDispatch()`, `annotateHandoff()`, `annotateCompletion()`.
- **`hydra-codebase-context.mjs`** — Codebase knowledge injection for concierge. `loadCodebaseContext()` parses CLAUDE.md sections + builds module index. `detectCodebaseQuery()` classifies architecture questions by topic. `getTopicContext(topic)` returns focused context (12 topics: dispatch, council, config, workers, agents, concierge, evolve, daemon, ui, modules, github, metrics). `getBaselineContext()` returns permanent baseline for system prompt. `searchKnowledgeBase()` queries evolve KB. `getConfigReference()` formats config sections.
- **`hydra-tasks-scanner.mjs`** — Aggregates work items from code comments (git grep TODO/FIXME/HACK/XXX), `docs/TODO.md` unchecked items, and GitHub issues. Exports `scanAllSources()`, `scanTodoComments()`, `scanTodoMd()`, `scanGitHubIssues()`, `createUserTask()`, `deduplicateTasks()`, `prioritizeTasks()`, `taskToSlug()`. Returns `ScannedTask[]` with id, title, slug, source, taskType, suggestedAgent, complexity, priority.
- **`hydra-tasks.mjs`** — Autonomous tasks runner. Interactive setup (scan → select → budget) then executes per-task lifecycle: CLASSIFY → PLAN (complex only) → EXECUTE → VERIFY → DECIDE (council-lite for complex). Branch isolation (`tasks/{date}/{slug}`), BudgetTracker with 4 thresholds, investigator self-healing, model recovery. Generates JSON + Markdown reports to `docs/coordination/tasks/`.
- **`hydra-tasks-review.mjs`** — Post-run interactive review. Subcommands: `review` (walk branches, merge/skip/diff/delete/PR), `status` (show latest report), `clean` (delete all `tasks/*` branches). Same pattern as `hydra-nightly-review.mjs`.
- **`hydra-nightly.mjs`** — Autonomous overnight task execution. 6-phase pipeline: SCAN → DISCOVER → PRIORITIZE → SELECT (optional, `--interactive`) → EXECUTE → REPORT. SELECT phase presents tasks grouped by source with interactive pick/add/confirm. EXECUTE phase renders a live progress dashboard (task checklist with status icons, budget gauge, elapsed time, per-task agent progress). Config-driven via `nightly` section. Supports `--dry-run`, `--no-discovery`, `--interactive`, CLI overrides.
- **`hydra-nightly-discovery.mjs`** — AI discovery phase for nightly pipeline. Dispatches an agent (default: gemini) to analyze the codebase and propose improvement tasks. Returns `ScannedTask[]` for merging. Non-blocking (failures return `[]`). Exports `runDiscovery(projectRoot, opts)`.
- **`hydra-nightly-review.mjs`** — Post-run interactive review. Reads `baseBranch` from report JSON. Smart merge via `smartMerge()` (auto-rebases when base has advanced). Dev-advanced detection warns when base has diverged. Subcommands: `review`, `status`, `clean`.
- **`hydra-mcp-server.mjs`** — MCP server using official `@modelcontextprotocol/sdk` (protocol 2025-03-26). Exposes 11 tools (Zod-validated schemas), 5 resources (`hydra://config`, `hydra://metrics`, `hydra://agents`, `hydra://activity`, `hydra://status`), and 3 prompts (`hydra_council`, `hydra_review`, `hydra_analyze`). Two modes: **standalone** (`hydra_ask` + `hydra_forge` work without daemon) and **daemon** (task queue, handoffs, council, status). Dependencies: `@modelcontextprotocol/sdk`, `zod`.
- **`hydra-investigator.mjs`** — Re-exports from `hydra-evolve-investigator.mjs`. Self-healing failure diagnosis (shared).
- **`hydra-knowledge.mjs`** — Re-exports from `hydra-evolve-knowledge.mjs`. Persistent knowledge base (shared).
- **`hydra-doctor.mjs`** — Higher-level failure diagnostic and triage layer. Fires on non-trivial failures in evolve/nightly/tasks. Calls existing investigator for diagnosis, triages into follow-ups (daemon task, suggestion backlog entry, or KB learning), and tracks recurring error patterns via append-only NDJSON log. Exports `initDoctor()`, `isDoctorEnabled()`, `diagnose(failure)`, `getDoctorStats()`, `getDoctorLog(limit)`, `resetDoctor()`. Action pipeline scanners: `scanDoctorLog()`, `scanDaemonIssues(baseUrl)`, `scanErrorActivity()`, `enrichWithDiagnosis(items, cliContext)`, `executeFixAction(item, opts)`. Storage: `docs/coordination/doctor/DOCTOR_LOG.ndjson`. Config: `doctor.enabled`, `.autoCreateTasks`, `.autoCreateSuggestions`, `.addToKnowledgeBase`, `.recurringThreshold`, `.recurringWindowDays`. Accessible via `:doctor` and `:doctor fix` operator commands.
- **`hydra-cleanup.mjs`** — Cleanup scanners and executors for the `:cleanup` command. Scans for stale/completed items across the system. Scanners: `scanArchivableTasks(baseUrl)`, `scanOldHandoffs(baseUrl)`, `scanStaleBranches(projectRoot)`, `scanStaleTasks(baseUrl)`, `scanAbandonedSuggestions()`, `scanOldCheckpoints(projectRoot)`, `scanOldArtifacts(projectRoot)`. Enrichment: `enrichCleanupWithSitrep(items, opts)`. Executor: `executeCleanupAction(item, opts)` — maps `item.category` (archive/delete/requeue/cleanup) to appropriate actions (daemon task update, branch deletion, file removal, suggestion cleanup).
- **`hydra-action-pipeline.mjs`** — Unified SCAN → ENRICH → SELECT → CONFIRM → EXECUTE → REPORT pipeline. `runActionPipeline(rl, opts)` enforces a consistent interactive workflow: parallel scanners → optional AI enrichment → multi-select → confirmation → per-item execution with spinners → summary report. Used by `:doctor fix` and `:cleanup`. All future scan→select→act workflows should use this pipeline.
- **`hydra-output-history.mjs`** — CLI output ring buffer. Intercepts `process.stdout.write`/`process.stderr.write` to capture recent terminal output. Exports `initOutputHistory(opts?)`, `getRecentOutput(n?)`, `getRecentOutputRaw(n?)`, `clearOutputHistory()`, `getOutputContext()`. Filters status bar redraws, strips ANSI for clean text. Initialized at operator startup.
- **`hydra-resume-scanner.mjs`** — Unified resumable state detection. Scans daemon (paused/stale/handoffs), evolve session state, council checkpoints, unmerged branches (evolve/nightly/tasks), and pending suggestions in parallel via `Promise.allSettled`. Exports `scanResumableState({ baseUrl, projectRoot })` returning `ResumableItem[]`. Used by the unified `:resume` command.
- **`hydra-setup.mjs`** — CLI awareness setup. Detects installed AI CLIs (Claude Code, Gemini CLI, Codex CLI), registers Hydra MCP server globally, generates project-level HYDRA.md. Exports `detectInstalledCLIs()`, `buildMcpServerEntry()`, `mergeClaudeConfig()`, `mergeGeminiConfig()`, `registerCodexMcp()`, `generateHydraMdTemplate()`, `main()`. Subcommands: `setup` (global MCP registration), `init` (project HYDRA.md generation). Config targets: `~/.claude.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` (via CLI).
- **`hydra-provider-usage.mjs`** — Per-provider token usage tracking (local + external billing APIs). Single source of truth for `COST_PER_1K` pricing table (moved from concierge). Two-layer: session counters from streaming calls + external API queries (OpenAI/Anthropic admin keys). Exports `recordProviderUsage()`, `getProviderUsage()`, `getProviderSummary()`, `getExternalSummary()`, `loadProviderUsage()`, `saveProviderUsage()`, `resetSessionUsage()`, `refreshExternalUsage()`, `COST_PER_1K`, `estimateCost()`. Persistence: `docs/coordination/provider-usage.json` (7-day retention). Also persists RPD state from `hydra-rate-limits.mjs` (loaded on startup, saved alongside daily counters). Config: `providers.openai.adminKey`, `providers.anthropic.adminKey` (or env `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`).

- **`hydra-cache.mjs`** — Shared LRU cache with TTL, content hashing (SHA-256), and negative cache. Named namespaces (`routing`, `agent`, `negative`). Exports `getCached(ns, key)`, `setCached(ns, key, val, opts)`, `invalidateCache(ns, key?)`, `recordNegativeHit(ns, key, err)`, `isNegativeHit(ns, key)`, `getCacheStats()`, `contentHash(data)`. Config: `cache.enabled`, `.maxEntries`, `.ttlSec`, `.negativeCache.enabled`, `.negativeCache.ttlSec`.
- **`hydra-rate-limits.mjs`** — Consolidated rate limiting module: passive tracking (RPM/TPM/RPD sliding windows, header capture, health scoring) + token bucket enforcement (per-provider `TokenBucket`, concurrency counter). Exports passive: `recordApiRequest()`, `updateFromHeaders()`, `canMakeRequest()`, `getRemainingCapacity()`, `getHealthiestProvider()`, `getRateLimitSummary()`, `loadRpdState()`, `getRpdState()`. Exports enforcement: `acquireRateLimit(provider)`, `tryAcquireRateLimit()`, `getRateLimitStats()`, `resetRateLimiter()`, `initRateLimiters()`, `TokenBucket`, `initConcurrency()`, `acquireConcurrencySlot()`, `tryAcquireConcurrencySlot()`, `getConcurrencyStats()`. Config: `providers.rateLimit.openai`, `.anthropic`, `.google`; `providers.*.tier`.
- **`hydra-eval.mjs`** — Routing evaluation harness against golden corpora. Evaluates `classifyPrompt()` and `bestAgentFor()` against labeled test cases. Exports `loadGoldenCorpus(paths)`, `evaluateRouting(corpus)`, `evaluateAgentSelection(corpus)`, `generateEvalReport(results)`. Reports: `docs/coordination/eval/eval_*.{json,md}`. CLI: `npm run eval`. Config: `eval.corpusPaths`.
- **`hydra-streaming-middleware.mjs`** — Composable middleware pipeline for provider API calls (Helicone Tower-inspired). Wraps core streaming functions with onion-style layers: latency → retry → rateLimit → circuitBreaker → telemetry → headerCapture → usageTracking. Exports `createStreamingPipeline(provider, coreFn)`, `PeakEWMA` class (exponentially weighted moving average for latency tracking), `getProviderEWMA(provider)`, `getLatencyEstimates()`, individual middleware functions, `compose()`, `DEFAULT_LAYERS`. Used by `hydra-openai.mjs`, `hydra-anthropic.mjs`, `hydra-google.mjs`.
- **`hydra-telemetry.mjs`** — OTel GenAI tracing wrapper. Optional peer dependency — no-op when `@opentelemetry/api` is not installed. Lazy-loads OTel via dynamic `import()`. Exports `startAgentSpan(agent, model, opts)`, `endAgentSpan(span, result)`, `startProviderSpan(provider, model, opts)`, `endProviderSpan(span, usage, latencyMs)`, `startPipelineSpan(name, attrs)`, `endPipelineSpan(span, opts)`, `getTracer()`, `isTracingEnabled()`. Standard attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.agent.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`. Config: `telemetry.enabled` (default: true, auto-detected).

### Commit Attribution

Automated pipelines (evolve, nightly, tasks) add git trailers to commits for provenance:
```
Originated-By: hydra-evolve
Executed-By: codex
```
- `buildSafetyPrompt()` accepts `attribution: { pipeline, agent }` to instruct agents to include trailers
- `stageAndCommit()` accepts `opts.originatedBy` and `opts.executedBy` to append trailers programmatically

### Dispatch Modes

1. **Auto** — Classifies prompt locally → 3-way routing: single (fast-path), tandem (2-agent pair), or council (full deliberation). Zero agent CLI calls for classification.
2. **Council** — Full multi-round deliberation across agents with structured synthesis. Council gate warns when prompt is too simple for council.
3. **Dispatch** — Sequential pipeline: Claude → Gemini → Codex
4. **Smart** — Auto-selects model tier (economy/balanced/performance) per prompt
5. **Chat** — Concierge conversational layer, escalates with `!` prefix or `[DISPATCH]` intent

### Route Strategies

Auto mode uses `classifyPrompt()` to determine `routeStrategy`:
- **`single`** — Simple prompts: 1 task, 1 handoff, 0 agent CLI calls (fast-path dispatch)
- **`tandem`** — Moderate prompts: 2 tasks + 2 handoffs (lead→follow pair), 0 agent CLI calls. Task-type matrix selects optimal pair (e.g., planning: claude→codex, review: gemini→claude). Tandem indicators (`first...then`, `review and fix`) can upgrade simple prompts to tandem.
- **`council`** — Complex prompts (complexScore >= 0.6): full council deliberation, skips mini-round triage (saves 4 agent calls)

Legacy mini-round triage available via `routing.useLegacyTriage: true` config. Council gate (`routing.councilGate: true`, default) shows `promptChoice()` when council mode is overkill, offering the efficient route instead.

### Task Routing

10 task types (planning, architecture, review, refactor, implementation, analysis, testing, security, research, documentation) × 3 physical agents + 6 virtual sub-agents with affinity scores. `classifyTask()` in hydra-agents.mjs selects the optimal agent. Virtual sub-agents (e.g. `security-reviewer`) resolve to their base physical agent for CLI dispatch via `resolvePhysicalAgent()`. `selectTandemPair()` in hydra-utils.mjs maps task types to optimal lead→follow agent pairs, respecting agent filters.

## Code Conventions

- **ESM only** (`"type": "module"` in package.json). All files use `import`/`export`.
- **Four dependencies**: `picocolors` (terminal colors), `cross-spawn` (cross-platform spawning), `@modelcontextprotocol/sdk` (MCP server), `zod` (schema validation for MCP tools). Optional peer: `@opentelemetry/api` (tracing, no-op when absent).
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
- **`agent: "codex"`** — Codex (GPT-5.4). Best for: implementation, refactoring, code generation, writing tests, quick prototyping.

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
