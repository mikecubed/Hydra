# Agent Plugin Refactor — Level 1

**Date:** 2026-03-08
**Status:** Revised (GPT-5.4 review applied 2026-03-08)
**Unblocks:** custom agents plan, Copilot integration plan

## Problem

The agent registry (`PHYSICAL_AGENTS` in `hydra-agents.mjs`) already looks like a plugin system — `registerAgent()`, runtime registry, `initAgentRegistry()`. But the *executor* bypasses it entirely. Per-agent behavior is scattered in if/else chains across 9 files:

| File | What it hardcodes |
|---|---|
| `hydra-shared/agent-executor.mjs` | Arg building, output parsing, error categorization |
| `hydra-metrics.mjs` | Token extraction from stdout |
| `hydra-usage.mjs` | Model ID → agent validation |
| `hydra-actualize.mjs` | Economy model fallbacks |
| `orchestrator-daemon.mjs` | Read instructions, task rules per agent |
| `hydra-model-recovery.mjs` | Quota API endpoints and patterns |
| `hydra-operator.mjs` | Role-specific prompt addenda |
| `hydra-audit.mjs` | Agent commands and economy model hardcodes |
| `hydra-council.mjs` | Agent-specific phase filtering *(excluded — see scope)* |
| `hydra-evolve.mjs` | Error handling behavior |

Adding Copilot or any custom agent currently requires touching all of these. This refactor colocates that behavior with the agent definition, making the executor and all callsites data-driven.

## Approach

Move per-agent behavior into the agent definition as methods and metadata. No new files. No external plugin loading. No breaking API changes. Each method has a sensible default so agents that don't need special behavior pay no cost.

## New Agent Definition Shape

This extends the existing shape (all new fields are optional with defaults):

```javascript
{
  // ── Existing fields (unchanged) ───────────────────────────────────
  name, type, displayName, label, cli, invoke, contextBudget,
  contextTier, strengths, weaknesses, councilRole, taskAffinity,
  rolePrompt, timeout, tags, enabled,

  // ── New: feature flags (executor routing) ─────────────────────────
  features: {
    // Transport for this agent. 'spawn' = shell CLI; 'api' = HTTP (no spawn, used by local).
    // Do NOT add agent-specific transports here (e.g. no 'gemini-direct') —
    // the Gemini workaround for CLI v0.27.x lives inside executeGeminiDirect() and is
    // invoked transparently by Gemini's invoke.headless(). When the CLI is fixed,
    // only that function changes, not this flag.
    executeMode: 'spawn',     // 'spawn' | 'api'
    jsonOutput: true,         // stdout is structured JSON/JSONL
    stdinPrompt: true,        // prompt delivered via stdin (not -p flag)
    reasoningEffort: false,   // supports --reasoning-effort flag
  },

  // ── New: output parsing ───────────────────────────────────────────
  // Called ONCE by executeAgent() after the process exits. The result
  // { output, tokenUsage, costUsd } is embedded in the return value of
  // executeAgent() and forwarded to recordCallComplete() by the caller.
  // hydra-metrics.mjs must NOT re-parse stdout — it receives pre-parsed
  // tokenUsage from the executeAgent() result object directly.
  parseOutput(stdout, opts) { ... },

  // ── New: error patterns ───────────────────────────────────────────
  // Used by executeAgent() error categorization and hydra-evolve.mjs.
  errorPatterns: {
    authRequired:          /regex/,
    rateLimited:           /regex/,
    quotaExhausted:        /regex/,
    networkError:          /regex/,
    subscriptionRequired:  /regex/,  // optional
  },

  // ── New: model validation ─────────────────────────────────────────
  // Used by hydra-usage.mjs modelBelongsToAgent().
  modelBelongsTo(modelId) { return modelId.startsWith('claude-'); },

  // ── New: quota verification ───────────────────────────────────────
  // Used by hydra-model-recovery.mjs. Return null to skip quota check.
  async quotaVerify(apiKey) {
    // fetch provider endpoint, return { hasQuota: bool, message: string }
    // return null if unverifiable (e.g. local agent)
  },

  // ── New: economy model ────────────────────────────────────────────
  // Used by hydra-actualize.mjs when useEconomy is true.
  // Return a model ID string, or null to use default.
  economyModel(budgetCfg) { return 'claude-sonnet-4-5-20250929'; },

  // ── New: orchestrator instructions ───────────────────────────────
  // Used by orchestrator-daemon.mjs to build the context preamble.
  readInstructions(instructionFile) {
    return `Read ${instructionFile} first, then task-specific files.`;
  },

  // ── New: task rules ───────────────────────────────────────────────
  // Used by orchestrator-daemon.mjs and hydra-operator.mjs.
  // Strings appended to the agent's task prompt.
  taskRules: [
    '- Create detailed task specs for Codex in your handoffs.',
  ],
}
```

