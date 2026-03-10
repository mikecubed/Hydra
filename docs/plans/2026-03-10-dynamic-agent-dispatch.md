# Dynamic Agent Dispatch

**Status:** Draft — 2026-03-10

**Problem:** `hydra-dispatch.mjs`, `detectInstalledCLIs()`, and `bestAgentFor()` all hardcode
`claude / gemini / codex` by name. Adding Copilot (or any future agent like opencode, aider,
etc.) requires modifying multiple call sites. There is also no translation layer between Hydra's
internal model IDs and the CLI `--model` flag values each agent binary expects.

**Goal:** Make the full dispatch pipeline — role resolution, CLI detection, routing, and model ID
translation — driven by the agent plugin registry and user config. New agents should require
nothing more than a plugin definition and a config entry.

---

## Dependencies

This plan depends on the [TypeScript Migration Plan](./2026-03-10-typescript-migration.md).
Specifically, Phase 7 of the TS migration (Dispatch & Council) should complete before Task A
(Dispatch Role Resolution) is implemented, so the refactored `hydra-dispatch.mjs` is written in
TypeScript from the start. Tasks B–D and Phase 3 of the TS migration (Config & Models) is
sufficient for `resolveCliModelId()` — no need to wait for Phase 7.

Implementing in JS first is a valid fallback if the TS migration stalls, but the discriminated
union `DaemonEvent` type and typed `DispatchReport` interface provide significant value if written
in TS from the start.

---

## Background

### Current hardcoded surface area

| Location                              | Hardcoded agents                                                   | Impact                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `lib/hydra-dispatch.mjs:268,287,307`  | `callAgent('claude')`, `callAgent('gemini')`, `callAgent('codex')` | Smart dispatch always uses these three regardless of config                                          |
| `lib/hydra-setup.mjs:83-85`           | `{ claude, gemini, codex }`                                        | `detectInstalledCLIs()` never returns `copilot` or any future agent                                  |
| `lib/hydra-agents.mjs:bestAgentFor()` | Scores all registered agents equally                               | No filter for whether the agent's CLI is actually installed                                          |
| `invoke.headless()` in each agent def | Passes `opts.model` directly to `--model`                          | Hydra internal IDs (e.g. `copilot-claude-sonnet-4-6`) differ from CLI IDs (e.g. `claude-sonnet-4.6`) |

### Desired end state

```
hydra.config.json  ←  user sets roles.coordinator / .critic / .synthesizer
        ↓
hydra-dispatch.mjs  →  getRoleAgent('coordinator') → resolved agent name (e.g. 'copilot')
        ↓
agent-executor.mjs  →  invoke.headless(prompt, { model: resolveCliModelId(effectiveModel) })
        ↓
copilot -p "..." --model claude-sonnet-4.6 --output-format json ...
```

---

## Task A: Dispatch Role Resolution — `lib/hydra-dispatch.mjs`

**Files:** `lib/hydra-dispatch.mjs`, `lib/hydra-config.mjs`

### New roles in `hydra.config.json`

Add three dispatch-specific roles that map logical slots to agents. These are separate from the
task-queue roles (`architect`, `analyst`, `implementer`) — they govern the smart dispatch
pipeline specifically.

```json
"roles": {
  "coordinator":  { "agent": "claude",  "model": null },
  "critic":       { "agent": "gemini",  "model": null },
  "synthesizer":  { "agent": "codex",   "model": null }
}
```

Defaults live in `hydra-config.mjs` `DEFAULT_CONFIG.roles` so they are always present even if
omitted from the user's config.

### `getRoleAgent(roleName, installedCLIs)` helper

Add to `hydra-dispatch.mjs` (private, not exported):

```javascript
/**
 * Resolve the agent name for a dispatch role, with installed-CLI fallback.
 *
 * Resolution order:
 *   1. roles.<roleName>.agent from config  (user override)
 *   2. DEFAULT_CONFIG.roles.<roleName>.agent  (built-in default)
 *   3. First available agent from installedCLIs, in preference order
 *
 * @param {string} roleName  - 'coordinator' | 'critic' | 'synthesizer'
 * @param {Record<string,boolean>} installedCLIs  - output of detectInstalledCLIs()
 * @returns {string} agent name
 */
function getRoleAgent(roleName, installedCLIs) {
  const roleCfg = getRoleConfig(roleName);
  const preferred = roleCfg?.agent;
  if (preferred && installedCLIs[preferred] !== false) {
    // undefined means API agent or not tracked — allow it through
    return preferred;
  }
  // Fallback: find first installed agent from preference order
  const preference = ['claude', 'copilot', 'gemini', 'codex', 'local'];
  for (const name of preference) {
    if (installedCLIs[name]) return name;
  }
  return preferred || 'claude'; // last resort
}
```

### Refactor `main()` in `hydra-dispatch.mjs`

