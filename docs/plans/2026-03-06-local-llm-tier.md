# Local LLM Agent Tier Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `local` 4th physical agent backed by any OpenAI-compatible HTTP endpoint (Ollama, LM Studio, vllm, etc.) with two-layer routing: `:mode economy` for intentional local-first dispatch, and a budget gate for automatic fallback when cloud usage exceeds thresholds.

**Architecture:** `hydra-local.mjs` wraps `hydra-openai.mjs`'s `streamCompletion()` with a configurable `baseUrl` instead of the hardcoded OpenAI URL. The `local` agent is registered as a 4th physical agent in `hydra-agents.mjs`. `bestAgentFor()` gets a mode multiplier — economy mode boosts local affinity scores by 1.5×, performance mode halves them. `executeAgent()` in `agent-executor.mjs` gets a branch for `agent === 'local'` that calls `streamLocalCompletion()` directly (no cross-spawn). Budget gate checks `checkUsage()` at dispatch time and applies the same boost automatically when daily/weekly cloud usage exceeds thresholds.

**Tech Stack:** Node.js ESM, existing `hydra-openai.mjs` SSE streaming, `node:test` for tests, `picocolors` for status bar.

---

### Task 1: Write failing tests for `hydra-local.mjs`

**Files:**
- Create: `test/hydra-local.test.mjs`

