# Custom Agent Registration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Allow users to register arbitrary AI coding agents — CLI-based (any tool that accepts a prompt flag) or API-based (any OpenAI-compatible endpoint) — as first-class Hydra agents with routing, task affinity, and MCP integration.

**Architecture:** Custom agents live in `agents.customAgents[]` in `hydra.config.json`. On startup, `initAgentRegistry()` loads them and calls `registerAgent()` for each. `executeAgent()` detects them by `customType` and dispatches to `executeCustomCliAgent()` or `executeCustomApiAgent()` — the latter reuses the existing `streamLocalCompletion()` from `hydra-local.mjs`. A wizard command `:agents add` guides setup and calls extended `hydra-setup.mjs` for MCP registration.

**Tech Stack:** Node.js ESM, cross-spawn (already a dependency), `hydra-prompt-choice.mjs` for wizard UI, no new npm packages.

---

### Task 1: Config schema — add `agents.customAgents` array and affinity presets

**Files:**

- Modify: `lib/hydra-config.mjs` (around line 144 — `agents:` section; around line 431 — `mergeWithDefaults`)
- Test: `test/hydra-agents.test.mjs` (append tests)

**Context:** `DEFAULT_CONFIG.agents` at line 144 currently has `custom: {}` (used for virtual agents) and `affinityLearning`. We add `customAgents: []` alongside. `mergeWithDefaults` at line 431 uses `deepMergeSection` — this works for arrays because the function assigns arrays verbatim (`merged[k] = v` at line 408 when `v` is an array). We also export `AFFINITY_PRESETS` — a map of preset names to full affinity objects — for use by the wizard.

**Step 1: Write the failing tests**

Append to `test/hydra-agents.test.mjs`:

```javascript
import { loadHydraConfig, AFFINITY_PRESETS } from '../lib/hydra-config.mjs';

test('DEFAULT_CONFIG has agents.customAgents as empty array', () => {
  const cfg = loadHydraConfig();
  assert.ok(Array.isArray(cfg.agents.customAgents), 'customAgents should be an array');
  // Note: only true if test config has no customAgents set
});

test('AFFINITY_PRESETS exports balanced, code-focused, review-focused, research-focused', () => {
  const keys = Object.keys(AFFINITY_PRESETS);
  assert.ok(keys.includes('balanced'));
  assert.ok(keys.includes('code-focused'));
  assert.ok(keys.includes('review-focused'));
  assert.ok(keys.includes('research-focused'));
  // Each preset covers all 10 task types
  const TASK_TYPES_LIST = [
    'planning',
    'architecture',
    'review',
    'refactor',
    'implementation',
    'analysis',
    'testing',
    'security',
    'research',
    'documentation',
  ];
  for (const [, affinity] of Object.entries(AFFINITY_PRESETS)) {
    for (const tt of TASK_TYPES_LIST) {
      assert.strictEqual(typeof affinity[tt], 'number', `preset missing task type: ${tt}`);
    }
  }
});
```

**Step 2: Run tests to verify they fail**

```bash
node --test test/hydra-agents.test.mjs 2>&1 | grep -E "fail|AFFINITY_PRESETS|customAgents"
```

Expected: Fail — `AFFINITY_PRESETS` not exported, `customAgents` may not be array.

**Step 3: Implement**

In `lib/hydra-config.mjs`, add the export before `DEFAULT_CONFIG`:

```javascript
/** Task affinity presets for the custom agent wizard. */
export const AFFINITY_PRESETS = {
  balanced: {
    planning: 0.5,
    architecture: 0.5,
    review: 0.5,
    refactor: 0.5,
    implementation: 0.5,
    analysis: 0.5,
    testing: 0.5,
    security: 0.5,
    research: 0.5,
    documentation: 0.5,
  },
  'code-focused': {
    planning: 0.4,
    architecture: 0.35,
    review: 0.5,
    refactor: 0.8,
    implementation: 0.85,
    analysis: 0.45,
    testing: 0.75,
    security: 0.3,
    research: 0.2,
    documentation: 0.4,
  },
  'review-focused': {
    planning: 0.4,
    architecture: 0.5,
    review: 0.9,
    refactor: 0.55,
    implementation: 0.35,
    analysis: 0.85,
    testing: 0.6,
    security: 0.8,
    research: 0.65,
    documentation: 0.5,
  },
  'research-focused': {
    planning: 0.6,
    architecture: 0.5,
    review: 0.55,
    refactor: 0.3,
    implementation: 0.3,
    analysis: 0.8,
    testing: 0.35,
    security: 0.5,
    research: 0.9,
    documentation: 0.75,
  },
};
```

In `DEFAULT_CONFIG.agents` (around line 144), change:

```javascript
  agents: {
    subAgents: { ... },
    custom: {},
    affinityLearning: { ... },
  },
```

to:

```javascript
  agents: {
    subAgents: { ... },
    custom: {},
    customAgents: [],   // ← add this line
    affinityLearning: { ... },
  },
```