### Method defaults (applied by `registerAgent()` when absent)

| Field | Default |
|---|---|
| `features.executeMode` | `'spawn'` |
| `features.jsonOutput` | `false` |
| `features.stdinPrompt` | `false` |
| `features.reasoningEffort` | `false` |
| `parseOutput(stdout)` | `{ output: stdout, tokenUsage: null, costUsd: null }` |
| `errorPatterns` | `{}` |
| `modelBelongsTo()` | `() => false` |
| `quotaVerify()` | `async () => null` |
| `economyModel()` | `() => null` |
| `readInstructions(f)` | `` (f) => `Read ${f} first.` `` |
| `taskRules` | `[]` |

> **`parseOutput` ownership:** `executeAgent()` is the **sole caller**. It embeds `{ output, tokenUsage, costUsd }` in the result object. `hydra-metrics.mjs` receives `tokenUsage` from that result — it must not attempt to re-parse `stdout`. The current per-agent extraction blocks in `hydra-metrics.mjs` (lines 144–184) are removed in Phase 3; `recordCallComplete()` already prefers caller-supplied `tokenUsage` (line 132), so this is a safe deletion.

---

## Per-Agent Changes

### `claude`

```javascript
features: {
  executeMode: 'spawn',
  jsonOutput: true,
  stdinPrompt: true,
  reasoningEffort: false,
},

parseOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.type === 'result') {
      const u = parsed.usage || {};
      return {
        output: parsed.result ?? parsed.content ?? stdout,
        tokenUsage: {
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
        },
        costUsd: parsed.cost_usd || null,
      };
    }
  } catch {}
  return { output: stdout, tokenUsage: null, costUsd: null };
},

errorPatterns: {
  authRequired:   /authentication.*required|invalid.*api.*key|unauthorized/i,
  rateLimited:    /rate.*limit|too many requests/i,
  quotaExhausted: /spending_limit|credit_balance|usage_limit/i,
  networkError:   /ECONNREFUSED|ENOTFOUND|network error/i,
},

modelBelongsTo: (id) => id.toLowerCase().startsWith('claude-'),

async quotaVerify(apiKey) {
  // Current logic from hydra-model-recovery.mjs lines 394-410
  // Endpoint: https://api.anthropic.com/v1/models?limit=1
  // Status: 402/529 → no quota, 429 + quotaExhausted pattern → quota
},

economyModel: () => 'claude-sonnet-4-5-20250929',

readInstructions: (f) =>
  `Read these files first:\n1) ${f}\n2) docs/QUICK_REFERENCE.md\n3) docs/coordination/AI_SYNC_STATE.json\n4) docs/coordination/AI_SYNC_LOG.md`,

taskRules: [
  '- Create detailed task specs for Codex (file paths, signatures, DoD) in your handoffs.',
],
```

### `gemini`