Replace hardcoded calls:

```javascript
// Before
const claudeResult = await callAgent('claude', claudePrompt, timeoutMs);
const geminiResult = await callAgent('gemini', geminiPrompt, timeoutMs);
const codexResult = await callAgent('codex', codexPrompt, timeoutMs);

// After
const clis = detectInstalledCLIs();
const coordinatorAgent = getRoleAgent('coordinator', clis);
const criticAgent = getRoleAgent('critic', clis);
const synthesizerAgent = getRoleAgent('synthesizer', clis);

const coordinatorResult = await callAgent(coordinatorAgent, coordinatorPrompt, timeoutMs);
const criticResult = await callAgent(criticAgent, criticPrompt, timeoutMs);
const synthesizerResult = await callAgent(synthesizerAgent, synthesizerPrompt, timeoutMs);
```

### Prompt builders — make role-aware

The existing `buildClaudeCoordinatorPrompt`, `buildGeminiPrompt`, `buildCodexPrompt` embed
agent-specific names and output shapes. Refactor them into generic role-based builders:

```javascript
// Single generic builder per dispatch slot, uses getAgent(agentName).label for display
function buildCoordinatorPrompt(agentName, userPrompt, daemonSummary) { ... }
function buildCriticPrompt(agentName, userPrompt, coordinatorOutput, daemonSummary) { ... }
function buildSynthesizerPrompt(agentName, userPrompt, coordinatorOutput, criticOutput, daemonSummary) { ... }
```

Each builder uses `getAgent(agentName).label` and `getAgent(agentName).rolePrompt` for the
preamble, so any agent can fill any slot without hard-coded references to "Gemini" or "Codex".

The JSON schema hint in the coordinator prompt (currently references `gemini_prompt`,
`codex_prompt` by name) becomes generic:

```javascript
const schemaHint = {
  understanding: 'string',
  delegation: {
    critic_prompt: 'string',
    synthesizer_prompt: 'string',
    task_splits: [{ owner: 'string', title: 'string', definition_of_done: 'string' }],
  },
  risks: ['string'],
  next_actions: ['string'],
};
```

### `report` object — use role keys

```javascript
report.coordinator = { ...coordinatorResult, parsed: coordinatorParsed };
report.critic = { ...criticResult, parsed: criticParsed };
report.synthesizer = { ...synthesizerResult };

// Preserve backward compat aliases for callers that read report.claude / .gemini / .codex
report.claude = report.coordinator;
report.gemini = report.critic;
report.codex = report.synthesizer;
```

---

## Task B: Registry-Driven CLI Detection — `lib/hydra-setup.mjs`

**Files:** `lib/hydra-setup.mjs`, `lib/hydra-agents.mjs`

### Problem

```javascript
// Current — hardcoded, never auto-expands for new agents
export function detectInstalledCLIs() {
  return {
    claude: commandExists('claude'),
    gemini: commandExists('gemini'),
    codex: commandExists('codex'),
  };
}
```

When Copilot is registered, `detectInstalledCLIs()` still returns `copilot: undefined` unless
edited manually. Same for opencode, aider, or any future agent.

### Solution — enumerate the registry

```javascript
/**
 * Detect which agent CLIs are installed.
 * Enumerates all registered physical agents with executeMode:'spawn' and
 * checks whether their CLI binary is on PATH.
 *
 * @returns {Record<string, boolean>}  agent name → installed
 */
export function detectInstalledCLIs() {
  const result = {};
  for (const [name, agentDef] of getRegisteredAgents()) {
    if (agentDef.type !== AGENT_TYPE.PHYSICAL) continue;
    if (agentDef.features?.executeMode !== 'spawn') continue;
    // CLI binary is the first element returned by invoke.headless('', {})
    let binaryName;
    try {
      const [cmd] = agentDef.invoke?.headless?.('', {}) ?? [];
      binaryName = cmd || name;
    } catch {
      binaryName = name;
    }
    result[name] = commandExists(binaryName);
  }
  return result;
}
```

> `getRegisteredAgents()` — export from `lib/hydra-agents.mjs`, returns an iterator over `_registry`.
> Already a natural addition since `_registry` is used internally.

This makes `detectInstalledCLIs()` automatically include every CLI agent (copilot, opencode,
aider, etc.) the moment it is registered in `PHYSICAL_AGENTS`. No manual edits needed.

### API agents (type: 'api', no CLI binary)

API agents (e.g. `local`) are excluded by the `executeMode !== 'spawn'` guard. They are always
considered "available" when `local.enabled: true` in config — that check stays in `bestAgentFor`.

---

## Task C: Availability-Filtered Routing — `lib/hydra-agents.mjs`

**Files:** `lib/hydra-agents.mjs`, `lib/hydra-actualize.mjs`

### Problem