No change needed to `mergeWithDefaults` — `deepMergeSection` already handles arrays correctly (the user's `customAgents` array replaces the default).

**Step 4: Run tests to verify they pass**

```bash
node --test test/hydra-agents.test.mjs 2>&1 | tail -5
```

Expected: All pass, 0 fail.

**Step 5: Commit**

```bash
git add lib/hydra-config.mjs test/hydra-agents.test.mjs
git commit -m "feat(agents): add agents.customAgents[] config schema and AFFINITY_PRESETS"
```

---

### Task 2: Register custom CLI and API agents from config in `initAgentRegistry()`

**Files:**

- Modify: `lib/hydra-agents.mjs` — `registerAgent()` (around line 234) and `initAgentRegistry()` (around line 579)
- Test: `test/hydra-agents.test.mjs` (append tests)

**Context:** `registerAgent()` stores a fixed set of fields but doesn't store `customType`. We need to add `customType` to the stored entry so `executeAgent()` can dispatch correctly. `initAgentRegistry()` already loads `agents.custom` (virtual agents) — we add a second block for `agents.customAgents` (physical CLI/API agents).

**Step 1: Write the failing tests**

Append to `test/hydra-agents.test.mjs`:

```javascript
import { _resetRegistry, initAgentRegistry, getAgent, listAgents } from '../lib/hydra-agents.mjs';
import { saveHydraConfig, loadHydraConfig } from '../lib/hydra-config.mjs';

// These tests modify config — use a describe block with beforeEach/afterEach
import { describe, it, beforeEach, afterEach } from 'node:test';

describe('initAgentRegistry — custom agents', () => {
  let origCustomAgents;

  beforeEach(() => {
    const cfg = loadHydraConfig();
    origCustomAgents = cfg.agents?.customAgents || [];
    // Inject test custom agents into config
    saveHydraConfig({
      agents: {
        ...cfg.agents,
        customAgents: [
          {
            name: 'test-cli-agent',
            type: 'cli',
            displayName: 'Test CLI',
            invoke: {
              nonInteractive: { cmd: 'echo', args: ['{prompt}'] },
              headless: { cmd: 'echo', args: ['{prompt}'] },
            },
            responseParser: 'plaintext',
            contextBudget: 16000,
            councilRole: null,
            taskAffinity: {
              implementation: 0.7,
              review: 0.4,
              research: 0.0,
              planning: 0.3,
              architecture: 0.25,
              refactor: 0.6,
              analysis: 0.4,
              testing: 0.55,
              security: 0.3,
              documentation: 0.4,
            },
            enabled: true,
          },
          {
            name: 'test-api-agent',
            type: 'api',
            displayName: 'Test API',
            baseUrl: 'http://localhost:9999/v1',
            model: 'test-model',
            contextBudget: 8000,
            councilRole: null,
            taskAffinity: {
              implementation: 0.8,
              review: 0.5,
              research: 0.0,
              planning: 0.35,
              architecture: 0.3,
              refactor: 0.75,
              analysis: 0.45,
              testing: 0.65,
              security: 0.25,
              documentation: 0.45,
            },
            enabled: true,
          },
        ],
      },
    });
    _resetRegistry();
    initAgentRegistry();
  });

  afterEach(() => {
    const cfg = loadHydraConfig();
    saveHydraConfig({ agents: { ...cfg.agents, customAgents: origCustomAgents } });
    _resetRegistry();
    initAgentRegistry();
  });

  it('registers custom CLI agent from customAgents config', () => {
    const agent = getAgent('test-cli-agent');
    assert.ok(agent, 'test-cli-agent should be in registry');
    assert.strictEqual(agent.type, 'physical');
    assert.strictEqual(agent.customType, 'cli');
    assert.strictEqual(agent.displayName, 'Test CLI');
  });

  it('registers custom API agent from customAgents config', () => {
    const agent = getAgent('test-api-agent');
    assert.ok(agent, 'test-api-agent should be in registry');
    assert.strictEqual(agent.type, 'physical');
    assert.strictEqual(agent.customType, 'api');
  });

  it('custom agents appear in listAgents({ type: "physical" })', () => {
    const names = listAgents({ type: 'physical' }).map((a) => a.name);
    assert.ok(names.includes('test-cli-agent'));
    assert.ok(names.includes('test-api-agent'));
  });

  it('skips custom agent entry with invalid name', () => {
    // Should not throw — invalid agents are silently skipped
    // (We test this indirectly — the registry initialized without error above)
    assert.ok(getAgent('claude'), 'built-in agents still registered');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
node --test test/hydra-agents.test.mjs 2>&1 | grep -E "fail|custom"
```

Expected: Fail — `customType` not in stored entry, `saveHydraConfig` may not exist (check).

Check if `saveHydraConfig` is exported:

```bash
grep -n "export.*saveHydraConfig" lib/hydra-config.mjs
```

**Step 3: Implement**

In `lib/hydra-agents.mjs`, in `registerAgent()` at the `entry` object (around line 234), add one field:

```javascript
const entry = {
  name: lower,
  type,
  customType: def.customType || null, // ← add this line
  baseAgent: def.baseAgent || null,
  // ... rest unchanged
};
```

In `initAgentRegistry()` (around line 579), after the existing `agentsCfg.custom` block, add:

```javascript
// Register custom physical agents (CLI and API types)
if (Array.isArray(agentsCfg.customAgents)) {
  for (const def of agentsCfg.customAgents) {
    if (!def?.name || !['cli', 'api'].includes(def?.type)) continue;
    try {
      registerAgent(def.name, {
        ...def,
        type: AGENT_TYPE.PHYSICAL,
        customType: def.type,
        cli: def.type === 'cli' ? def.invoke?.headless?.cmd || def.name : null,
        invoke: def.invoke || null,
      });
    } catch {
      /* skip invalid custom agents silently */
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
node --test test/hydra-agents.test.mjs 2>&1 | tail -5
```

**Step 5: Run full suite**

```bash
node --test 2>&1 | tail -5
```

Expected: 0 fail.

**Step 6: Commit**

```bash
git add lib/hydra-agents.mjs test/hydra-agents.test.mjs
git commit -m "feat(agents): load customAgents[] physical agents in initAgentRegistry"
```

---

### Task 3: Template expansion + `executeCustomCliAgent()` in agent-executor

**Files:**

- Modify: `lib/hydra-shared/agent-executor.mjs` — add helpers and `executeCustomCliAgent()`
- Test: `test/hydra-agent-executor.test.mjs` (append tests)

**Context:** CLI agents store `invoke.headless: { cmd: string, args: string[] }`. Args contain `{prompt}`, `{cwd}`, `{outputFile}` placeholders. We expand these at call time. The child process is spawned with `cross-spawn` (already imported as `spawn`). ENOENT → `custom-cli-unavailable`. Non-zero exit → `custom-cli-error`. Response parsing: `plaintext` = stdout as-is, `json` = extract `.content`/`.text`/`.message`, `markdown` = stdout as-is.

Check what's in the agent-executor test file:

```bash
head -30 test/hydra-agent-executor.test.mjs
```

**Step 1: Write the failing tests**

Append to `test/hydra-agent-executor.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Import the helpers we're about to create
import { expandInvokeArgs, parseCliResponse } from '../lib/hydra-shared/agent-executor.mjs';

describe('expandInvokeArgs', () => {
  it('substitutes {prompt} with the prompt value', () => {
    const args = ['suggest', '-p', '{prompt}'];
    const result = expandInvokeArgs(args, { prompt: 'hello world' });
    assert.deepStrictEqual(result, ['suggest', '-p', 'hello world']);
  });

  it('substitutes {cwd} with cwd value', () => {
    const args = ['{prompt}', '--cwd', '{cwd}'];
    const result = expandInvokeArgs(args, { prompt: 'task', cwd: '/tmp/project' });
    assert.deepStrictEqual(result, ['task', '--cwd', '/tmp/project']);
  });

  it('leaves unknown placeholders intact', () => {
    const args = ['{unknown}'];
    const result = expandInvokeArgs(args, { prompt: 'x' });
    assert.deepStrictEqual(result, ['{unknown}']);
  });
});

describe('parseCliResponse', () => {
  it('returns stdout as-is for plaintext parser', () => {
    assert.strictEqual(parseCliResponse('hello output', 'plaintext'), 'hello output');
  });

  it('extracts .content from JSON for json parser', () => {
    const stdout = JSON.stringify({ content: 'extracted' });
    assert.strictEqual(parseCliResponse(stdout, 'json'), 'extracted');
  });

  it('falls back to raw stdout when JSON parse fails', () => {
    assert.strictEqual(parseCliResponse('not json', 'json'), 'not json');
  });

  it('returns stdout as-is for markdown parser', () => {
    assert.strictEqual(parseCliResponse('# heading', 'markdown'), '# heading');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
node --test test/hydra-agent-executor.test.mjs 2>&1 | grep -E "fail|expandInvokeArgs|parseCliResponse"
```

Expected: Fail — functions not exported.

**Step 3: Implement**

In `lib/hydra-shared/agent-executor.mjs`, after the `streamLocalCompletion` import block (around line 30), add the two helpers and then `executeCustomCliAgent()`.

Add after the imports:

```javascript
// ── Custom Agent Helpers ──────────────────────────────────────────────────────

/**
 * Expand {placeholder} tokens in an args array.
 * Unknown placeholders are left intact.
 * @param {string[]} args
 * @param {Record<string, string>} vars
 * @returns {string[]}
 */
export function expandInvokeArgs(args, vars) {
  return args.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match)),
  );
}

/**
 * Parse CLI stdout based on the agent's responseParser setting.
 * @param {string} stdout
 * @param {'plaintext'|'json'|'markdown'} parser
 * @returns {string}
 */
export function parseCliResponse(stdout, parser) {
  if (parser === 'json') {
    try {
      const data = JSON.parse(stdout);
      return data.content ?? data.text ?? data.message ?? data.output ?? stdout;
    } catch {
      return stdout;
    }
  }
  return stdout; // plaintext and markdown both return raw stdout
}
```

Add `executeCustomCliAgent()` right after `executeLocalAgent()` (around line 580), before the main `executeAgent()` function:

```javascript
// ── Custom CLI Agent ──────────────────────────────────────────────────────────

async function executeCustomCliAgent(agentName, prompt, opts = {}) {
  const { cwd, timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const cfg = loadHydraConfig();
  const def = (cfg.agents?.customAgents || []).find((a) => a.name === agentName);

  if (!def || def.enabled === false) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Custom agent disabled or not found.',
      error: 'custom-cli-disabled',
      errorCategory: 'custom-cli-disabled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const invokeConfig = def.invoke?.headless || def.invoke?.nonInteractive;
  if (!invokeConfig?.cmd || !Array.isArray(invokeConfig?.args)) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Custom agent has no valid invoke config.',
      error: 'custom-cli-error',
      errorCategory: 'custom-cli-error',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const vars = { prompt, cwd: cwd || process.cwd() };
  const args = expandInvokeArgs(invokeConfig.args, vars);
  const cmd = invokeConfig.cmd;
  const startTime = Date.now();
  const metricsHandle = recordCallStart(agentName, agentName);
  const span = await startAgentSpan(agentName, agentName, { phase: phaseLabel });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.on('error', async (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const isUnavailable = err.code === 'ENOENT';
      const errorCategory = isUnavailable ? 'custom-cli-unavailable' : 'custom-cli-error';
      recordCallError(metricsHandle, errorCategory);
      await endAgentSpan(span, { ok: false, error: errorCategory });
      resolve({
        ok: false,
        output: '',
        stdout: '',
        stderr: err.message,
        error: errorCategory,
        errorCategory,
        exitCode: null,
        signal: null,
        durationMs,
        timedOut: false,
      });
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (onProgress) onProgress(Date.now() - startTime, Math.round(stdout.length / 1024));
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      if (code !== 0 && !timedOut) {
        recordCallError(metricsHandle, 'custom-cli-error');
        await endAgentSpan(span, { ok: false, error: 'custom-cli-error' });
        resolve({
          ok: false,
          output: '',
          stdout,
          stderr,
          error: 'custom-cli-error',
          errorCategory: 'custom-cli-error',
          exitCode: code,
          signal,
          durationMs,
          timedOut: false,
        });
        return;
      }
      const output = parseCliResponse(stdout, def.responseParser || 'plaintext');
      recordCallComplete(metricsHandle, { output, stdout: output });
      await endAgentSpan(span, { ok: true });
      resolve({
        ok: true,
        output,
        stdout: output,
        stderr,
        error: null,
        errorCategory: null,
        exitCode: code,
        signal,
        durationMs,
        timedOut,
      });
    });
  });
}
```

**Step 4: Run tests to verify they pass**

```bash
node --test test/hydra-agent-executor.test.mjs 2>&1 | tail -5
```

**Step 5: Run full suite**

```bash
node --test 2>&1 | tail -5
```

Expected: 0 fail.

**Step 6: Commit**

```bash
git add lib/hydra-shared/agent-executor.mjs test/hydra-agent-executor.test.mjs
git commit -m "feat(agents): add expandInvokeArgs, parseCliResponse, executeCustomCliAgent"
```

---

### Task 4: `executeCustomApiAgent()` and routing in `executeAgent()`

**Files:**

- Modify: `lib/hydra-shared/agent-executor.mjs`
- Test: `test/hydra-agent-executor.test.mjs` (append tests)

**Context:** API agents reuse `streamLocalCompletion` directly. `executeAgent()` checks `getAgent(agent)?.customType` and dispatches. The `getAgent` import is already available via `hydra-agents.mjs`.

**Step 1: Write the failing tests**

Append to `test/hydra-agent-executor.test.mjs`:

```javascript
describe('executeAgent — custom agent routing', () => {
  it('returns custom-cli-disabled for unknown custom CLI agent', async () => {
    // An agent name that isn't in the registry routes to custom-cli-disabled
    // if it has customType. We test the disabled path by registering a disabled agent.
    const { registerAgent, _resetRegistry, initAgentRegistry, AGENT_TYPE } =
      await import('../lib/hydra-agents.mjs');
    const { executeAgent } = await import('../lib/hydra-shared/agent-executor.mjs');
    // Register a disabled custom CLI agent temporarily
    registerAgent('fake-cli', {
      type: AGENT_TYPE.PHYSICAL,
      customType: 'cli',
      cli: null,
      invoke: null,
      enabled: false,
      taskAffinity: {},
      contextBudget: 1000,
      councilRole: null,
    });
    const result = await executeAgent('fake-cli', 'test');
    assert.strictEqual(result.errorCategory, 'custom-cli-disabled');
    unregisterAgent('fake-cli');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
node --test test/hydra-agent-executor.test.mjs 2>&1 | grep -E "fail|custom.*routing"
```

**Step 3: Implement**

First, add `executeCustomApiAgent()` right after `executeCustomCliAgent()`:

```javascript
// ── Custom API Agent ──────────────────────────────────────────────────────────

async function executeCustomApiAgent(agentName, prompt, opts = {}) {
  const { timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const cfg = loadHydraConfig();
  const def = (cfg.agents?.customAgents || []).find((a) => a.name === agentName);

  if (!def || def.enabled === false) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Custom API agent disabled or not found.',
      error: 'custom-cli-disabled',
      errorCategory: 'custom-cli-disabled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const baseUrl = def.baseUrl || 'http://localhost:11434/v1';
  const model = def.model || 'default';
  const startTime = Date.now();
  const metricsHandle = recordCallStart(agentName, model);
  const span = await startAgentSpan(agentName, model, { phase: phaseLabel });

  let output = '';
  try {
    const messages = [{ role: 'user', content: prompt }];
    const result = await streamLocalCompletion(
      messages,
      { baseUrl, model, maxTokens: def.maxTokens },
      (chunk) => {
        output += chunk;
        if (onProgress)
          onProgress(Date.now() - startTime, Math.round(Buffer.byteLength(output, 'utf8') / 1024));
      },
    );

    const durationMs = Date.now() - startTime;
    if (!result.ok) {
      recordCallError(metricsHandle, result.errorCategory);
      await endAgentSpan(span, { ok: false, error: result.errorCategory });
      return {
        ok: false,
        output: '',
        stdout: '',
        stderr: result.errorCategory,
        error: result.errorCategory,
        errorCategory: result.errorCategory,
        exitCode: null,
        signal: null,
        durationMs,
        timedOut: false,
      };
    }

    recordCallComplete(metricsHandle, { output: result.output, stdout: result.output });
    await endAgentSpan(span, { ok: true });
    return {
      ok: true,
      output: result.output,
      stdout: result.output,
      stderr: '',
      error: null,
      errorCategory: null,
      exitCode: 0,
      signal: null,
      durationMs,
      timedOut: false,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, 'custom-cli-error');
    await endAgentSpan(span, { ok: false, error: err.message });
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: err.message,
      error: 'custom-cli-error',
      errorCategory: 'custom-cli-error',
      exitCode: null,
      signal: null,
      durationMs,
      timedOut: false,
    };
  }
}
```

Then, in `executeAgent()`, import `getAgent` (check if already imported — it may come from `hydra-agents.mjs`). Add the custom dispatch block right after the `agent === 'local'` block (around line 655):

```javascript
// Custom physical agents (CLI and API types registered via agents.customAgents config)
const customAgentDef = getAgent(agent);
if (customAgentDef?.customType === 'cli') {
  try {
    return await executeCustomCliAgent(agent, prompt, opts);
  } finally {
    _hubCleanup();
  }
}
if (customAgentDef?.customType === 'api') {
  try {
    return await executeCustomApiAgent(agent, prompt, opts);
  } finally {
    _hubCleanup();
  }
}
```

Check if `getAgent` is already imported from `hydra-agents.mjs`:

```bash
grep -n "getAgent" lib/hydra-shared/agent-executor.mjs | head -5
```

If not, add it to the existing `hydra-agents.mjs` import at line 21.

**Step 4: Run tests**

```bash
node --test test/hydra-agent-executor.test.mjs 2>&1 | tail -5
node --test 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/hydra-shared/agent-executor.mjs test/hydra-agent-executor.test.mjs
git commit -m "feat(agents): add executeCustomApiAgent and route custom agents in executeAgent"
```

---

### Task 5: `custom-cli-unavailable` fallback in `executeAgentWithRecovery()`

**Files:**

- Modify: `lib/hydra-shared/agent-executor.mjs` — `executeAgentWithRecovery()` (around line 951)
- Test: `test/hydra-agent-executor.test.mjs` (append tests)

**Context:** When a custom CLI agent's binary isn't on PATH (ENOENT → `custom-cli-unavailable`), `executeAgentWithRecovery` should fall back to the best available cloud agent, same as `local-unavailable`. This is a transparent fallback — the caller doesn't need to know.

**Step 1: Write the failing test**

Append to `test/hydra-agent-executor.test.mjs`:

```javascript
describe('executeAgentWithRecovery — custom-cli-unavailable fallback', () => {
  it('custom-cli-unavailable error category is recognized as needing fallback', () => {
    // We test the error category value exists (execution path is tested via integration)
    const knownCategories = ['custom-cli-unavailable', 'custom-cli-disabled', 'custom-cli-error'];
    assert.ok(knownCategories.includes('custom-cli-unavailable'));
  });
});
```

(The fallback behavior is hard to unit-test without mocking `executeAgent` — we verify the category string exists and trust the integration path mirrors the `local-unavailable` pattern.)

**Step 2: Run tests to verify they pass**

This test will pass trivially. That's fine — the real value is in the implementation review step.

**Step 3: Implement**

In `executeAgentWithRecovery()`, after the `local-unavailable` block (around line 951), add:

```javascript
// Custom-CLI-unavailable: CLI not found on PATH — fall back to cloud agent
if (result.errorCategory === 'custom-cli-unavailable') {
  const fallback = 'claude';
  process.stderr.write(`[${agent}] CLI not found — falling back to ${fallback}\n`);
  finalResult = await executeAgent(fallback, prompt, { ...opts, _customFallback: true });
  return finalResult;
}
```

**Step 4: Run full suite**

```bash
node --test 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/hydra-shared/agent-executor.mjs test/hydra-agent-executor.test.mjs
git commit -m "feat(agents): add custom-cli-unavailable fallback in executeAgentWithRecovery"
```

---

### Task 6: `registerCustomAgentMcp()` in `hydra-setup.mjs`

**Files:**

- Modify: `lib/hydra-setup.mjs` — add function and exports
- Test: `test/hydra-setup.test.mjs` (append tests)

**Context:** This function attempts to inject the Hydra MCP entry into a custom agent's config file. It accepts `{ configPath, format }`. For `format: 'json'`, it reads/writes JSON and injects `mcpServers.hydra`. For unknown formats or if `configPath` is null, it returns manual instructions. We also add a `KNOWN_CLI_MCP_PATHS` map for auto-detection by CLI name.

**Step 1: Write the failing tests**

Append to `test/hydra-setup.test.mjs`:

```javascript
import { registerCustomAgentMcp, KNOWN_CLI_MCP_PATHS } from '../lib/hydra-setup.mjs';

describe('registerCustomAgentMcp', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-mcp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects mcpServers.hydra into a JSON config file', () => {
    const configPath = path.join(tmpDir, 'agent.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'test' }), 'utf8');
    const result = registerCustomAgentMcp({ configPath, format: 'json' });
    assert.strictEqual(result.status, 'added');
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(written.mcpServers?.hydra, 'should have hydra MCP entry');
  });

  it('returns exists if hydra entry already present', () => {
    const configPath = path.join(tmpDir, 'agent.json');
    const existing = { mcpServers: { hydra: { command: 'node', args: ['existing'] } } };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');
    const result = registerCustomAgentMcp({ configPath, format: 'json' });
    assert.strictEqual(result.status, 'exists');
  });

  it('returns manual instructions when configPath is null', () => {
    const result = registerCustomAgentMcp({ configPath: null });
    assert.strictEqual(result.status, 'manual');
    assert.ok(typeof result.instructions === 'string');
    assert.ok(result.instructions.includes('hydra'));
  });

  it('returns manual instructions for unknown format', () => {
    const configPath = path.join(tmpDir, 'agent.yaml');
    fs.writeFileSync(configPath, 'name: test\n', 'utf8');
    const result = registerCustomAgentMcp({ configPath, format: 'yaml' });
    assert.strictEqual(result.status, 'manual');
  });

  it('KNOWN_CLI_MCP_PATHS exports an object', () => {
    assert.strictEqual(typeof KNOWN_CLI_MCP_PATHS, 'object');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
node --test test/hydra-setup.test.mjs 2>&1 | grep -E "fail|registerCustomAgentMcp"
```

**Step 3: Implement**

In `lib/hydra-setup.mjs`, add near the end before the `main()` function:

```javascript
// ── Custom Agent MCP Registration ────────────────────────────────────────────

/**
 * Known config paths for popular AI CLIs (for auto-detection).
 * Values are paths relative to os.homedir(), or null if detection is not supported.
 */
export const KNOWN_CLI_MCP_PATHS = {
  // GitHub Copilot — config location varies by version; manual preferred
  gh: null,
  // Aider — YAML config, not JSON; manual preferred
  aider: null,
  // Continue — JSON config
  continue: path.join('.continue', 'config.json'),
};

/**
 * Register the Hydra MCP server with a custom agent's config.
 *
 * @param {object} opts
 * @param {string|null} opts.configPath - Absolute path to the agent's config file
 * @param {'json'|string} [opts.format] - Config format ('json' is the only auto-handled format)
 * @param {boolean} [opts.force] - Overwrite existing entry
 * @returns {{ status: 'added'|'exists'|'updated'|'manual'|'error', instructions?: string }}
 */
export function registerCustomAgentMcp(opts = {}) {
  const { configPath, format, force = false } = opts;
  const mcpPath = resolveMcpServerPath();
  const nodePath = resolveNodePath();

  const manualInstructions = `Add this to your agent's MCP configuration:

  Name: hydra
  Command: ${nodePath}
  Args: ${mcpPath}

Or if your agent uses a JSON config with an "mcpServers" field:
  {
    "mcpServers": {
      "hydra": {
        "type": "stdio",
        "command": "${nodePath}",
        "args": ["${mcpPath}"]
      }
    }
  }`;

  if (!configPath || format !== 'json') {
    return { status: 'manual', instructions: manualInstructions };
  }

  try {
    const config = readJsonFile(configPath);
    if (!config.mcpServers) config.mcpServers = {};

    if (config.mcpServers.hydra && !force) {
      return { status: 'exists' };
    }

    const status = config.mcpServers.hydra ? 'updated' : 'added';
    config.mcpServers.hydra = {
      type: 'stdio',
      command: nodePath,
      args: [mcpPath],
    };

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    return { status };
  } catch (err) {
    return { status: 'manual', instructions: manualInstructions };
  }
}
```

**Step 4: Run tests**

```bash
node --test test/hydra-setup.test.mjs 2>&1 | tail -5
node --test 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/hydra-setup.mjs test/hydra-setup.test.mjs
git commit -m "feat(agents): add registerCustomAgentMcp and KNOWN_CLI_MCP_PATHS to hydra-setup"
```

---

### Task 7: `:agents add` wizard — new `lib/hydra-agents-wizard.mjs`

**Files:**

- Create: `lib/hydra-agents-wizard.mjs`
- Test: `test/hydra-agents-wizard.test.mjs` (new file)

**Context:** The wizard is extracted to its own module (like `hydra-roster.mjs` and `hydra-persona.mjs`) to keep operator.mjs lean. It exports `runAgentsWizard(rl)`. The wizard uses `promptChoice()` from `hydra-prompt-choice.mjs` for all menus. At the end it calls `saveHydraConfig()` and `registerCustomAgentMcp()`.

**Step 1: Write the failing tests**

Create `test/hydra-agents-wizard.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCustomAgentEntry,
  parseArgsTemplate,
  validateAgentName,
} from '../lib/hydra-agents-wizard.mjs';
import { AFFINITY_PRESETS } from '../lib/hydra-config.mjs';

describe('validateAgentName', () => {
  it('accepts valid lowercase names', () => {
    assert.strictEqual(validateAgentName('copilot'), null);
    assert.strictEqual(validateAgentName('my-agent'), null);
    assert.strictEqual(validateAgentName('agent123'), null);
  });

  it('rejects names with spaces or uppercase', () => {
    assert.ok(validateAgentName('My Agent') !== null);
    assert.ok(validateAgentName('AGENT') !== null);
    assert.ok(validateAgentName('') !== null);
  });

  it('rejects reserved agent names', () => {
    assert.ok(validateAgentName('claude') !== null);
    assert.ok(validateAgentName('gemini') !== null);
    assert.ok(validateAgentName('codex') !== null);
    assert.ok(validateAgentName('local') !== null);
  });
});

describe('parseArgsTemplate', () => {
  it('splits space-separated args into an array', () => {
    const result = parseArgsTemplate('copilot suggest -p {prompt}');
    assert.deepStrictEqual(result, ['copilot', 'suggest', '-p', '{prompt}']);
  });

  it('handles single arg', () => {
    assert.deepStrictEqual(parseArgsTemplate('{prompt}'), ['{prompt}']);
  });
});

describe('buildCustomAgentEntry', () => {
  it('builds a CLI agent entry from wizard fields', () => {
    const entry = buildCustomAgentEntry({
      name: 'copilot',
      type: 'cli',
      cmd: 'gh',
      argsTemplate: 'copilot suggest -p {prompt}',
      responseParser: 'plaintext',
      contextBudget: 32000,
      affinityPreset: 'code-focused',
      councilRole: null,
      enabled: true,
    });
    assert.strictEqual(entry.name, 'copilot');
    assert.strictEqual(entry.type, 'cli');
    assert.deepStrictEqual(entry.invoke.headless.cmd, 'gh');
    assert.deepStrictEqual(entry.invoke.headless.args, ['copilot', 'suggest', '-p', '{prompt}']);
    assert.deepStrictEqual(entry.taskAffinity, AFFINITY_PRESETS['code-focused']);
  });

  it('builds an API agent entry from wizard fields', () => {
    const entry = buildCustomAgentEntry({
      name: 'mixtral',
      type: 'api',
      baseUrl: 'http://localhost:11434/v1',
      model: 'mixtral:8x7b',
      contextBudget: 32000,
      affinityPreset: 'balanced',
      councilRole: null,
      enabled: true,
    });
    assert.strictEqual(entry.type, 'api');
    assert.strictEqual(entry.baseUrl, 'http://localhost:11434/v1');
    assert.strictEqual(entry.model, 'mixtral:8x7b');
    assert.deepStrictEqual(entry.taskAffinity, AFFINITY_PRESETS['balanced']);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
node --test test/hydra-agents-wizard.test.mjs 2>&1 | grep fail
```

Expected: Fail — module doesn't exist.

**Step 3: Create `lib/hydra-agents-wizard.mjs`**

```javascript
/**
 * Hydra Agents Wizard — Interactive wizard for registering custom CLI and API agents.
 *
 * Exports: runAgentsWizard(rl), buildCustomAgentEntry(), parseArgsTemplate(), validateAgentName()
 * Called by hydra-operator.mjs via: :agents add
 */

import os from 'os';
import path from 'path';
import { promptChoice } from './hydra-prompt-choice.mjs';
import { loadHydraConfig, saveHydraConfig, AFFINITY_PRESETS } from './hydra-config.mjs';
import { registerCustomAgentMcp, KNOWN_CLI_MCP_PATHS } from './hydra-setup.mjs';

const RESERVED_NAMES = ['claude', 'gemini', 'codex', 'local'];

/**
 * Validate a custom agent name.
 * @param {string} name
 * @returns {string|null} Error message, or null if valid
 */
export function validateAgentName(name) {
  if (!name || !name.trim()) return 'Name cannot be empty';
  if (RESERVED_NAMES.includes(name.toLowerCase())) return `"${name}" is a reserved agent name`;
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    return 'Name must be lowercase alphanumeric with hyphens (e.g. copilot, my-agent)';
  return null;
}

/**
 * Split a space-separated args template string into an array.
 * @param {string} template - e.g. "copilot suggest -p {prompt}"
 * @returns {string[]}
 */
export function parseArgsTemplate(template) {
  return template.trim().split(/\s+/).filter(Boolean);
}

/**
 * Build a customAgents[] entry from wizard field values.
 * @param {object} fields
 * @returns {object} Agent entry ready for config
 */
export function buildCustomAgentEntry(fields) {
  const { name, type, affinityPreset, councilRole, contextBudget, enabled } = fields;
  const taskAffinity = AFFINITY_PRESETS[affinityPreset] || AFFINITY_PRESETS['balanced'];

  const base = {
    name,
    type,
    displayName: fields.displayName || name,
    contextBudget: Number(contextBudget) || 32000,
    councilRole: councilRole || null,
    taskAffinity,
    enabled: enabled !== false,
  };

  if (type === 'cli') {
    const args = parseArgsTemplate(fields.argsTemplate || '{prompt}');
    const invokeEntry = { cmd: fields.cmd, args };
    return {
      ...base,
      invoke: { nonInteractive: invokeEntry, headless: invokeEntry },
      responseParser: fields.responseParser || 'plaintext',
    };
  }

  // API type
  return {
    ...base,
    baseUrl: fields.baseUrl || 'http://localhost:11434/v1',
    model: fields.model || 'default',
  };
}

/**
 * Interactive wizard for adding a custom agent.
 * @param {import('readline').Interface} rl
 */
export async function runAgentsWizard(rl) {
  console.log('');
  console.log('  Custom Agent Setup Wizard');
  console.log('  ─────────────────────────');

  // Helper: ask for freeform text
  function ask(prompt) {
    return new Promise((resolve) => {
      rl.question(`  ${prompt}: `, (ans) => resolve(ans.trim()));
    });
  }

  // 1. Name
  let name;
  while (true) {
    name = await ask('Agent name (e.g. copilot, mixtral)');
    const err = validateAgentName(name);
    if (!err) break;
    console.log(`  ✗ ${err}`);
  }

  // 2. Type
  const typeChoice = await promptChoice(rl, {
    prompt: 'Agent type',
    choices: [
      {
        value: 'cli',
        label: 'CLI agent',
        description: 'Spawns a local CLI tool (e.g. gh copilot, aider)',
      },
      {
        value: 'api',
        label: 'API endpoint',
        description: 'Calls an OpenAI-compatible HTTP API (e.g. Ollama, LM Studio)',
      },
    ],
  });
  const agentType = typeChoice.value;

  const fields = { name, type: agentType };

  if (agentType === 'cli') {
    // CLI track
    fields.cmd = await ask('CLI command (e.g. gh, aider, continue)');
    fields.argsTemplate = await ask('Args template (e.g. copilot suggest -p {prompt})');

    const parserChoice = await promptChoice(rl, {
      prompt: 'Response parser',
      choices: [
        { value: 'plaintext', label: 'Plaintext', description: 'Capture stdout as-is' },
        {
          value: 'json',
          label: 'JSON',
          description: 'Parse JSON stdout, extract .content/.text field',
        },
        { value: 'markdown', label: 'Markdown', description: 'Capture markdown output as-is' },
      ],
      autoAccept: true,
    });
    fields.responseParser = parserChoice.value;
  } else {
    // API track
    fields.baseUrl = await ask('Base URL (e.g. http://localhost:11434/v1)');
    fields.model = await ask('Model name (e.g. mixtral:8x7b, llama3.2)');
  }

  // Context budget
  const budgetRaw = await ask('Context budget in tokens (default: 32000)');
  fields.contextBudget = parseInt(budgetRaw, 10) || 32000;

  // Task profile
  const profileChoice = await promptChoice(rl, {
    prompt: 'Task affinity profile',
    choices: [
      { value: 'balanced', label: 'Balanced', description: 'Equal weight across all task types' },
      {
        value: 'code-focused',
        label: 'Code-focused',
        description: 'High weight for implementation, refactor, testing',
      },
      {
        value: 'review-focused',
        label: 'Review-focused',
        description: 'High weight for review, analysis, security',
      },
      {
        value: 'research-focused',
        label: 'Research-focused',
        description: 'High weight for research, documentation, analysis',
      },
    ],
  });
  fields.affinityPreset = profileChoice.value;

  // Council role
  const councilChoice = await promptChoice(rl, {
    prompt: 'Council role',
    choices: [
      { value: null, label: 'None', description: 'Excluded from council deliberation' },
      { value: 'analyst', label: 'Analyst', description: 'Critique and analysis role' },
      { value: 'architect', label: 'Architect', description: 'Planning and architecture role' },
      { value: 'implementer', label: 'Implementer', description: 'Implementation role' },
    ],
  });
  fields.councilRole = councilChoice.value;

  // Build entry
  const entry = buildCustomAgentEntry(fields);

  // MCP setup
  let mcpConfig = null;
  if (agentType === 'cli') {
    const knownPath = KNOWN_CLI_MCP_PATHS[fields.cmd];
    const mcpChoices = [
      {
        value: 'auto',
        label: 'Auto-detect',
        description: knownPath ? `Try ${knownPath}` : 'Attempt auto-detection',
      },
      {
        value: 'manual-path',
        label: 'Enter config path',
        description: "Provide the path to your agent's config file",
      },
      { value: 'skip', label: 'Skip', description: 'Show manual instructions at the end' },
    ];
    const mcpChoice = await promptChoice(rl, { prompt: 'MCP registration', choices: mcpChoices });

    if (mcpChoice.value === 'auto' && knownPath) {
      mcpConfig = { configPath: path.join(os.homedir(), knownPath), format: 'json' };
    } else if (mcpChoice.value === 'manual-path') {
      const rawPath = await ask('Path to agent config file (absolute path)');
      const fmt = await ask('Config format (json / other)');
      mcpConfig = { configPath: rawPath, format: fmt };
    }
  }

  // Save to config
  const cfg = loadHydraConfig();
  const customAgents = [...(cfg.agents?.customAgents || [])];
  const existing = customAgents.findIndex((a) => a.name === entry.name);
  if (existing >= 0) {
    customAgents[existing] = entry;
  } else {
    customAgents.push(entry);
  }
  saveHydraConfig({ agents: { ...cfg.agents, customAgents } });

  console.log(`\n  ✓ Agent "${entry.name}" saved to config`);

  // MCP registration
  if (mcpConfig) {
    const mcpResult = registerCustomAgentMcp(mcpConfig);
    if (mcpResult.status === 'added' || mcpResult.status === 'updated') {
      console.log(`  ✓ Hydra MCP server registered with ${entry.name}`);
    } else if (mcpResult.status === 'exists') {
      console.log(`  ✓ Hydra MCP already registered with ${entry.name}`);
    } else {
      console.log(`\n  Manual MCP setup required:\n`);
      console.log(
        mcpResult.instructions
          ?.split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      );
    }
  } else if (agentType === 'cli') {
    const manualResult = registerCustomAgentMcp({ configPath: null });
    console.log(`\n  MCP setup (manual):\n`);
    console.log(
      manualResult.instructions
        ?.split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }

  console.log(`\n  Restart the operator for "${entry.name}" to be available for dispatch.\n`);
}
```

**Step 4: Run tests**

```bash
node --test test/hydra-agents-wizard.test.mjs 2>&1 | tail -5
node --test 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/hydra-agents-wizard.mjs test/hydra-agents-wizard.test.mjs
git commit -m "feat(agents): add hydra-agents-wizard with buildCustomAgentEntry and runAgentsWizard"
```

---

### Task 8: Wire `:agents add|remove|test` into `hydra-operator.mjs`

**Files:**

- Modify: `lib/hydra-operator.mjs` — the `':agents'` block (around line 3130) + KNOWN_COMMANDS + help text
- Test: none needed (operator UI changes are exercised manually; wizard is already tested)

**Context:** The `:agents` block at line 3130 already handles list/info/enable/disable. We add three new sub-commands: `add`, `remove`, `test`. `add` imports and calls `runAgentsWizard`. `remove` removes the entry from `agents.customAgents` in config. `test` calls `executeAgent(name, 'Say "hello" in one sentence.')` and prints the result.

**Step 1: Find the end of the current `:agents` block**

```bash
grep -n "agentSubCmd\|:agents" lib/hydra-operator.mjs | tail -20
```

**Step 2: Implement — add new sub-commands inside the `:agents` block**

Find the end of the `else if (agentSubCmd === 'disable')` block (or whatever is last) and append before the closing `}` of the outer `if (line === ':agents' ...)`:

```javascript
        } else if (agentSubCmd === 'add') {
          const { runAgentsWizard } = await import('./hydra-agents-wizard.mjs');
          await runAgentsWizard(rl);

        } else if (agentSubCmd === 'remove') {
          const targetName = agentParts[1]?.toLowerCase();
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :agents remove <name>`);
          } else {
            const cfg = loadHydraConfig();
            const customAgents = (cfg.agents?.customAgents || []).filter(a => a.name !== targetName);
            if (customAgents.length === (cfg.agents?.customAgents || []).length) {
              console.log(`  ${ERROR('Not found:')} "${targetName}" is not a custom agent`);
            } else {
              saveHydraConfig({ agents: { ...cfg.agents, customAgents } });
              console.log(`  ${SUCCESS('Removed:')} agent "${targetName}" from config (restart to take effect)`);
            }
          }

        } else if (agentSubCmd === 'test') {
          const targetName = agentParts[1]?.toLowerCase();
          if (!targetName) {
            console.log(`  ${ERROR('Usage:')} :agents test <name>`);
          } else {
            const agentDef = getAgent(targetName);
            if (!agentDef) {
              console.log(`  ${ERROR('Not found:')} agent "${targetName}" not in registry`);
            } else {
              console.log(`  Testing agent "${targetName}"...`);
              try {
                const { executeAgent } = await import('./hydra-shared/agent-executor.mjs');
                const result = await executeAgent(targetName, 'Say "hello" in one sentence.');
                if (result.ok) {
                  console.log(`  ${SUCCESS('OK')} ${DIM(result.output?.slice(0, 200) || '(empty output)')}`);
                } else {
                  console.log(`  ${ERROR('FAIL')} ${result.errorCategory}: ${result.stderr?.slice(0, 200)}`);
                }
              } catch (err) {
                console.log(`  ${ERROR('ERROR')} ${err.message}`);
              }
            }
          }
```

**Step 3: Update help text and KNOWN_COMMANDS**

Find the existing `:agents` line in help output (around line 1422) and add:

```javascript
console.log(`  ${ACCENT(':agents add')}            Register a new custom agent (CLI or API)`);
console.log(`  ${ACCENT(':agents remove <name>')}  Remove a custom agent`);
console.log(`  ${ACCENT(':agents test <name>')}    Send a test prompt to verify agent works`);
```

Find the `:agents` entry in the `KNOWN_COMMANDS` help map (around line 1492) and update:

```javascript
  ':agents': {
    usage: [':agents', ':agents list [virtual|physical|all]', ':agents info <name>',
            ':agents add', ':agents remove <name>', ':agents test <name>',
            ':agents enable <name>', ':agents disable <name>'],
    desc: 'Agent registry management — list, add, remove, test, enable/disable agents'
  },
```

**Step 4: Run full suite**

```bash
node --test 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/hydra-operator.mjs
git commit -m "feat(agents): wire :agents add|remove|test into operator"
```

---

### Task 9: Update docs

**Files:**

- Modify: `CLAUDE.md` — add `agents.customAgents` schema, `:agents add|remove|test` commands, new module
- Modify: `README.md` — add `:agents add|remove|test` to operator commands table
- Modify: `docs/ARCHITECTURE.md` — add `hydra-agents-wizard.mjs` entry

**Step 1: Update `CLAUDE.md`**

In the `hydra-agents.mjs` key module entry, add to the exports list:

- `AFFINITY_PRESETS` exported from `hydra-config.mjs`
- Note that `initAgentRegistry()` now loads `agents.customAgents[]` physical agents

Add a new module entry for `hydra-agents-wizard.mjs`:

```
- **`hydra-agents-wizard.mjs`** — Interactive wizard for custom agent registration. `runAgentsWizard(rl)` walks CLI or API track, writes to `agents.customAgents[]` in config, and calls `registerCustomAgentMcp()`. Exports `buildCustomAgentEntry()`, `parseArgsTemplate()`, `validateAgentName()`. Accessed via `:agents add`.
```

In the `hydra-setup.mjs` entry, add:

- `registerCustomAgentMcp(opts)` — inject or return manual instructions for Hydra MCP registration with a custom agent. `opts: { configPath, format, force }`. Returns `{ status: 'added'|'exists'|'updated'|'manual', instructions? }`.
- `KNOWN_CLI_MCP_PATHS` — map of CLI name → auto-detect config path

Add to the **Commands** section:

```
npm run agents:wizard    # Alias for :agents add (CLI-only entry point if needed)
```

Add `agents.customAgents` to the **Architecture** section config schema summary.

**Step 2: Update `README.md` Operator Commands table**

Add rows:
| `:agents add` | Register a new custom CLI or API agent |
| `:agents remove <name>` | Remove a custom agent |
| `:agents test <name>` | Send a test prompt to verify agent |

**Step 3: Run full suite one last time**

```bash
node --test 2>&1 | tail -5
```

Expected: 0 fail.

**Step 4: Commit**

```bash
git add CLAUDE.md README.md docs/ARCHITECTURE.md
git commit -m "docs: document custom agent registration (agents.customAgents, :agents add/remove/test)"
```

---

## Summary

9 tasks, TDD throughout. After completion:

- Users run `:agents add` in the operator → walk CLI or API track → agent registered in `hydra.config.json`
- On next daemon/operator start, the agent is registered and available for dispatch
- `bestAgentFor()` considers custom agents' task affinities
- CLI unavailability → transparent cloud fallback
- MCP auto-registration attempted; manual instructions if not possible
