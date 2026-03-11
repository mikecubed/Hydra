# Interface Contract: Agent Plugin Interface

**Feature**: Agent Plugin Refactor
**Consumer**: All Hydra subsystems that dispatch to or query agent definitions

---

## Guarantee

After `registerAgent(name, def)` is called, `getAgent(name)` will always return an object that satisfies the full plugin interface below. No subsystem needs to guard against missing fields.

---

## Plugin Interface (guaranteed fields on every registered agent)

### `features` object

```
features: {
  executeMode: 'spawn' | 'api'
  jsonOutput:      boolean
  stdinPrompt:     boolean
  reasoningEffort: boolean
}
```

- `executeMode: 'spawn'` — agent is invoked by spawning a CLI process via `invoke.headless()`
- `executeMode: 'api'` — agent is invoked via HTTP (no CLI spawn); `invoke.headless` may be null
- `jsonOutput` — when true, stdout is structured JSON or JSONL; executor passes to `parseOutput`
- `stdinPrompt` — when true, prompt is delivered via stdin pipe; when false, via a `-p` flag
- `reasoningEffort` — when true, `--reasoning-effort` flag is supported and passed by executor

---

### `parseOutput(stdout, opts?) → ParsedOutput`

Called once by the executor after the spawned process exits.

**Parameters:**

- `stdout: string` — raw process stdout
- `opts?: { jsonOutput?: boolean }` — executor-provided hints

**Returns:**

```
{
  output:     string        // extracted text response (may equal stdout if parsing fails)
  tokenUsage: TokenUsage | null
  costUsd:    number | null
}

TokenUsage: {
  inputTokens:          number
  outputTokens:         number
  cacheCreationTokens:  number
  cacheReadTokens:      number
  totalTokens:          number
}
```

**Contract:** Must never throw. On parse failure, returns `{ output: stdout, tokenUsage: null, costUsd: null }`.

---

### `errorPatterns` object

```
errorPatterns: {
  authRequired?:         RegExp
  rateLimited?:          RegExp
  quotaExhausted?:       RegExp
  networkError?:         RegExp
  subscriptionRequired?: RegExp   // optional
}
```

All fields optional. Used by executor error categorization and evolve error handling. Empty object `{}` is a valid value (no special error pattern matching for this agent).

---

### `modelBelongsTo(modelId: string) → boolean`

Returns `true` if the given model ID belongs to this agent's provider family. Used by `hydra-usage.mjs` for model ownership attribution.

**Contract:** Must never throw. Returns `false` for unknown/null input.

---

### `quotaVerify(apiKey: string | undefined, opts?: { hintText?: string }) → Promise<QuotaResult | null>`

Verifies whether the agent's quota is exhausted.

**Returns:**

```
null                              // quota check not applicable (skip silently)
{ verified: false, status: number }               // quota is NOT exhausted
{ verified: true,  status: number, reason: string } // quota IS exhausted
{ verified: 'unknown', reason: string }             // could not determine
```

**Contract:** Must never throw. Returns `null` if quota is inherently unverifiable (e.g. local agent, OAuth-only auth).

---

### `economyModel(budgetCfg?: object) → string | null`

Returns the preferred economy/fallback model ID for this agent when budget thresholds are exceeded.

**Returns:** A model ID string (e.g. `'o4-mini'`), or `null` if no economy model is defined for this agent (callers fall back to default behavior).

**Contract:** Must never throw.

---

### `readInstructions(instructionFile: string) → string`

Returns the instruction preamble string to include in the agent's task context.

**Returns:** A human-readable string telling the agent which files to read before starting work.

**Default:** `` (f) => `Read ${f} first.` ``

---

### `taskRules` array

```
taskRules: string[]
```

Agent-specific rules appended to task prompts. Each entry is a string (typically a bullet point). Empty array `[]` is valid.

---

## Defaults applied by `registerAgent()`

| Field                      | Default when absent in `def`                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `features.executeMode`     | `'api'` if `def.customType === 'api'`, else `'spawn'`               |
| `features.jsonOutput`      | `false`                                                             |
| `features.stdinPrompt`     | `false`                                                             |
| `features.reasoningEffort` | `false`                                                             |
| `parseOutput`              | `(stdout) => ({ output: stdout, tokenUsage: null, costUsd: null })` |
| `errorPatterns`            | `{}`                                                                |
| `modelBelongsTo`           | `() => false`                                                       |
| `quotaVerify`              | `async () => null`                                                  |
| `economyModel`             | `() => null`                                                        |
| `readInstructions`         | `` (f) => `Read ${f} first.` ``                                     |
| `taskRules`                | `[]`                                                                |

---

## Consumers

| Consumer                              | Field(s) used                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lib/hydra-shared/agent-executor.mjs` | `features.executeMode`, `features.jsonOutput`, `features.reasoningEffort`, `invoke.headless()`, `parseOutput()` |
| `lib/hydra-metrics.mjs`               | `tokenUsage` in executor result (not a direct plugin call)                                                      |
| `lib/hydra-usage.mjs`                 | `modelBelongsTo()`                                                                                              |
| `lib/hydra-actualize.mjs`             | `economyModel()`                                                                                                |
| `lib/orchestrator-daemon.mjs`         | `readInstructions()`, `taskRules`                                                                               |
| `lib/hydra-model-recovery.mjs`        | `quotaVerify()`                                                                                                 |
| `lib/hydra-operator.mjs`              | `taskRules`                                                                                                     |
| `lib/hydra-evolve.mjs`                | `features.jsonOutput`, `errorPatterns`                                                                          |
| `lib/hydra-audit.mjs`                 | `invoke.nonInteractive()`, `economyModel()`                                                                     |

---

## Future Enhancement (not in this refactor)

**`invoke.withEconomyModel(baseArgs, modelId) → string[]`** — would let `hydra-audit.mjs::getAgentCommand()` inject the economy model flag without knowing whether to use `--model` or `-m`. Not required for this refactor; the flag format is a documented residual conditional in `getAgentCommand()`.
