# Copilot Dispatch Setup Guide

This guide documents how to configure Hydra's dynamic dispatch pipeline to use the
GitHub Copilot CLI as the sole agent, with different models assigned to each dispatch role.
It also covers the issues encountered during testing and how each was resolved.

---

## Background

Hydra's dispatch pipeline runs three roles in sequence:

| Role          | Default agent | Purpose                                              |
| ------------- | ------------- | ---------------------------------------------------- |
| `coordinator` | `claude`      | Decomposes the task and creates a delegation plan    |
| `critic`      | `gemini`      | Reviews and improves the coordinator's plan          |
| `synthesizer` | `codex`       | Executes the final synthesis and produces the result |

With the dynamic dispatch architecture added in PR #15, each role can be pointed at any
registered agent — including `copilot` — and a specific model can be assigned per role.
This allows Copilot's three flagship models to serve the three roles concurrently.

---

## Target Configuration

Run all three roles through the Copilot CLI with different models:

| Role          | Agent     | Model                          | Copilot CLI flag               |
| ------------- | --------- | ------------------------------ | ------------------------------ |
| `coordinator` | `copilot` | `copilot-claude-sonnet-4-6`    | `--model claude-sonnet-4.6`    |
| `critic`      | `copilot` | `copilot-gemini-3-pro-preview` | `--model gemini-3-pro-preview` |
| `synthesizer` | `copilot` | `copilot-gpt-5-4`              | `--model gpt-5.4`              |

---

## Step-by-Step Configuration

### 1. Enable the copilot agent

Copilot is **disabled by default** to avoid routing failures when the CLI is not installed.
Add the `copilot` section to `hydra.config.json`:

```json
{
  "copilot": {
    "enabled": true
  }
}
```

Without this, `bestAgentFor()` and `getRoleAgent()` will never select the copilot agent
regardless of what the `roles` section says.

### 2. Assign roles to copilot with model overrides

In the `roles` section of `hydra.config.json`, set `coordinator`, `critic`, and
`synthesizer` to use the `copilot` agent with distinct model IDs:

```json
{
  "roles": {
    "coordinator": {
      "agent": "copilot",
      "model": "copilot-claude-sonnet-4-6",
      "reasoningEffort": null
    },
    "critic": {
      "agent": "copilot",
      "model": "copilot-gemini-3-pro-preview",
      "reasoningEffort": null
    },
    "synthesizer": {
      "agent": "copilot",
      "model": "copilot-gpt-5-4",
      "reasoningEffort": null
    }
  }
}
```

**Important:** Use Hydra's internal model ID format (e.g., `copilot-gpt-5-4`), not the raw
CLI flag value. Hydra's `resolveCliModelId()` maps these to the bare strings the CLI expects:

| Hydra model ID                 | `copilot --model` value |
| ------------------------------ | ----------------------- |
| `copilot-claude-sonnet-4-6`    | `claude-sonnet-4.6`     |
| `copilot-claude-opus-4-6`      | `claude-opus-4.6`       |
| `copilot-gemini-3-pro-preview` | `gemini-3-pro-preview`  |
| `copilot-gpt-5-4`              | `gpt-5.4`               |

### 3. Verify the copilot CLI is installed

```bash
which copilot
copilot --version
```

If not installed, run `npm run setup` which attempts to register the Copilot MCP server
and will report if the binary is missing.

### 4. Preview the dispatch plan (dry run)

Before running live, use preview mode to confirm role resolution is correct:

```
:dispatch preview <your prompt>
```

Expected output for the three-role copilot configuration:

```
roleAgents: { coordinator: copilot, critic: copilot, synthesizer: copilot }
coordinator → copilot  --model claude-sonnet-4.6
critic      → copilot  --model gemini-3-pro-preview
synthesizer → copilot  --model gpt-5.4
```

If any role shows a different agent, check step 1 (enabled) and step 2 (roles).

---