```javascript
features: {
  executeMode: 'spawn',   // NOT 'gemini-direct' — the CLI workaround is internal to
                          // invoke.headless(), which calls executeGeminiDirect() when
                          // the CLI version is broken. The plugin surface stays clean.
  jsonOutput: true,       // -o json flag
  stdinPrompt: false,     // -p flag
  reasoningEffort: false,
},

parseOutput(stdout) {
  // Gemini CLI outputs JSON with a top-level response field.
  // Parsed in executeGeminiDirect() already; this covers the spawn fallback path.
  try {
    const parsed = JSON.parse(stdout);
    return { output: parsed?.response ?? parsed?.text ?? stdout, tokenUsage: null, costUsd: null };
  } catch {}
  return { output: stdout, tokenUsage: null, costUsd: null };
},

errorPatterns: {
  authRequired:   /authentication required|invalid.*key|API_KEY_INVALID/i,
  rateLimited:    /RATE_LIMIT_EXCEEDED|too many requests/i,
  quotaExhausted: /QUOTA_EXHAUSTED.*(?:day|month)|daily.*quota|monthly.*quota/i,
  networkError:   /ECONNREFUSED|ENOTFOUND/i,
},

modelBelongsTo: (id) => id.toLowerCase().startsWith('gemini-'),

async quotaVerify(apiKey) {
  // Current logic from hydra-model-recovery.mjs lines 413-427
  // Endpoint: https://generativelanguage.googleapis.com/v1beta/models?key=...
  // Status 429 + quotaExhausted pattern
},

economyModel: () => 'gemini-3-flash-preview',

readInstructions: (f) =>
  `Read broadly: ${f}, QUICK_REFERENCE.md, AI_SYNC_STATE.json, AI_SYNC_LOG.md, and all files in your task scope.`,

taskRules: [
  '- Cite specific file paths and line numbers in all findings.',
],
```

### `codex`

```javascript
features: {
  executeMode: 'spawn',
  jsonOutput: true,         // --json flag; JSONL output
  stdinPrompt: true,        // exec via stdin
  reasoningEffort: true,    // --reasoning-effort flag
},

parseOutput(stdout) {
  // Current extractCodexText() + extractCodexUsage() logic
  // Accumulate tokens across all JSONL lines
  const lines = stdout.split('\n');
  let output = '';
  const tokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  let hasTokens = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === 'message' && obj.content) output += obj.content;
      const u = obj.usage || obj.token_usage;
      if (u) {
        hasTokens = true;
        tokenUsage.inputTokens  += u.input_tokens  || u.prompt_tokens     || 0;
        tokenUsage.outputTokens += u.output_tokens || u.completion_tokens || 0;
      }
    } catch {}
  }
  if (hasTokens) tokenUsage.totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;
  return { output: output || stdout, tokenUsage: hasTokens ? tokenUsage : null, costUsd: null };
},

errorPatterns: {
  authRequired:   /invalid.*api.*key|unauthorized|authentication/i,
  rateLimited:    /rate.*limit|too many requests/i,
  quotaExhausted: /usage_limit|spending_limit|hard_limit|insufficient_quota/i,
  networkError:   /ECONNREFUSED|ENOTFOUND/i,
},

modelBelongsTo: (id) => {
  const l = id.toLowerCase();
  return l.startsWith('gpt-') || l.startsWith('o1') || l.startsWith('o3')
      || l.startsWith('o4') || l.startsWith('o5') || l.startsWith('codex');
},

async quotaVerify(apiKey) {
  // Current logic from hydra-model-recovery.mjs lines 365-391
  // Endpoint: https://api.openai.com/v1/models
  // Status 402 / 429 + quotaExhausted pattern
},

economyModel: (budgetCfg) => budgetCfg?.handoffModel || 'o4-mini',

readInstructions: (f) =>
  `Read ${f} for conventions, then read task-specific files listed in your assigned task.`,

taskRules: [
  '- Do not redesign — follow the spec. Report exactly what you changed.',
],
```

### `local`

```javascript
features: {
  executeMode: 'api',     // routes to executeLocalAgent() — no spawn, no invoke.headless()
  jsonOutput: false,
  stdinPrompt: false,
  reasoningEffort: false,
},
// local.invoke.headless remains null — executor MUST check features.executeMode === 'api'
// before attempting invoke.headless(). Phase 2 must guard: if (agentDef.features.executeMode !== 'spawn') skip arg-building.
parseOutput: (stdout) => ({ output: stdout, tokenUsage: null, costUsd: null }),
errorPatterns: {
  networkError: /ECONNREFUSED|ENOTFOUND|connection refused/i,
},
modelBelongsTo: (model, cfg) =>
  typeof cfg?.local?.model === 'string'
    ? cfg.local.model.toLowerCase() === String(model).toLowerCase()
    : false,  // only matches the configured local model (case-insensitive); never claims cloud models
quotaVerify: async () => null,  // unverifiable
economyModel: () => null,
readInstructions: (f) => `Read ${f} first.`,
taskRules: [],
```

