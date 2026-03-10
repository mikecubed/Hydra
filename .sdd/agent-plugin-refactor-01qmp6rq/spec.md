# Feature Specification: Agent Plugin Interface

**Created**: 2026-03-09
**Status**: Draft
**Source**: `docs/plans/2026-03-08-agent-plugin-refactor.md`

## Overview

Hydra currently hard-codes per-agent behavior (argument building, output parsing, token extraction, error categorization, economy model selection, quota verification, task rules) across 9 separate files using `if/else` chains keyed on agent name strings. Adding any new agent (e.g. Copilot, Aider, a local Ollama endpoint) requires touching all 9 files.

This feature relocates all per-agent behavior into each agent's own definition object, making the executor and all call-sites data-driven. No new files. No external plugin loading. No breaking API changes.

---

## User Scenarios & Testing _(mandatory)_

### User Story 1 — Adding a New Agent Requires No Executor Changes (Priority: P1)

A developer who wants to integrate a new AI CLI (e.g. GitHub Copilot, Aider) into Hydra should be able to do so by defining a single agent object with the required interface, registering it, and having all Hydra subsystems (executor, metrics, usage, economy mode, task rules) pick it up automatically — without editing any file outside the agent definition.

**Why this priority**: This is the core value proposition of the refactor. Without it, the problem is unsolved. All downstream use-cases (Copilot integration, custom agents) depend on this.

**Independent Test**: Register a brand-new minimal agent definition with no if/else special-casing anywhere. Dispatch a task to it and verify it executes, tokens are tracked, task rules appear in prompts, and economy mode selects its preferred model — all without modifying any file other than the agent definition.

**Acceptance Scenarios**:

1. **Given** a new agent definition that implements the plugin interface, **When** it is registered via `registerAgent()`, **Then** the executor dispatches to it correctly without any hardcoded name checks.
2. **Given** a new agent with a custom `parseOutput` method, **When** the agent completes a task, **Then** the token usage and cost reported in metrics are sourced from `parseOutput`'s return value, not from any hardcoded extraction logic.
3. **Given** a new agent with `taskRules` defined, **When** the orchestrator builds a task prompt for that agent, **Then** the agent's `taskRules` appear in the prompt.
4. **Given** a new agent with `economyModel` defined, **When** economy mode is active, **Then** the system uses that agent's preferred economy model, not a hardcoded default.

---

### User Story 2 — Agent Definitions Are Self-Contained (Priority: P1)

A developer reading or modifying an agent's behavior (e.g. changing Codex's output parsing or Claude's quota endpoint) should be able to find all relevant logic in one place — the agent definition — rather than hunting across 9 files.

**Why this priority**: Directly enables maintainability. This is a prerequisite for the Copilot integration plan and the custom agents plan.

**Independent Test**: For each of the 4 built-in agents (claude, gemini, codex, local), confirm that: output parsing, error pattern matching, economy model selection, model ownership checking, quota verification, and task rule injection are all expressed in the agent definition object rather than scattered in call-sites.

**Acceptance Scenarios**:

1. **Given** the built-in `codex` agent, **When** a developer reads `hydra-agents.mjs`, **Then** they can find codex's output parsing logic, token accumulation, error patterns, and economy model — without needing to read `agent-executor.mjs`, `hydra-metrics.mjs`, `hydra-actualize.mjs`, or `hydra-model-recovery.mjs`.
2. **Given** a change is needed to Claude's quota verification endpoint, **When** the developer opens `hydra-agents.mjs`, **Then** the quota logic is in the Claude agent definition and changing it there is sufficient.

---

### User Story 3 — Existing Behavior Is Fully Preserved (Priority: P1)

After the refactor, all currently working agents (claude, gemini, codex, local) must behave identically to before. No regressions in task execution, token reporting, economy mode, error handling, or model routing.

**Why this priority**: Correctness is non-negotiable. The refactor must not change observable behavior for any existing agent.

**Independent Test**: Run the full existing test suite and all integration tests before and after the refactor. All tests must continue to pass. Spot-check: dispatch a real task to each physical agent (or a mock) and verify the output, token usage, and error handling match pre-refactor behavior.

**Acceptance Scenarios**:

1. **Given** the refactored system, **When** a task is dispatched to the `claude` agent, **Then** structured JSON output is parsed correctly and token/cost values are extracted and reported identically to the pre-refactor behavior.
2. **Given** the refactored system, **When** a task is dispatched to the `codex` agent, **Then** JSONL output is parsed correctly, tokens are accumulated across all lines, and the `--reasoning-effort` flag is passed when applicable.
3. **Given** the `gemini` agent, **When** the CLI workaround path (`executeGeminiDirect`) is invoked, **Then** it is triggered transparently from within Gemini's own invoke method — the executor routing block contains no hardcoded `gemini` name check.
4. **Given** the `local` agent (API-backed, no CLI spawn), **When** the executor processes a task for it, **Then** it routes to the API path without attempting to spawn a process or call `invoke.headless()`.

---

### User Story 4 — Partial Registration Has Safe Defaults (Priority: P2)

A developer registering a minimal or custom agent (e.g. a simple CLI wrapper with no JSON output, no quota verification) should receive sensible defaults for all optional plugin fields — without the system crashing or silently misbehaving due to missing methods.

**Why this priority**: Enables the custom agents wizard and third-party integrations without requiring a complete implementation of all interface methods.

**Independent Test**: Register an agent that provides only the required `invoke.headless` method and no plugin interface fields. Verify that every subsystem that accesses plugin fields (executor, metrics, usage, economy, orchestrator) handles the agent gracefully using the defined defaults.