**Step 1: Create the test file**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We'll import after the module exists — stub for now to verify test runner
describe('hydra-local', () => {
  it('exports streamLocalCompletion', async () => {
    const mod = await import('../lib/hydra-local.mjs');
    assert.strictEqual(typeof mod.streamLocalCompletion, 'function');
  });

  it('returns local-unavailable on ECONNREFUSED', async () => {
    const { streamLocalCompletion } = await import('../lib/hydra-local.mjs');
    // Port 19999 is almost certainly unused
    const result = await streamLocalCompletion(
      [{ role: 'user', content: 'hello' }],
      { model: 'test', baseUrl: 'http://localhost:19999/v1' }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCategory, 'local-unavailable');
    assert.strictEqual(result.output, '');
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd E:/Dev/HYDRA && node --test test/hydra-local.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `hydra-local.mjs` — confirms tests are wired correctly.

---

### Task 2: Implement `hydra-local.mjs`

**Files:**
- Create: `lib/hydra-local.mjs`

**Step 1: Write the module**

```javascript
/**
 * Hydra Local — Streaming client for any OpenAI-compatible local endpoint.
 *
 * Wraps hydra-openai.mjs coreStreamOpenAI logic with a configurable baseUrl
 * instead of the hardcoded OpenAI API URL. Works with Ollama, LM Studio,
 * vllm, llama.cpp server, and any other OpenAI-compat runtime.
 */

/**
 * Stream a chat completion from a local OpenAI-compatible endpoint.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} cfg
 * @param {string} cfg.model - Model identifier (e.g. 'mistral:7b')
 * @param {string} cfg.baseUrl - Base URL of the local server (e.g. 'http://localhost:11434/v1')
 * @param {number} [cfg.maxTokens] - Optional max tokens
 * @param {Function} [onChunk] - Called with each streamed text chunk
 * @returns {Promise<{ok: boolean, fullResponse: string, usage: object|null, rateLimits: null, output: string, errorCategory?: string}>}
 */
export async function streamLocalCompletion(messages, cfg, onChunk) {
  const { baseUrl, model, maxTokens } = cfg;

  const body = {
    model,
    messages,
    stream: true,
  };
  if (maxTokens) body.max_tokens = maxTokens;

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') {
      return { ok: false, errorCategory: 'local-unavailable', output: '', fullResponse: '', usage: null, rateLimits: null };
    }
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Local API error ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(trimmed.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) {
          fullResponse += delta.content;
          if (onChunk) onChunk(delta.content);
        }
        if (data.usage) usage = data.usage;
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { ok: true, fullResponse, output: fullResponse, usage, rateLimits: null };
}
```

**Step 2: Run tests**

```bash
cd E:/Dev/HYDRA && node --test test/hydra-local.test.mjs
```

Expected: both tests pass. `local-unavailable` test may take a second while Node times out the refused connection.

**Step 3: Commit**

```bash
cd E:/Dev/HYDRA && git add lib/hydra-local.mjs test/hydra-local.test.mjs && git commit -m "feat(local): add hydra-local.mjs OpenAI-compat streaming client"
```

---

### Task 3: Write failing tests for `local` agent registration + mode routing

**Files:**
- Modify: `test/hydra-local.test.mjs` (append new describe block)

**Step 1: Append agent + routing tests**

```javascript
describe('local agent registration', () => {
  it('local agent is in registry when enabled', async () => {
    const { initAgentRegistry, listAgents, _resetRegistry } = await import('../lib/hydra-agents.mjs');
    _resetRegistry();
    initAgentRegistry();
    const agents = listAgents();
    assert.ok(agents.some(a => a.name === 'local'), 'local agent should be registered');
  });

  it('bestAgentFor returns local for implementation in economy mode when local enabled', async () => {
    const { bestAgentFor, _resetRegistry, initAgentRegistry } = await import('../lib/hydra-agents.mjs');
    _resetRegistry();
    initAgentRegistry();
    const agent = bestAgentFor('implementation', { mode: 'economy' });
    // local implementation affinity × 1.5 = 1.23, codex = 0.85 → local wins
    assert.strictEqual(agent, 'local');
  });

  it('bestAgentFor still picks cloud for planning in economy mode', async () => {
    const { bestAgentFor } = await import('../lib/hydra-agents.mjs');
    const agent = bestAgentFor('planning', { mode: 'economy' });
    // local planning × 1.5 = 0.375, claude = 0.95 → claude wins
    assert.notStrictEqual(agent, 'local');
  });

  it('bestAgentFor never picks local for research', async () => {
    const { bestAgentFor } = await import('../lib/hydra-agents.mjs');
    for (const mode of ['economy', 'balanced', 'performance']) {
      const agent = bestAgentFor('research', { mode });
      assert.notStrictEqual(agent, 'local', `local should never win research in ${mode} mode`);
    }
  });
});
```

**Step 2: Run to verify they fail**

```bash
cd E:/Dev/HYDRA && node --test test/hydra-local.test.mjs 2>&1 | tail -20
```

Expected: failures on the agent registration tests.

---

### Task 4: Register `local` agent in `hydra-agents.mjs` + mode-aware `bestAgentFor()`

**Files:**
- Modify: `lib/hydra-agents.mjs`

**Step 1: Add `local` to `PHYSICAL_AGENTS`**

Find the `PHYSICAL_AGENTS` object. It ends with the `codex` entry followed by `};`. Add `local` as the final entry before the closing `};`:

```javascript
  local: {
    name: 'local',
    type: 'physical',
    displayName: 'Local',
    label: 'Local LLM (OpenAI-compat)',
    cli: null,        // API-backed — no CLI binary
    invoke: {
      nonInteractive: null,
      interactive: null,
      headless: null,   // handled directly in agent-executor.mjs
    },
    contextBudget: 32_000,
    strengths: ['implementation', 'refactor', 'testing', 'low-latency', 'cost-zero'],
    weaknesses: ['planning', 'reasoning', 'research'],
    councilRole: null,  // excluded from council deliberation
    taskAffinity: {
      planning:       0.25,
      architecture:   0.20,
      review:         0.45,
      refactor:       0.80,
      implementation: 0.82,
      analysis:       0.40,
      testing:        0.70,
      security:       0.30,
      research:       0.00,  // hard excluded — never routes to local
      documentation:  0.50,
    },
    rolePrompt: 'You are a local AI assistant. Be concise and implementation-focused. Avoid lengthy explanations.',
    timeout: 3 * 60 * 1000,
    tags: ['local', 'free', 'offline'],
    enabled: false,  // opt-in — user must set config.local.enabled = true
  },
```

**Step 2: Update `bestAgentFor()` to accept mode + budgetState** (lines 459–480)

Replace the function body:

```javascript
export function bestAgentFor(taskType, opts = {}) {
  const includeVirtual = opts.includeVirtual || false;
  const mode = opts.mode || 'balanced';
  const budgetState = opts.budgetState || null;
  const cfg = loadHydraConfig();
  const learningEnabled = cfg.agents?.affinityLearning?.enabled;
  const overrides = learningEnabled ? loadAffinityOverrides() : {};

  // Budget gate: auto-boost local when cloud usage exceeds thresholds
  const localGate = cfg.local?.budgetGate || {};
  const budgetTriggered =
    (budgetState?.daily?.percentUsed  > (localGate.dailyPct  ?? 80)) ||
    (budgetState?.weekly?.percentUsed > (localGate.weeklyPct ?? 75));

  const localBoost       = mode === 'economy'     || budgetTriggered;
  const localPenalty     = mode === 'performance';

  const candidates = [];
  for (const [name, agent] of _registry) {
    if (!agent.enabled) continue;
    if (!includeVirtual && agent.type === AGENT_TYPE.VIRTUAL) continue;
    let score = agent.taskAffinity[taskType] || 0;
    // Apply learning overrides
    const key = `${name}:${taskType}`;
    if (overrides[key]?.adjustment) {
      score += overrides[key].adjustment;
    }
    // Apply mode multiplier to local agent
    if (name === 'local') {
      if (localBoost)   score *= 1.5;
      if (localPenalty) score *= 0.5;
    }
    candidates.push({ name, score });
  }
  if (candidates.length === 0) return 'claude';
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].name;
}
```

**Step 3: Run tests**

```bash
cd E:/Dev/HYDRA && node --test test/hydra-local.test.mjs
```

Expected: all 6 tests pass. Note: `local` is `enabled: false` by default, so the "economy" tests require enabling it in test setup — if they fail, check that the test calls `_resetRegistry()` + ensures `local.enabled = true` is set in config (may need to mock `loadHydraConfig()`).

> **If local agent has `enabled: false`**, the tests above will fail because the registry skips disabled agents. Update the test to temporarily enable local: after `initAgentRegistry()`, call `registerAgent('local', { ...localDef, enabled: true })`. Or change the default to `enabled: true` and control it purely via config — simpler.

**Step 4: Decide on default enabled state**

Since `local` agent checks `cfg.local?.enabled` anyway (we'll add that check in agent-executor.mjs), set `enabled: true` in PHYSICAL_AGENTS and guard at invocation time instead. Update `enabled: false` → `enabled: true` in the `local` entry. Config remains the source of truth for whether local is actually used.

**Step 5: Re-run tests**

```bash
cd E:/Dev/HYDRA && node --test test/hydra-local.test.mjs
```

Expected: all pass.

**Step 6: Commit**

```bash
cd E:/Dev/HYDRA && git add lib/hydra-agents.mjs test/hydra-local.test.mjs && git commit -m "feat(local): register local agent + mode-aware bestAgentFor()"
```

---

### Task 5: Add `local` config section + `routing.mode` to `hydra-config.mjs`

**Files:**
- Modify: `lib/hydra-config.mjs`

**Step 1: Add `local` to DEFAULT_CONFIG**

Find the `routing:` section (line 305). Add the `local` section before it:

```javascript
  local: {
    enabled: false,
    baseUrl: 'http://localhost:11434/v1',
    model: 'mistral:7b',
    fastModel: 'mistral:7b',
    budgetGate: { dailyPct: 80, weeklyPct: 75 },
  },
```

**Step 2: Add `mode` to the `routing` section** (line 305–312)

```javascript
  routing: {
    mode: 'balanced',    // 'economy' | 'balanced' | 'performance'
    useLegacyTriage: false,
    councilGate: true,
    tandemEnabled: true,
    councilMode: 'sequential',
  },
```

**Step 3: Add `local` to `mergeWithDefaults()`**

Find `mergeWithDefaults` (around line 406). After the line `modeTiers: deepMergeSection(...)`, add:

```javascript
    local: deepMergeSection(DEFAULT_CONFIG.local, parsed.local),
```

And in the early-return backfill block (around line 449), add:

```javascript
  if (!parsed.local) parsed.local = { ...DEFAULT_CONFIG.local };
  if (!parsed.routing?.mode) {
    parsed.routing = { ...DEFAULT_CONFIG.routing, ...(parsed.routing || {}) };
  }
```

**Step 4: Verify no test regressions**

```bash
cd E:/Dev/HYDRA && npm test 2>&1 | tail -30
```

Expected: existing tests still pass.

**Step 5: Commit**

```bash
cd E:/Dev/HYDRA && git add lib/hydra-config.mjs && git commit -m "feat(local): add local + routing.mode config defaults"
```

---

### Task 6: Add `local` execution branch to `agent-executor.mjs`

**Files:**
- Modify: `lib/hydra-shared/agent-executor.mjs`

**Step 1: Add import at top** (after line 25, alongside other imports)

```javascript
import { streamLocalCompletion } from '../hydra-local.mjs';
```

**Step 2: Add `local` branch in `executeAgent()`** (after line 511, the `gemini` branch)

```javascript
  // Local agent: call OpenAI-compat HTTP endpoint directly (no cross-spawn)
  if (agent === 'local') {
    return executeLocalAgent(prompt, opts);
  }
```

**Step 3: Add `executeLocalAgent()` function**

Add this as a standalone function before `executeAgent()` (around line 500):

```javascript
async function executeLocalAgent(prompt, opts = {}) {
  const {
    timeoutMs = 3 * 60 * 1000,
    onProgress,
    onStatusBar,
    phaseLabel,
    modelOverride,
  } = opts;

  const cfg = loadHydraConfig();
  if (!cfg.local?.enabled) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Local agent not enabled. Set config.local.enabled = true.',
      error: 'local-disabled',
      errorCategory: 'local-disabled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const baseUrl = cfg.local.baseUrl || 'http://localhost:11434/v1';
  const model   = modelOverride || cfg.local.model || 'mistral:7b';
  const startTime = Date.now();
  const metricsHandle = recordCallStart('local', model);
  const span = await startAgentSpan('local', model, { phase: phaseLabel });

  let output = '';
  try {
    const messages = [{ role: 'user', content: prompt }];
    const result = await streamLocalCompletion(messages, { baseUrl, model, maxTokens: cfg.local.maxTokens }, (chunk) => {
      output += chunk;
      if (onProgress) {
        const elapsed = Date.now() - startTime;
        onProgress(elapsed, Math.round(Buffer.byteLength(output) / 1024));
      }
    });

    const durationMs = Date.now() - startTime;

    if (!result.ok) {
      // local-unavailable: fall back to best cloud agent
      recordCallError(metricsHandle, result.errorCategory);
      await endAgentSpan(span, { ok: false, error: result.errorCategory });
      return { ...result, stdout: '', stderr: result.errorCategory, durationMs, timedOut: false };
    }

    recordCallComplete(metricsHandle, { output: result.output, stdout: result.output });
    await endAgentSpan(span, { ok: true });
    return {
      ok: true,
      output: result.output,
      stdout: result.output,
      stderr: '',
      error: null,
      exitCode: 0,
      signal: null,
      durationMs,
      timedOut: false,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, err.message);
    await endAgentSpan(span, { ok: false, error: err.message });
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: err.message,
      error: err.message,
      errorCategory: 'local-error',
      exitCode: null,
      signal: null,
      durationMs,
      timedOut: false,
    };
  }
}
```

**Step 4: Add `local-unavailable` fallback in `executeAgentWithRecovery()`**

Find `executeAgentWithRecovery()` (line 774). After the initial `executeAgent()` call and before model-error detection, add:

```javascript
  // Local-unavailable: transparent cloud fallback, no circuit breaker
  if (result.errorCategory === 'local-unavailable') {
    const fallback = cfg.routing?.mode === 'economy' ? 'codex' : 'claude';
    console.warn(`[local] server unreachable — falling back to ${fallback}`);
    return executeAgent(fallback, prompt, { ...opts, _localFallback: true });
  }
```

**Step 5: Run full test suite**

```bash
cd E:/Dev/HYDRA && npm test 2>&1 | tail -30
```

**Step 6: Commit**

```bash
cd E:/Dev/HYDRA && git add lib/hydra-shared/agent-executor.mjs && git commit -m "feat(local): add executeLocalAgent() + local-unavailable fallback"
```

---

### Task 7: Add `:mode` command + budget gate to `hydra-operator.mjs`

**Files:**
- Modify: `lib/hydra-operator.mjs`

**Step 1: Find where `:usage` is handled**

Search for `:usage` in the REPL command dispatch. The `:mode` command should live nearby.

**Step 2: Add `:mode` handler**

Find the block handling `if (line === ':usage')` and add before it:

```javascript
        if (line === ':mode' || line.startsWith(':mode ')) {
          const arg = line.slice(5).trim();
          const validModes = ['economy', 'balanced', 'performance'];
          if (!arg) {
            const current = cfg.routing?.mode || 'balanced';
            const chip = current === 'economy' ? pc.yellow('◆ ECO') : current === 'performance' ? pc.cyan('◆ PERF') : pc.green('◆ BAL');
            console.log(`Active mode: ${chip} ${pc.dim('(economy | balanced | performance)')}`);
          } else if (validModes.includes(arg)) {
            cfg.routing = { ...(cfg.routing || {}), mode: arg };
            saveHydraConfig(cfg);
            const chip = arg === 'economy' ? pc.yellow('◆ ECO') : arg === 'performance' ? pc.cyan('◆ PERF') : pc.green('◆ BAL');
            console.log(`Mode set to ${chip}`);
            if (setActiveMode) setActiveMode(arg);  // update status bar if function exists
          } else {
            console.log(pc.red(`Unknown mode "${arg}". Use: economy | balanced | performance`));
          }
          continue;
        }
```

**Step 3: Thread `mode` + `budgetState` into dispatch calls**

Find where `classifyPrompt()` is called for auto/smart dispatch (search for `classifyPrompt` in operator). After the classification, pass mode and budgetState:

```javascript
          // Get routing context for mode-aware agent selection
          const routingMode = cfg.routing?.mode || 'balanced';
          let budgetState = null;
          try { budgetState = checkUsage(); } catch { /* skip */ }

          // Pass to bestAgentFor via classification result
          const classification = classifyPrompt(promptText);
          const agent = classification.suggestedAgent || bestAgentFor(classification.taskType, { mode: routingMode, budgetState });
```

> **Note:** `classifyPrompt()` calls `bestAgentFor()` internally (in `hydra-utils.mjs` line 569). You may need to pass `mode`/`budgetState` through to that call, or re-call `bestAgentFor()` after classification with the context. The simplest fix: after `classifyPrompt()` returns, override `suggestedAgent` with a mode-aware call.

**Step 4: Add `:mode` to KNOWN_COMMANDS**

Search for `KNOWN_COMMANDS` array in `hydra-operator.mjs` and add `':mode'`.

**Step 5: Manual smoke test**

```bash
npm run go
# In REPL:
:mode
:mode economy
:mode balanced
```

Expected: mode chip displayed, config persisted.

**Step 6: Commit**

```bash
cd E:/Dev/HYDRA && git add lib/hydra-operator.mjs && git commit -m "feat(local): add :mode command + budget gate threading"
```

---

### Task 8: Add mode chip to `hydra-statusbar.mjs`

**Files:**
- Modify: `lib/hydra-statusbar.mjs`

**Step 1: Find the context line renderer**

Search for `buildContextLine` or the function that renders line 2 of the 5-line status bar.

**Step 2: Add mode chip**

In the context line, after the mode icon or route display, add:

```javascript
  const routingMode = cfg.routing?.mode || 'balanced';
  const modeChip =
    routingMode === 'economy'     ? pc.yellow('◆ECO')  :
    routingMode === 'performance' ? pc.cyan('◆PERF')   : '';
  // Include modeChip in the context line string if non-empty
  // e.g. append to existing contextParts array
  if (modeChip) contextParts.push(modeChip);
```

**Step 3: Visual check**

```bash
npm run go
:mode economy
# Status bar should show ◆ECO chip
:mode balanced
# Chip disappears (balanced is default, no chip shown)
```

**Step 4: Commit**

```bash
cd E:/Dev/HYDRA && git add lib/hydra-statusbar.mjs && git commit -m "feat(local): add mode chip to status bar context line"
```

---

### Task 9: End-to-end test with real Ollama

> **Prerequisite:** Ollama installed and running. `ollama pull mistral:7b` completed.

**Step 1: Enable local in config**

```bash
cd E:/Dev/HYDRA && node -e "
const { loadHydraConfig, saveHydraConfig } = await import('./lib/hydra-config.mjs');
const cfg = loadHydraConfig();
cfg.local = { ...cfg.local, enabled: true };
saveHydraConfig(cfg);
console.log('local enabled');
"
```

**Step 2: Test via operator**

```bash
npm run go
# In REPL:
:mode economy
hello world implement a simple fibonacci function
# Should show local agent in status bar
```

Expected: task dispatched to `local` agent, Ollama responds, output appears.

**Step 3: Test fallback when Ollama is stopped**

```bash
# Stop Ollama, then:
hello world implement a simple fibonacci function
```

Expected: warning `[local] server unreachable — falling back to codex`, task completes via cloud.

**Step 4: Commit final state + run full suite**

```bash
cd E:/Dev/HYDRA && npm test && git add -A && git commit -m "feat(local): full local LLM agent tier + economy mode routing"
```

---

### Task 10: Update docs

**Files:**
- Modify: `CLAUDE.md` — add `local` to Key Modules + Dispatch Modes sections
- Modify: `README.md` — add `:mode` to operator commands table

**Step 1: Update CLAUDE.md**

In the **Key Modules** section, add to `hydra-local.mjs` entry. In **Dispatch Modes**, note that economy mode routes implementation/testing to local.

In the **Key Modules** section, add:
```
- **`hydra-local.mjs`** — Streaming client for any OpenAI-compatible local endpoint (Ollama, LM Studio, vllm, etc.). `streamLocalCompletion(messages, cfg, onChunk)` — wraps the OpenAI SSE format with configurable `baseUrl`. Returns `{ ok, fullResponse, usage, rateLimits: null }`. On ECONNREFUSED returns `{ ok: false, errorCategory: 'local-unavailable' }` triggering transparent cloud fallback. Config: `local.enabled`, `.baseUrl`, `.model`, `.fastModel`, `.budgetGate`.
```

In `hydra-agents.mjs` description, mention `local` as the 4th physical agent.

In `hydra-config.mjs` description, mention `local` and `routing.mode` sections.

**Step 2: Update README.md**

Find the Operator Commands table and add:
```
| `:mode [economy\|balanced\|performance]` | Show or set routing mode. Economy prefers local agent for implementation/testing tasks. |
```

**Step 3: Commit**

```bash
cd E:/Dev/HYDRA && git add CLAUDE.md README.md && git commit -m "docs: update CLAUDE.md + README for local LLM tier and :mode command"
```

---

## Summary of Changes

```
NEW:
  lib/hydra-local.mjs                      ← OpenAI-compat streaming client
  test/hydra-local.test.mjs                ← Tests for local module + agent routing

MODIFIED:
  lib/hydra-agents.mjs                     ← local agent entry + mode-aware bestAgentFor()
  lib/hydra-config.mjs                     ← local + routing.mode defaults
  lib/hydra-shared/agent-executor.mjs      ← executeLocalAgent() + local-unavailable fallback
  lib/hydra-operator.mjs                   ← :mode command + budget gate threading
  lib/hydra-statusbar.mjs                  ← mode chip in context line
  CLAUDE.md                                ← architecture docs
  README.md                                ← :mode in commands table
```

## Verification Checklist

- [ ] `node --test test/hydra-local.test.mjs` — all pass
- [ ] `npm test` — no regressions
- [ ] `:mode economy` sets config and shows ◆ECO chip
- [ ] `:mode balanced` removes chip
- [ ] With Ollama running: implementation task routes to local in economy mode
- [ ] With Ollama stopped: transparent fallback to cloud with warning
- [ ] Planning task stays on claude even in economy mode
- [ ] Research task never routes to local in any mode
- [ ] Budget gate: at 80%+ daily usage, local boost applied automatically