### `copilot` (from the Copilot integration plan — unchanged interface)

```javascript
features: {
  executeMode: 'spawn',
  jsonOutput: false,      // flip to true when CLI ships --output-format json
  stdinPrompt: false,     // -p flag, not stdin
  reasoningEffort: false,
},

parseOutput(stdout, opts) {
  if (opts?.jsonOutput) {
    try {
      const parsed = JSON.parse(stdout);
      return { output: parsed?.result?.output ?? parsed?.output ?? stdout, tokenUsage: null, costUsd: null };
    } catch {}
  }
  return { output: stdout, tokenUsage: null, costUsd: null };
},

errorPatterns: { ... },   // as per Copilot integration plan Task 3
modelBelongsTo: (id) => id.toLowerCase().startsWith('copilot-'),
quotaVerify: async () => null,   // GitHub-managed, not verifiable via API key
economyModel: () => 'copilot-claude-sonnet-4-6',
readInstructions: (f) => `Read ${f} and any relevant GitHub context (issues, PRs) before responding.`,
taskRules: [
  '- Cross-reference with open issues and CI history when reviewing code.',
],
```

### Custom CLI agents

```javascript
// Generated by the custom agents wizard; stored in agents.customAgents[]:
features: { executeMode: 'spawn', jsonOutput: false, stdinPrompt: false },
parseOutput: (stdout) => ({ output: stdout, tokenUsage: null, costUsd: null }),
errorPatterns: {},
modelBelongsTo: () => false,
quotaVerify: async () => null,
economyModel: () => null,
readInstructions: (f) => `Read ${f} first.`,
taskRules: [],
```

---

## Files to Change

| File | Change |
|---|---|
| `lib/hydra-agents.mjs` | Add new fields to each `PHYSICAL_AGENTS` entry; apply defaults in `registerAgent()` |
| `lib/hydra-shared/agent-executor.mjs` | Replace if/else arg-building with `agentDef.invoke.headless()`; replace output parsing with `agentDef.parseOutput()`; route `features.executeMode` |
| `lib/hydra-metrics.mjs` | Replace per-agent token extraction with `agentDef.parseOutput()` |
| `lib/hydra-usage.mjs` | Replace `modelBelongsToAgent()` body with `getAgent(agent)?.modelBelongsTo(modelId)` |
| `lib/hydra-actualize.mjs` | Replace economy model ternary with `agentDef.economyModel(budgetCfg)` |
| `lib/orchestrator-daemon.mjs` | Replace `readInstructions` ternary and `taskRules` if/else with `agentDef.readInstructions()` / `agentDef.taskRules` |
| `lib/hydra-model-recovery.mjs` | Replace 3 if-blocks in quota verification with `agentDef.quotaVerify(apiKey)` |
| `lib/hydra-operator.mjs` | Replace per-agent prompt addenda with `agentDef.taskRules` |
| `lib/hydra-evolve.mjs` | Replace Codex error handling special case with `agentDef.errorPatterns` check |
| `lib/hydra-council.mjs` | Replace agent name filters with `agentDef.councilRole` checks where possible |

---

## Implementation Phases

### Phase 1 — Enhance definitions + `registerAgent()` defaults

Add all new methods/fields to the 4 existing `PHYSICAL_AGENTS` entries. Update `registerAgent()` to apply defaults for any missing field. **No behavior changes yet** — the executor still uses the old if/else chains. Tests still pass.

