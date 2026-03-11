# Research Notes: Agent Plugin Interface

**Feature**: Agent Plugin Refactor
**Date**: 2026-03-09

## Codebase Audit Findings

### File sizes (lines)

| File                                  | Lines |
| ------------------------------------- | ----- |
| `lib/hydra-agents.mjs`                | 912   |
| `lib/hydra-shared/agent-executor.mjs` | 1,310 |
| `lib/hydra-metrics.mjs`               | 526   |
| `lib/hydra-usage.mjs`                 | 846   |
| `lib/hydra-actualize.mjs`             | 580   |
| `lib/hydra-model-recovery.mjs`        | 803   |
| `lib/hydra-operator.mjs`              | 5,214 |
| `lib/hydra-evolve.mjs`                | 2,769 |
| `lib/hydra-audit.mjs`                 | 864   |

---

## Decision: Gemini routing remains in `invoke.headless()`

**Background:** The executor currently short-circuits at line 858: `if (agent === 'gemini') return executeGeminiDirect(...)`. The plan says this workaround should move inside `gemini.invoke.headless()`.

- **Chosen:** Move `executeGeminiDirect()` call into `gemini.invoke.headless()`, which already exists in `hydra-agents.mjs`. The executor's routing block then handles gemini identically to claude (just calls `invoke.headless()`).
- **Rationale:** Keeps the workaround encapsulated. When the Gemini CLI bug is fixed, only the agent definition changes, not the executor.
- **Risk:** `executeGeminiDirect()` currently lives in `agent-executor.mjs`. Since `hydra-agents.mjs` cannot import from `agent-executor.mjs` (circular dependency risk), `executeGeminiDirect` must be called via a lazy dynamic import OR moved to a shared utility OR inlined into the gemini invoke closure. **Safest approach:** keep `executeGeminiDirect` in `agent-executor.mjs` and use a callback/factory pattern: register gemini with `headless: null` in the static definition, then patch `gemini.invoke.headless` in `agent-executor.mjs` after the module loads (since executor already imports from `hydra-agents.mjs`).

**Conclusion:** Patch `gemini.invoke.headless` at the top of `agent-executor.mjs` (after imports) to wrap `executeGeminiDirect`. This avoids circular imports and keeps the executor routing block clean.

---

## Decision: `parseOutput` ownership — metrics.mjs

**Background:** `recordCallComplete()` in `hydra-metrics.mjs` already prefers caller-supplied `result.tokenUsage` (line ~131). The per-agent parsing blocks for claude and codex (lines ~144–184) only run when `result.tokenUsage` is absent.

**Current state:** `agent-executor.mjs` returns `{ output, tokenUsage, costUsd }` for the spawn path already, but `tokenUsage` is only populated when `agent === 'codex'` (via `extractCodexUsage`). Claude's JSON parsing happens in `hydra-metrics.mjs`, not the executor.

- **Chosen:** Move all output parsing to `parseOutput()` on the agent definition. `executeAgent()` calls `agentDef.parseOutput(rawOutput)` and sets `tokenUsage` on the result. `hydra-metrics.mjs` per-agent blocks are deleted — they are unreachable once `tokenUsage` is always caller-supplied.
- **Rationale:** Clean ownership. No double-parse. Consistent with the plan.
- **Migration note:** The claude per-agent block in metrics (currently the primary token extractor for claude) moves to `claude.parseOutput()`. This is the riskiest deletion — must verify the executor result flows to `recordCallComplete` with `tokenUsage` present.

---

## Decision: Economy model — `hydra-actualize.mjs`

**Background:** The economy model ternary at lines 384–392 of `hydra-actualize.mjs` is a 3-way agent name chain:

```javascript
agent === 'codex'
  ? budgetCfg.handoffModel || 'o4-mini'
  : agent === 'claude'
    ? 'claude-sonnet-4-5-20250929'
    : agent === 'gemini'
      ? 'gemini-3-flash-preview'
      : undefined;
```

- **Chosen:** Replace with `getAgent(agent)?.economyModel(budgetCfg) ?? undefined`. Each agent's `economyModel` method encodes the same logic.
- **Note:** Codex's `economyModel` must preserve the `budgetCfg.handoffModel` fallback: `(cfg) => cfg?.handoffModel || 'o4-mini'`.

---

## Decision: `hydra-audit.mjs` getAgentCommand()

**Background:** `getAgentCommand()` builds raw CLI commands for audit dispatch and hardcodes economy model IDs:

- Claude economy: `claude-haiku-4-5-20251001`
- Codex economy: `o4-mini`
- Gemini: no economy fallback

This is separate from the main executor path but has the same name-keyed pattern.

- **Chosen:** Replace the switch with `getAgent(agent)?.invoke.nonInteractive(prompt)` for the command, and `getAgent(agent)?.economyModel()` for the economy model override. If the agent doesn't support `nonInteractive`, fall back to current behavior.
- **Risk:** Audit uses `nonInteractive` invocation (not `headless`), so the mapping is clean. The economy model arg must be injected into the args array after the fact — may require a small wrapper.
- **Simplification allowed:** Audit can keep a thin name check as a fallback (`default: throw`) since it only dispatches to 3 built-in agents. The key is removing hardcoded model IDs.

---

## Decision: `hydra-evolve.mjs` Codex error handling

**Background:** The codex-specific error handling block (lines 469–494) calls `detectCodexError()` which itself checks agent-specific JSONL error patterns. This is the most complex special-case.

- **Chosen:** Preserve `detectCodexError()` as a utility function (it's already isolated). The `if (agent === 'codex')` guard in evolve becomes `if (agentDef?.errorPatterns && Object.keys(agentDef.errorPatterns).length)` — or more precisely, wrap the startup-failure detection logic in a check for `agentDef.features.jsonOutput === true` (since JSONL errors only apply to JSON-output agents). This avoids a hardcoded agent name while keeping the logic.
- **Note:** `detectCodexError()` itself still hardcodes codex-specific JSONL patterns. These can stay — that function is already colocated with its use. The `errorPatterns` field on the agent definition serves a different purpose (error categorization for the executor), not evolve's startup-detection heuristic.

---

## Decision: `registerAgent()` patching strategy

**Current `registerAgent()`** does not apply plugin interface defaults. It assigns a fixed set of known fields and ignores unknown ones.

- **Chosen:** Add a single block at the end of `registerAgent()` that reads the plugin interface fields from `def` with fallback defaults. No structural change to the function — just additional assignments before `_registry.set(lower, entry)`.
- **Order of defaults:** `customType === 'api'` implies `executeMode: 'api'` unless `def.features.executeMode` is explicitly set.

---

## Existing test file to be aware of

`test/hydra-agents.test.mjs` — tests `registerAgent()`, `getAgent()`, and agent registry behavior. Phase 4 must not break these.
`test/hydra-agent-executor.test.mjs` — tests `executeAgent()` and related. Phase 2 changes touch this directly.

---

## Phase 2+3 atomicity — key constraint

The audit confirms the plan's risk inventory is accurate. `hydra-metrics.mjs` currently relies on its own per-agent parsing for Claude (since the executor doesn't yet call `parseOutput`). Deleting the metrics blocks (Phase 3) before the executor calls `parseOutput` (Phase 2) would break token tracking for Claude. Both phases must be in the same commit/PR.