`bestAgentFor()` ranks all registered and enabled agents by affinity score. If `copilot` is
registered but not installed (e.g. on a machine without the binary), it can still win the
routing race and then fail at spawn time.

### Solution — `installedOnly` option

```javascript
export function bestAgentFor(taskType, opts = {}) {
  const installedOnly = opts.installedOnly ?? false;
  const installedCLIs = installedOnly ? detectInstalledCLIs() : null;

  // ... existing scoring loop ...
  for (const [name, agent] of _registry) {
    if (!agent.enabled) continue;
    if (name === 'local' && !cfg.local?.enabled) continue;
    if (!includeVirtual && agent.type === AGENT_TYPE.VIRTUAL) continue;
    // NEW: skip CLI agents that aren't installed when installedOnly is requested
    if (installedOnly && agent.features?.executeMode === 'spawn') {
      if (installedCLIs[name] === false) continue;
    }
    // ... affinity scoring unchanged ...
  }
}
```

### Call sites

- `lib/hydra-actualize.mjs:407` — pass `{ installedOnly: true }` so tasks aren't dispatched to
  unavailable agents
- `lib/hydra-dispatch.mjs` — use `detectInstalledCLIs()` directly (already done in Task A)
- Default is `false` — existing callers are unaffected

---

## Task D: `cliModelId` Translation Convention

**Files:** `lib/hydra-model-profiles.mjs`, plugin `invoke.headless()` for each agent

### Problem

The executor resolves `effectiveModel` via `getActiveModel(agent)` (e.g. `copilot-claude-sonnet-4-6`)
and passes it to `invoke.headless(prompt, { model: effectiveModel })`. The agent's `headless()`
function then does `args.push('--model', opts.model)`, passing the Hydra internal ID to the CLI
— which fails because `copilot --model copilot-claude-sonnet-4-6` is not a valid model name.

Existing agents (`claude`, `gemini`, `codex`) avoid this because their Hydra model IDs happen to
match the CLI flag values. This is a fragile coincidence, not a contract.

### Solution — `resolveCliModelId()` helper

Add to `lib/hydra-model-profiles.mjs`:

```javascript
/**
 * Resolve a Hydra internal model ID to the CLI --model flag value.
 *
 * MODEL_PROFILES entries may have a `cliModelId` field when the CLI accepts
 * a different identifier than the Hydra-internal one. Falls back to the
 * input value unchanged (maintains backward compat with existing agents).
 *
 * @param {string} modelId  - Hydra internal model ID (e.g. 'copilot-claude-sonnet-4-6')
 * @returns {string}         CLI model ID (e.g. 'claude-sonnet-4.6')
 */
export function resolveCliModelId(modelId) {
  return MODEL_PROFILES[modelId]?.cliModelId ?? modelId;
}
```

### Convention for `invoke.headless()` in every agent plugin

```javascript
// ✅ CORRECT — any agent that may receive a Hydra internal model ID
import { resolveCliModelId } from '../hydra-model-profiles.mjs';

headless: (prompt, opts = {}) => {
  const args = ['-p', prompt];
  if (opts.model) args.push('--model', resolveCliModelId(opts.model));
  // ...
};

// ❌ WRONG — passes Hydra internal ID directly to CLI
headless: (prompt, opts = {}) => {
  const args = ['-p', prompt];
  if (opts.model) args.push('--model', opts.model);
  // ...
};
```

**Apply to:**

- Copilot agent definition (Task 1 in the integration plan — already flagged)
- Document as part of the **extensibility contract** (Task E below)
- Existing agents (`claude`, `codex`, `gemini`) do not need changes because their IDs already
  match — `resolveCliModelId` falls back to the input value unchanged

---

## Task E: Extensibility Contract — Future Agent Guide

**Files:** `docs/ARCHITECTURE.md` (new section), inline JSDoc in `lib/hydra-agents.mjs`

### Purpose

As new agents (opencode, aider, continue.dev, etc.) are added, they should follow a documented
contract. The contract lives in `ARCHITECTURE.md` and is enforced via the existing `registerAgent()`
defaults system.

### Minimum viable agent plugin