Key validation to add in `registerAgent()`:
```javascript
// Apply defaults for plugin interface fields
// customType:'api' implies executeMode:'api' unless explicitly overridden
const defaultExecuteMode = def.customType === 'api' ? 'api' : 'spawn';
entry.features = {
  executeMode: defaultExecuteMode,
  jsonOutput: false,
  stdinPrompt: false,
  reasoningEffort: false,
  ...def.features,
};
entry.parseOutput = def.parseOutput ?? ((stdout) => ({ output: stdout, tokenUsage: null, costUsd: null }));
entry.errorPatterns = def.errorPatterns ?? {};
entry.modelBelongsTo = def.modelBelongsTo ?? (() => false);
entry.quotaVerify = def.quotaVerify ?? (async () => null);
entry.economyModel = def.economyModel ?? (() => null);
entry.readInstructions = def.readInstructions ?? ((f) => `Read ${f} first.`);
entry.taskRules = def.taskRules ?? [];
```

### Phase 2 — Refactor `executeAgent()`

Replace the `if (agent === 'codex') ... else (claude)` arg-building block:

```javascript
// Before:
if (agent === 'codex') {
  args = ['exec', '-', '--full-auto'];
  if (effectiveModel) args.push('--model', effectiveModel);
  args.push('--json');
  cmd = 'codex';
} else {
  // claude
  args = ['-p', prompt, '--output-format', 'json', '--permission-mode', perm];
  cmd = 'claude';
}

// After:
const agentDef = getAgent(agent);
[cmd, args] = agentDef.invoke.headless(prompt, {
  model: getCopilotCliModelId ? getCopilotCliModelId(effectiveModel) : effectiveModel,
  permissionMode: permissionMode || 'auto-edit',
  jsonOutput: agentDef.features.jsonOutput,
  reasoningEffort: effortOverride || getReasoningEffort(agent),
  cwd,
});
```

Replace the output parsing block:
```javascript
// Before:
if (agent === 'codex') {
  output = extractCodexText(rawOutput);
  tokenUsage = extractCodexUsage(rawOutput);
}

// After:
const parsed = agentDef.parseOutput(rawOutput, { jsonOutput: agentDef.features.jsonOutput });
output = parsed.output;
tokenUsage = parsed.tokenUsage;
costUsd = parsed.costUsd;
```

Route `executeMode` — **check before building args, not after**:
```javascript
// Before (lines 858-889):
if (agent === 'gemini') return executeGeminiDirect(prompt, opts);
if (agent === 'local') return executeLocalAgent(prompt, opts);
if (customDef?.customType === 'cli') → executeCustomCliAgent();
if (customDef?.customType === 'api') → executeCustomApiAgent();

// After:
const agentDef = getAgent(agent);
if (agentDef.features.executeMode === 'api') return executeLocalAgent(prompt, opts);
// 'spawn' path continues — arg building, spawn, output parsing

// Inside the spawn path, guard before calling invoke.headless():
if (!agentDef.invoke?.headless) {
  throw new Error(`Agent '${agent}' has no headless invoke but executeMode is 'spawn'`);
}
[cmd, args] = agentDef.invoke.headless(prompt, {
  model: effectiveCliModelId,
  permissionMode: permissionMode || 'auto-edit',
  jsonOutput: agentDef.features.jsonOutput,
  reasoningEffort: agentDef.features.reasoningEffort
    ? (effortOverride || getReasoningEffort(agent))
    : undefined,
  cwd,
});
```

> **Gemini routing note:** `executeGeminiDirect()` is now invoked transparently inside `gemini.invoke.headless()`, not from `executeAgent()`'s routing block. This keeps the workaround internal and removes the last hardcoded agent name from the executor's routing section. If the Gemini CLI bug is fixed, only `invoke.headless()` changes.

### Phase 3 — Migrate callsites

Each a small surgical change:

```javascript
// hydra-usage.mjs modelBelongsToAgent()
function modelBelongsToAgent(modelId, agent) {
  return getAgent(agent)?.modelBelongsTo(modelId) ?? false;
}

// hydra-actualize.mjs economy model
const modelOverride = useEconomy ? (getAgent(agent)?.economyModel(budgetCfg) ?? undefined) : undefined;

// orchestrator-daemon.mjs
const readInstructions = getAgent(agent)?.readInstructions(instructionFile);
const taskRules = getAgent(agent)?.taskRules ?? [];

// hydra-model-recovery.mjs
const result = await getAgent(agent)?.quotaVerify(apiKey);

// hydra-operator.mjs / orchestrator-daemon.mjs task rules
const rules = getAgent(agent)?.taskRules ?? [];
```