**Acceptance Scenarios**:

1. **Given** an agent definition with no `parseOutput`, **When** `registerAgent()` processes it, **Then** the agent receives a default `parseOutput` that returns `{ output: stdout, tokenUsage: null, costUsd: null }`.
2. **Given** an agent definition with no `errorPatterns`, **When** the executor encounters an error, **Then** no crash occurs and error categorization falls through gracefully.
3. **Given** an agent of type `api` (or `customType: 'api'`), **When** `registerAgent()` processes it, **Then** `features.executeMode` defaults to `'api'` even if not explicitly set.

---

### Edge Cases

- What happens when an agent's `parseOutput` throws an exception? The executor must not crash; it should fall back to raw stdout.
- What happens when `quotaVerify` returns `null`? The quota check is silently skipped; no error is raised.
- What happens when `economyModel` returns `null`? Economy mode falls through to the existing default behavior (no override).
- What happens when both Phase 2 (executor refactor) and Phase 3 (call-site cleanup) are not shipped atomically? New/non-core agents will exhibit silent failures in usage stats, economy mode, instruction context, quota checks, and task rules. Phase 2 and Phase 3 must ship as a single atomic change.

---

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST allow an agent's output parsing logic (text extraction, token counting, cost reporting) to be defined within the agent's own definition object.
- **FR-002**: The system MUST allow an agent's error patterns (auth failure, rate limit, quota exhaustion, network error) to be defined within the agent's own definition object.
- **FR-003**: The system MUST allow an agent's economy model preference to be expressed as a callable method on the agent definition, replacing all hardcoded economy model ternaries.
- **FR-004**: The system MUST allow an agent's model ownership check (does a given model ID belong to this agent?) to be expressed as a callable method on the agent definition.
- **FR-005**: The system MUST allow an agent's quota verification logic to be expressed as an async callable on the agent definition, with `null` indicating "unverifiable, skip check."
- **FR-006**: The system MUST allow an agent's orchestrator instruction preamble and task rules to be defined within the agent's own definition object.
- **FR-007**: The `registerAgent()` function MUST apply safe, well-defined defaults for every plugin interface field when the agent definition omits them.
- **FR-008**: An agent whose `customType` is `'api'` MUST have `features.executeMode` default to `'api'` unless explicitly overridden, so the executor skips the spawn path.
- **FR-009**: The executor MUST NOT attempt to call `invoke.headless()` on an agent whose `features.executeMode` is `'api'`; instead it MUST route to the API execution path.
- **FR-010**: The executor MUST use the agent's `parseOutput` method as the sole source of parsed output, token usage, and cost — no other subsystem (e.g. metrics) may re-parse raw stdout.
- **FR-011**: The Gemini CLI workaround (`executeGeminiDirect`) MUST be invoked from within Gemini's own `invoke.headless()` method, not from the executor's routing block. The executor MUST contain no hardcoded `'gemini'` name check in its routing logic.
- **FR-012**: The existing test suite MUST continue to pass without modification after the refactor.
- **FR-013**: A new test file MUST cover: plugin interface shape for all 4 physical agents, `registerAgent()` default application, `parseOutput` correctness for claude and codex (including JSONL accumulation), and executor routing guards for `api` vs `spawn` modes.

### Key Entities

- **Agent Definition**: The object registered via `registerAgent()`. Contains identity fields (name, type, displayName, invoke, etc.) plus the new plugin interface fields (features, parseOutput, errorPatterns, modelBelongsTo, quotaVerify, economyModel, readInstructions, taskRules).
- **Plugin Interface**: The set of optional methods and metadata fields that, when present on an agent definition, make all Hydra subsystems data-driven for that agent. When absent, `registerAgent()` fills in defaults.
- **Agent Registry**: The runtime store (`PHYSICAL_AGENTS` + dynamically registered entries) that `getAgent(name)` queries. After this refactor, all plugin interface fields are guaranteed present on every registered entry.
- **Executor**: The subsystem that dispatches prompts to agent CLIs or APIs. After this refactor, it reads `agentDef.features.executeMode` to route, calls `agentDef.invoke.headless()` to build CLI arguments, and calls `agentDef.parseOutput()` to extract results.

---

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Zero hardcoded agent-name string checks (`agent === 'claude'`, `agent === 'codex'`, etc.) remain in `agent-executor.mjs`, `hydra-metrics.mjs`, `hydra-usage.mjs`, `hydra-actualize.mjs`, `orchestrator-daemon.mjs`, `hydra-model-recovery.mjs`, `hydra-operator.mjs`, or `hydra-evolve.mjs` after the refactor.
- **SC-002**: All existing tests pass without modification after the refactor.
- **SC-003**: A new agent can be fully integrated (registered, dispatched to, with token tracking, economy mode, and task rules) by editing only `hydra-agents.mjs` and no other file.
- **SC-004**: The `registerAgent()` function applies defaults such that an agent registered with only `invoke.headless` defined will not cause any subsystem to throw or silently produce incorrect results.
- **SC-005**: The new test file (`test/hydra-agents-plugin.test.mjs`) covers all 4 physical agents' plugin interface shape, `parseOutput` correctness for claude and codex, default-filling in `registerAgent()`, and executor routing guards — and all tests pass.
- **SC-006**: Phase 2 (executor refactor) and Phase 3 (call-site cleanup) ship atomically in a single PR; no intermediate state where new/non-core agents produce silent failures.