## Issues Encountered and Resolutions

### Issue 1: Copilot routes not selected despite roles config

**Symptom:** Preview showed `claude`, `gemini`, `codex` agents even after setting
`roles.coordinator.agent = "copilot"` etc.

**Root cause:** `copilot.enabled` was `false` (the hardcoded default in `PHYSICAL_AGENTS`).
`getRoleAgent()` validates that the role's configured agent is both registered _and_ enabled.
If the agent is disabled it falls back to the preference order (`claude → copilot → gemini →
codex → local`), which then selects `claude` as the first enabled agent.

**Fix:** Add `"copilot": { "enabled": true }` to `hydra.config.json`. This is now read
dynamically by `_resolveEnabled()` on every `getAgent()` / `listAgents()` call, so no
daemon restart is required after editing the config file.

---

### Issue 2: Model not passed to the copilot CLI

**Symptom:** Preview correctly showed the copilot agent for each role, but the live run
executed `copilot -p <prompt>` without any `--model` flag, causing copilot to use its
own default model for all three roles.

**Root cause:** `callAgent()` in `hydra-dispatch.ts` accepted only `(agent, prompt, timeout)`
— the `model` field from `getRoleConfig()` was resolved but never forwarded to
`executeAgent()`.

**Fix:** Added an optional `model` parameter to `callAgent()`:

```ts
async function callAgent(
  agentName: string,
  prompt: string,
  timeoutMs: number,
  model?: string | null,
);
```

And resolved each role's model before dispatch:

```ts
const coordinatorModel = getRoleConfig('coordinator')?.model ?? null;
const criticModel = getRoleConfig('critic')?.model ?? null;
const synthesizerModel = getRoleConfig('synthesizer')?.model ?? null;
```

These are now forwarded as `modelOverride` to `executeAgent()`, which calls
`resolveCliModelId(model)` and appends `--model <value>` to the CLI invocation.

---

### Issue 3: Critic (and synthesizer) fail with `spawn E2BIG` after coordinator succeeds

**Symptom:** Coordinator completed in ~58 seconds, then critic failed immediately with
`Error: spawnSync ... E2BIG`. Synthesizer was never reached.

**Root cause:** The copilot CLI outputs raw streaming JSONL to stdout — approximately
1,000+ lines including `assistant.message_delta` events, tool-call payloads, and reasoning
deltas. A 1-minute copilot run produces **~260–490 KB of raw stdout**. When
`hydra-dispatch.ts` used `coordResult.stdout` (raw JSONL) instead of `coordResult.output`
(the parsed text response, ~6–9 KB) to build the critic prompt, the critic received the
entire JSONL blob as part of its prompt argument. Linux's per-argument string limit
(`MAX_ARG_STRLEN = 131,072 bytes`, not the total `ARG_MAX = 2 MB`) caused `E2BIG` at
spawn time.

**Key distinction — `stdout` vs `output` in `ExecuteResult`:**

| Field    | Contents                                                     | Typical size |
| -------- | ------------------------------------------------------------ | ------------ |
| `stdout` | Raw process stdout — always the full unmodified output       | 260–490 KB   |
| `output` | Result of `parseOutput()` — extracted semantic response text | 3–9 KB       |

The copilot agent's `parseOutput` function scans the JSONL for `assistant.message` events
with no tool requests (i.e., the final answer) and returns that text. It only runs when
`features.jsonOutput = true`, which is set for the copilot agent.

**Fix applied in PR #15:** Changed `hydra-dispatch.ts` to use `coordResult.output` (not
`coordResult.stdout`) when building the critic and synthesizer prompts:

```ts
// Before (broken):
const criticPromptText = buildCriticPrompt(criticAgent, prompt, coordParsed ?? coordResult.stdout, ...);

// After (fixed):
const criticPromptText = buildCriticPrompt(criticAgent, prompt, coordParsed ?? coordResult.output, ...);
```