### Phase 4 — Tests

- Verify all 4 physical agents' `parseOutput()` returns correct shape for fixture stdout
- Verify `features.executeMode` routing in executor (mock spawn)
- Verify `modelBelongsTo()` for all agents
- Verify `registerAgent()` applies defaults for an agent that provides no new fields
- Regression: run full test suite; no existing tests should break

---

## What This Unblocks

Once Phase 1–3 are done:

- **Custom agents plan**: wizard creates an agent object with these methods → `registerAgent()` → works everywhere. No executor changes needed per new agent.
- **Copilot integration plan**: Copilot's `PHYSICAL_AGENTS` entry provides its `parseOutput`, `features.jsonOutput`, `--model` passthrough, `quotaVerify: null` — all handled. The `features.jsonOutput: false → true` flip is the only change needed when the CLI ships JSON mode.
- **Any future agent** (Aider, Continue, local Ollama, etc.) — provide the interface, register, done.

---

## What This Does NOT Change

- The `PHYSICAL_AGENTS` object stays in `hydra-agents.mjs` — no file splitting
- `registerAgent()` API is backward-compatible — existing callers unaffected
- The agent names (`claude`, `gemini`, `codex`, `local`) don't change
- No external plugin loading, no manifest files, no hot-reload
- **`hydra-council.mjs` phase filters** (`entry.agent === 'claude'`) — these filter log *entries* by name, not dispatch behavior. Leave for a follow-up.
- **`hydra-audit.mjs`** agent command/model hardcodes — in scope for Phase 3 but low risk; can be last.

## Phase 2 Without Phase 3 — Risk Inventory

If Phase 2 (executor refactor) ships without Phase 3 (callsite cleanup) complete, the built-in agents still run correctly — but any **new or non-core agent** (Copilot, custom) will exhibit silent failures:

