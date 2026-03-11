## GPT-5.4 review — HEAD cb0995d

I found **5 actionable issues** remaining after the previous fixes. The 3 High issues should be resolved before merging.

---

### 🔴 High — `bestAgentFor()` can route to `local` even when `config.local.enabled` is false

**Files:** `lib/hydra-agents.mjs:657-689`, `lib/hydra-shared/agent-executor.mjs:527-539`

`local` is registered with `enabled: true` in the built-in registry, and `bestAgentFor()` only checks `agent.enabled`. But `executeLocalAgent()` immediately returns `ok: false` when `cfg.local.enabled` is false (which is the default). Since `executeAgentWithRecovery()` has no fallback for `local-disabled`, economy/budget-gate mode can silently fail every dispatch.

**Fix:** Skip `local` in `bestAgentFor()` when config marks it disabled:

```js
if (name === 'local' && !cfg.local?.enabled) continue;
```

Or register `local` with `enabled: cfg.local?.enabled === true` in `initAgentRegistry()`.

---

### 🔴 High — `hydra-audit` uses `nonInteractive()`, but `parseFindings()` still expects a raw JSON array — not Claude/Gemini's JSON envelopes

**Files:** `lib/hydra-agents.mjs:37-49`, `lib/hydra-audit.mjs:444-453`, `lib/hydra-audit.mjs:522-556`

`getAgentCommand()` now delegates to `agentDef.invoke.nonInteractive()`. For Claude, that includes `--output-format json`, producing an envelope (`{ type: "result", result: "..." }`), not a raw array. `parseFindings()` only tries to parse `stdout` as a flat array or bracket-slice, so Claude's wrapped output silently produces **zero findings** even on a valid response.

**Fix:** normalize stdout through the plugin parser before handing it to `parseFindings()`:

```js
function parseFindings(agentResponse, fallbackCategory) {
  const agentDef = getAgent(agentResponse.agent);
  const text = agentDef?.parseOutput
    ? agentDef.parseOutput(agentResponse.stdout || '').output
    : agentResponse.stdout || '';
  // existing parsing logic on `text`...
}
```

---

### 🔴 High — `hydra-audit` crashes for `local` and wizard-created custom CLI agents — their `invoke.nonInteractive` is `null` or an object, not a function

**Files:** `lib/hydra-audit.mjs:444-453`, `lib/hydra-agents.mjs:323-326`

```js
const [cmd, baseArgs] = agentDef.invoke.nonInteractive(prompt, { cwd: projectPath });
```

- Built-in `local` sets `invoke.nonInteractive = null` → `TypeError: null is not a function`
- Custom CLI agents store `invoke.nonInteractive` as `{ cmd, args }` (an object) → same crash

Economy-mode model injection also hard-codes `agent === 'codex' ? '-m' : '--model'`, which breaks arbitrary third-party CLIs.

**Fix:** centralize invocation-building with a shape check:

```js
function buildAuditInvocation(agentDef, prompt, opts = {}) {
  const ni = agentDef.invoke?.nonInteractive;
  if (typeof ni === 'function') return ni(prompt, opts);
  if (ni?.cmd && Array.isArray(ni.args)) {
    return [ni.cmd, expandInvokeArgs(ni.args, { prompt, cwd: opts.cwd || process.cwd() })];
  }
  throw new Error(`Agent "${agentDef.name}" does not support audit dispatch`);
}
```

---

### 🟡 Medium — `codex.parseOutput()` misses `type:"content"` events — successful runs can return raw JSONL instead of model text

**Files:** `lib/hydra-agents.mjs:261-281`

The new Codex plugin parser only accumulates output for `obj.type === 'message'`. The Codex CLI can also emit `type: "content"` events. When it does, `output` stays empty and the fallback returns the raw JSONL blob to callers.

**Fix:** reuse the existing `extractCodexText` / `extractCodexUsage` helpers (they already handle both event types) instead of re-implementing a narrower parser inline:

```js
import { extractCodexText, extractCodexUsage } from './hydra-shared/agent-executor.mjs';

parseOutput(stdout) {
  return {
    output: extractCodexText(stdout),
    tokenUsage: extractCodexUsage(stdout),
    costUsd: null,
  };
},
```

---

### 🟡 Medium — `expandInvokeArgs()` throws on non-string elements in a custom agent's `args` array

**Files:** `lib/hydra-shared/agent-executor.mjs:623-626`

`arg.replace(...)` assumes every element is a string. A hand-edited config with a number or boolean causes `TypeError: arg.replace is not a function` at dispatch time instead of a validation error at registration.

**Fix:** coerce to string (or validate at registration):

```js
export function expandInvokeArgs(args, vars) {
  return args.map((arg) =>
    String(arg).replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match)),
  );
}
```

---

### 🔵 Low — Hub session can leak when an unknown agent name is passed

**Files:** `lib/hydra-shared/agent-executor.mjs:837-847`

Hub registration happens before the `getAgent()` validation. If the agent name is invalid, the function throws before `_hubCleanup()` is reachable, leaving a stale session entry until the next cleanup sweep.

**Fix:** validate the agent before registering with the hub, or wrap the whole body in `try/finally`:

```js
export async function executeAgent(agent, prompt, opts = {}) {
  const agentDef = getAgent(agent);
  if (!agentDef) throw new Error(`Unknown agent: "${agent}"`);

  let _hubSessId = null;
  try {
    if (opts.hubCwd) { _hubSessId = hubRegister({ ... }); }
    // ...
  } finally {
    if (_hubSessId) try { hubDeregister(_hubSessId); } catch {}
  }
}
```

---

The plugin architecture is a good direction and the previous round of fixes addressed the most critical crashes. The 3 High issues above represent behavioral regressions (silent zero-findings in audit, routing to a permanently-disabled local agent, crashes on the new agent types this PR introduces). Worth fixing before merge.