Same fix applied for the synthesizer prompt using `criticResult.output`.

**Verified prompt sizes after fix (successful run `HYDRA_RUN_20260311_214334`):**

| Stage       | Prompt size | Output size | Raw stdout |
| ----------- | ----------- | ----------- | ---------- |
| Coordinator | 3,198 B     | 6,275 B     | 261,811 B  |
| Critic      | 8,961 B     | 3,016 B     | 490,198 B  |
| Synthesizer | 11,928 B    | —           | —          |

All three stages completed successfully. Total wall-clock time: ~7.5 minutes.

**Required credentials for all agents:**

| Agent     | Required credential                                                            |
| --------- | ------------------------------------------------------------------------------ |
| `gemini`  | `~/.gemini/oauth_creds.json` (run `gemini` once interactively to authenticate) |
| `codex`   | `OPENAI_API_KEY` environment variable                                          |
| `claude`  | `~/.claude/credentials` (run `claude` once interactively to authenticate)      |
| `copilot` | Active GitHub Copilot subscription + `copilot auth login` device flow          |

---

### Issue 4: Config changes not reflected without restart

**Symptom:** After editing `hydra.config.json`, the daemon continued using the old agent
assignments.

**Root cause:** `loadHydraConfig()` caches its result on the first call. Prior to PR #15,
`copilot.enabled` was baked into the agent registry at init time (`initAgentRegistry()`),
requiring a full daemon restart to reflect config changes.

**Fix:** The `_resolveEnabled()` function in `hydra-agents.ts` reads the cached config on
every `getAgent()` / `listAgents()` call. When you call `:config reload` in the operator
console (or `invalidateConfigCache()` programmatically), the next agent lookup picks up the
new value. No registry reset or restart needed.

---

### Issue 5: Test isolation for copilot enabled state

**Symptom:** Tests for the copilot agent produced different results depending on whether
`hydra.config.json` had `copilot.enabled: true` or `false` in the developer's environment.

**Root cause:** Tests were calling `initAgentRegistry()` without setting a test config,
so the live config file was read. When a developer had `copilot.enabled: true` locally,
the `enabled: false` assertion in the test would fail.

**Fix:** Tests now use `_setTestConfig` and `invalidateConfigCache` for hermetic isolation:

```ts
beforeEach(() => {
  _setTestConfig({ copilot: { enabled: false } });
});

afterEach(() => {
  invalidateConfigCache();
});
```

A second test verifies the dynamic toggle works:

```ts
it('becomes enabled when copilot.enabled: true is set in config', () => {
  _setTestConfig({ copilot: { enabled: true } });
  assert.equal(getAgent('copilot').enabled, true);
});
```

No `_resetRegistry` or `initAgentRegistry` calls are needed because `_resolveEnabled()`
is called on every access, not baked in at registration time.

---

## Reverting to Default Agents

To switch back to `claude` / `gemini` / `codex`:

```json
{
  "roles": {
    "coordinator": { "agent": "claude", "model": null, "reasoningEffort": null },
    "critic": { "agent": "gemini", "model": null, "reasoningEffort": null },
    "synthesizer": { "agent": "codex", "model": null, "reasoningEffort": null }
  },
  "copilot": {
    "enabled": false
  }
}
```

The `copilot.enabled: false` is the shipped default. You only need it explicitly if you
previously set it to `true`.

---

## Reference

- `lib/hydra-dispatch.ts` — `getRoleAgent()`, `callAgent()`, role model resolution
- `lib/hydra-agents.ts` — `_resolveEnabled()`, `PHYSICAL_AGENTS` copilot definition
- `lib/hydra-model-profiles.ts` — `resolveCliModelId()`, copilot model profiles
- `lib/hydra-config.ts` — `getRoleConfig()`, `_setTestConfig`, `invalidateConfigCache`
- `lib/types.ts` — `CopilotConfig`, `HydraConfig.copilot`