| Callsite | Symptom if not migrated |
|---|---|
| `hydra-usage.mjs modelBelongsToAgent()` | `modelBelongsTo()` returns `false` → usage stats show "unknown agent" or wrong ownership |
| `hydra-actualize.mjs` economy model | Economy mode ignores the agent's preferred fallback; falls through to `undefined` → uses full model unexpectedly |
| `orchestrator-daemon.mjs` read instructions | New agent gets hardcoded Claude instructions; wrong context preamble |
| `hydra-model-recovery.mjs` quota check | Quota verification silently skipped (`undefined` at line 430); agent marked healthy when quota is exhausted |
| `hydra-operator.mjs` task rules | Generic rules only; agent-specific guidance missing |
| `hydra-metrics.mjs` token extraction | New agents still get the old per-agent if/else (which won't match) → `tokenUsage: null` → cost accounting silent gap |

**Conclusion:** Phase 2 and Phase 3 must ship together. They are a single atomic PR.

---

## Testing Strategy

Tests use `node:test` + `node:assert/strict`. New test file: `test/hydra-agents-plugin.test.mjs`.

```javascript
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { initAgentRegistry, getAgent, registerAgent } from '../lib/hydra-agents.mjs';

before(() => initAgentRegistry());

describe('plugin interface — all physical agents', () => {
  for (const name of ['claude', 'gemini', 'codex', 'local']) {
    it(`${name} has features object`, () => {
      const a = getAgent(name);
      assert.equal(typeof a.features, 'object');
      assert.ok('executeMode' in a.features);
    });
    it(`${name} parseOutput returns correct shape`, () => {
      const a = getAgent(name);
      const result = a.parseOutput('some output');
      assert.ok('output' in result);
      assert.ok('tokenUsage' in result);
      assert.ok('costUsd' in result);
    });
    it(`${name} modelBelongsTo is a function`, () => {
      assert.equal(typeof getAgent(name).modelBelongsTo, 'function');
    });
    it(`${name} economyModel is a function`, () => {
      assert.equal(typeof getAgent(name).economyModel, 'function');
    });
    it(`${name} taskRules is an array`, () => {
      assert.ok(Array.isArray(getAgent(name).taskRules));
    });
  }
});

describe('registerAgent() applies defaults for missing plugin fields', () => {
  it('minimal definition gets all defaults', () => {
    registerAgent('test-minimal', {
      type: 'physical', invoke: { headless: (p) => ['test', [p]] },
    });
    const a = getAgent('test-minimal');
    assert.equal(a.features.executeMode, 'spawn');
    assert.equal(typeof a.parseOutput, 'function');
    assert.equal(typeof a.modelBelongsTo, 'function');
    assert.deepEqual(a.taskRules, []);
  });
});

describe('claude parseOutput', () => {
  it('extracts output and tokens from structured JSON', () => {
    const stdout = JSON.stringify({
      type: 'result', result: 'Done.', cost_usd: 0.002,
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
    });
    const { output, tokenUsage, costUsd } = getAgent('claude').parseOutput(stdout);
    assert.equal(output, 'Done.');
    assert.equal(tokenUsage.inputTokens, 100);
    assert.equal(tokenUsage.outputTokens, 50);
    assert.equal(tokenUsage.cacheCreationTokens, 10);
    assert.equal(costUsd, 0.002);
  });
  it('falls back to raw stdout on parse failure', () => {
    const { output } = getAgent('claude').parseOutput('not json');
    assert.equal(output, 'not json');
  });
});

describe('codex parseOutput', () => {
  it('extracts text and accumulates tokens across JSONL lines', () => {
    const stdout = [
      JSON.stringify({ type: 'message', content: 'Hello ', usage: { input_tokens: 50, output_tokens: 20 } }),
      JSON.stringify({ type: 'message', content: 'world.',  usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join('\n');
    const { output, tokenUsage } = getAgent('codex').parseOutput(stdout);
    assert.ok(output.includes('Hello'));
    assert.equal(tokenUsage.inputTokens, 60);
    assert.equal(tokenUsage.outputTokens, 25);
  });

  it('mixed message/usage/error JSONL does not crash and accumulates tokens', () => {
    const stdout = [
      JSON.stringify({ type: 'message', content: 'Part 1. ', usage: { input_tokens: 10, output_tokens: 5 } }),
      JSON.stringify({ type: 'error', message: 'Tool failed' }),
      JSON.stringify({ type: 'message', content: 'Part 2.', usage: { input_tokens: 8, output_tokens: 3 } }),
    ].join('\n');
    const { output, tokenUsage } = getAgent('codex').parseOutput(stdout);
    assert.ok(output.includes('Part 1'));
    assert.ok(output.includes('Part 2'));
    assert.equal(tokenUsage.inputTokens, 18);
    assert.equal(tokenUsage.outputTokens, 8);
  });

  it('non-JSON stdout falls back to raw', () => {
    const { output, tokenUsage } = getAgent('codex').parseOutput('plain text');
    assert.equal(output, 'plain text');
    assert.equal(tokenUsage, null);
  });
});

describe('executor routing guards', () => {
  it('local agent has executeMode=api and invoke.headless=null', () => {
    const a = getAgent('local');
    assert.equal(a.features.executeMode, 'api');
    assert.equal(a.invoke.headless, null);
  });

  it('custom api agent gets executeMode=api default from customType', () => {
    registerAgent('test-api-agent', {
      type: 'physical', customType: 'api',
      invoke: { headless: null },
    });
    // executeMode should default to 'api' when customType === 'api'
    assert.equal(getAgent('test-api-agent').features.executeMode, 'api');
  });
});
```

---

*Document created: 2026-03-08*
*Revised: 2026-03-08 — GPT-5.4 review: fixed gemini-direct abstraction leak, local headless null guard, parseOutput double-parse risk, added Phase 2+3 atomicity requirement, added hydra-audit.mjs to scope, expanded test fixtures*
*Status: Revised — ready for implementation*