```javascript
// In lib/hydra-agents.mjs PHYSICAL_AGENTS (or a future lib/hydra-agents-<name>.mjs)
{
  name: 'opencode',                       // lowercase a-z0-9-
  label: 'OpenCode',
  type: AGENT_TYPE.PHYSICAL,
  features: {
    executeMode: 'spawn',                 // 'spawn' | 'api'
    jsonOutput: false,                    // true if CLI supports --output-format json
    stdinPrompt: false,                   // true if prompt goes via stdin
    reasoningEffort: false,               // true if --reasoning-effort flag supported
  },
  invoke: {
    headless: (prompt, opts = {}) => {
      const args = [/* CLI flags */];
      if (opts.model) args.push('--model', resolveCliModelId(opts.model));
      return ['opencode', args];
    },
  },
  parseOutput(stdout, opts) {
    // If jsonOutput: true, parse structured output
    // Otherwise: return { output: stdout, tokenUsage: null, costUsd: null }
    return { output: stdout, tokenUsage: null, costUsd: null };
  },
  taskAffinity: {
    planning: 0.6, architecture: 0.6, review: 0.7, refactor: 0.9,
    implementation: 0.9, analysis: 0.7, testing: 0.8,
    research: 0.5, documentation: 0.6, security: 0.6,
  },
  // Optional plugin fields (all have defaults from registerAgent()):
  errorPatterns: [],
  modelBelongsTo: (modelId) => modelId.startsWith('opencode-'),
  quotaVerify: async () => null,
  economyModel: () => null,
  readInstructions: null,
  taskRules: [],
}
```

### Checklist for adding a new agent

1. **Plugin definition** — add entry to `PHYSICAL_AGENTS` in `lib/hydra-agents.mjs`
2. **Model profiles** — add `MODEL_PROFILES` entries in `lib/hydra-model-profiles.mjs` with
   `cliModelId` where needed
3. **Config defaults** — add `models.<agentName>` entry in `DEFAULT_CONFIG` in `lib/hydra-config.mjs`
4. **UI** — add color (`AGENT_COLORS`) and icon (`AGENT_ICONS`) in `lib/hydra-ui.mjs`
5. **Setup** — `detectInstalledCLIs()` picks it up automatically (Task B)
6. **Routing** — `bestAgentFor()` picks it up automatically from `taskAffinity` scores
7. **Dispatch** — update `roles.coordinator/critic/synthesizer` in `hydra.config.json` if desired
8. **MCP** — add `KNOWN_CLI_MCP_PATHS` entry in `lib/hydra-setup.mjs` if the agent supports MCP config
9. **Docs** — `COPILOT.md`-style agent instructions file (optional but recommended)

> The registry-driven design (Tasks B, C) means steps 5 and 6 require **zero code changes** once
> the plugin is registered — they happen automatically.

---

## Implementation Phases

### Phase 1 — Model ID Translation (Must-Have, unblocks Copilot)

**Task D** — Add `resolveCliModelId()` to `hydra-model-profiles.mjs`. Apply to Copilot
`invoke.headless()`. No behavior change for existing agents. Very low risk.

### Phase 2 — Registry-Driven Detection + Availability Filtering (Should-Have)

**Tasks B, C** — `detectInstalledCLIs()` enumerates registry; `bestAgentFor()` gains
`installedOnly` option; `hydra-actualize.mjs` passes `installedOnly: true`. Low risk — opt-in
flag, existing callers unaffected.

### Phase 3 — Dynamic Dispatch (Nice-to-Have, significant change)

**Tasks A** — Refactor `hydra-dispatch.mjs`. Higher risk because prompt templates change and
`report` key names change. Backward compat aliases (`report.claude`, `.gemini`, `.codex`)
mitigate downstream breakage. Requires full dispatch integration testing.

### Phase 4 — Extensibility Contract Docs (Must-Have before merging new agents)

**Task E** — `ARCHITECTURE.md` section + JSDoc. Required before opencode or any other agent is
added by anyone other than the original author.

---

## Known Risks

| Risk                                                                                        | Severity   | Mitigation                                                                                                    |
| ------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| Dispatch prompt template quality degrades when non-Claude fills coordinator slot            | Medium     | Generic templates use `agentDef.rolePrompt`; quality validated per agent before promoting to coordinator role |
| `detectInstalledCLIs()` calling `invoke.headless('', {})` may have side effects             | Low        | Call site guarded with try/catch; empty prompt is safe for all current agents                                 |
| `installedOnly: true` in actualize breaks on machines where no preferred agent is installed | Medium     | `bestAgentFor` always returns a fallback (`'claude'`) when no candidates pass the filter                      |
| Changing `report.claude` → `report.coordinator` breaks callers reading the report JSON      | Low        | Backward compat aliases preserved; existing consumers unaffected                                              |
| `resolveCliModelId` adds a `MODEL_PROFILES` lookup on every headless invocation             | Negligible | Synchronous hash map lookup; no I/O                                                                           |

---

## Related Plans

- [`2026-03-07-github-copilot-cli-integration.md`](./2026-03-07-github-copilot-cli-integration.md) — Copilot agent plugin (Task D is a prerequisite for Task 1 there)
- [`2026-03-08-agent-plugin-refactor.md`](./2026-03-08-agent-plugin-refactor.md) — The plugin architecture this builds on
- [`2026-03-10-typescript-migration.md`](./2026-03-10-typescript-migration.md) — Phase 7 of the TS migration unblocks Task A; Phase 3 unblocks Task D

---

_Document created: 2026-03-10_
_Status: Draft_
