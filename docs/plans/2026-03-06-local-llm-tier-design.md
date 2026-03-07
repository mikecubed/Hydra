# Local LLM Agent Tier — Design

**Date:** 2026-03-06
**Status:** Approved
**Approach:** C — Local as 4th Physical Agent with Mode-Aware Routing

---

## Problem

Hydra routes all tasks to cloud agents (claude/gemini/codex). Users with local hardware
(Ollama, LM Studio, vllm, etc.) have no way to offload cost-free tasks to local models.
There is also no mechanism to automatically prefer cheaper agents when cloud token budgets
run low.

---

## Goals

1. Add `local` as a 4th physical agent backed by any OpenAI-compatible HTTP endpoint.
2. Add `:mode economy/balanced/performance` command for intentional local-first routing.
3. Add a budget gate that automatically boosts local preference when cloud usage exceeds thresholds.
4. Keep all existing machinery intact (workers, tandem, council, affinity learning, metrics).

---

## Architecture

### Data Flow

```
User dispatches prompt
  → classifyPrompt()  →  routeStrategy + taskType
  → bestAgentFor(taskType, { mode, budgetState })
      if mode=economy OR budget>threshold:
        local affinity scores × 1.5 multiplier
      → pick highest-affinity agent
  → if local: hydra-local.mjs streams via OpenAI-compat API
  → else: existing cloud path unchanged
```

### New Files

| File | Purpose |
|------|---------|
| `lib/hydra-local.mjs` | OpenAI-compat streaming client with configurable `baseUrl`. Wraps `hydra-openai.mjs`. Returns `local-unavailable` error category on ECONNREFUSED. |

### Modified Files

| File | Change |
|------|--------|
| `lib/hydra-agents.mjs` | Register `local` physical agent. Add mode multiplier to `bestAgentFor()`. |
| `lib/hydra-config.mjs` | Add `local` provider config section. Add `routing.mode`. Extend economy `modeTier`. |
| `lib/hydra-model-profiles.mjs` | Add local model stubs (zero cost, configurable context). |
| `lib/hydra-shared/agent-executor.mjs` | Branch for `agent === 'local'`: call `streamLocalCompletion()` directly instead of cross-spawn. Handle `local-unavailable` with cloud fallback. |
| `lib/hydra-operator.mjs` | `:mode` command. Pass `{ mode, budgetState }` to `bestAgentFor()`. |
| `lib/hydra-statusbar.mjs` | Mode chip in context line: `◆ ECO` / `◆ PERF`. Local availability indicator. |

---

## Component Details

### `hydra-local.mjs`

Thin wrapper over `streamCompletion()` from `hydra-openai.mjs`:

```javascript
export async function streamLocalCompletion(cfg) {
  const { baseUrl, model, ...rest } = cfg;
  try {
    return await streamCompletion({ baseUrl, model, ...rest });
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      return { ok: false, errorCategory: 'local-unavailable', output: '' };
    }
    throw err;
  }
}
```

No streaming middleware pipeline needed on first pass — local has no rate limits or circuit
breakers. Can be added later if needed.

### `local` Agent Definition

```javascript
local: {
  type: 'physical',
  invoke: {
    nonInteractive: (prompt, opts) => buildLocalArgs(prompt, opts),
    headless:       (prompt, opts) => buildLocalArgs(prompt, opts),
    interactive:    null,  // API-backed, no interactive mode
  },
  contextBudget: 32_000,
  strengths: ['implementation', 'refactor', 'testing', 'low-latency', 'cost-zero'],
  councilRole: null,  // excluded from council
  taskAffinity: {
    planning:       0.25,
    architecture:   0.20,
    review:         0.45,
    refactor:       0.80,
    implementation: 0.82,
    analysis:       0.40,
    testing:        0.70,
    security:       0.30,
    research:       0.00,  // hard excluded
    documentation:  0.50,
  },
  timeout: 3 * 60 * 1000,
}
```

`research: 0.00` is a hard exclusion — local never selected for research regardless of mode.

### `agent-executor.mjs` Branch

Since `local` is API-backed rather than CLI-backed, `executeAgent()` needs a branch:

```javascript
if (agent === 'local') {
  return await executeLocalAgent(prompt, opts);  // calls streamLocalCompletion()
}
// else: existing cross-spawn path
```

On `local-unavailable`:
```javascript
if (result.errorCategory === 'local-unavailable') {
  // warn once, fall back to best cloud agent — no circuit breaker
  return await executeAgent(fallbackCloudAgent, prompt, opts);
}
```

### Mode-Aware `bestAgentFor()`

```javascript
export function bestAgentFor(taskType, { mode, budgetState } = {}) {
  const localBoost =
    mode === 'economy' ||
    budgetState?.daily?.percentUsed  > cfg.local.budgetGate.dailyPct  ||
    budgetState?.weekly?.percentUsed > cfg.local.budgetGate.weeklyPct;

  const performancePenalty = mode === 'performance';

  for (const [agent, scores] of affinityMap) {
    let score = scores[taskType] ?? 0;
    if (agent === 'local' && localBoost)        score *= 1.5;
    if (agent === 'local' && performancePenalty) score *= 0.5;
    // ... existing comparison
  }
}
```

In economy mode: `implementation` → local `0.82 × 1.5 = 1.23` beats codex `0.85`.
For planning:    → local `0.25 × 1.5 = 0.37`, claude `0.95` still wins.

### `:mode` Command

```
:mode              → show current mode
:mode economy      → routing.mode = 'economy', status bar ◆ ECO
:mode balanced     → routing.mode = 'balanced' (default)
:mode performance  → routing.mode = 'performance', status bar ◆ PERF
```

Budget gate uses same `checkUsage()` result already fetched for status bar — no extra calls.

### Config Defaults

```json
"local": {
  "enabled": false,
  "baseUrl": "http://localhost:11434/v1",
  "model": "mistral:7b",
  "fastModel": "mistral:7b",
  "budgetGate": { "dailyPct": 80, "weeklyPct": 75 }
},
"routing": {
  "mode": "balanced"
}
```

`enabled: false` — user opts in. When disabled, `local` never appears in routing candidates.

---

## What Stays Unchanged

- Worker heartbeat and claim/execute/report loop
- Task lifecycle (daemon, handoffs, snapshots)
- Council deliberation (local excluded via `councilRole: null`)
- Tandem dispatch (local can appear as `follow` agent if affinity wins)
- Affinity learning (`recordTaskOutcome` works for `local` same as any agent)
- Metrics, rate limit tracking, telemetry

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Local server not running | `local-unavailable` → silent cloud fallback + one-time operator warning |
| Local model slow / timeout | Existing 3min timeout → `timeout` error category → cloud fallback |
| Local returns bad output | Existing `ok: false` path → treated as task failure |
| Budget gate fires mid-session | Next dispatch uses local; current in-flight tasks unaffected |

---

## Out of Scope (Future)

- Auto-detect local server at startup (ping `GET /api/tags`)
- Multiple local endpoints (local load balancing)
- Local model in council (currently excluded; revisit if models improve)
- Concierge using local provider (separate from agent routing)
- `:local models` command to list available Ollama models

---

## Files Summary

```
NEW:
  lib/hydra-local.mjs

MODIFIED:
  lib/hydra-agents.mjs
  lib/hydra-config.mjs
  lib/hydra-model-profiles.mjs
  lib/hydra-shared/agent-executor.mjs
  lib/hydra-operator.mjs
  lib/hydra-statusbar.mjs
```
