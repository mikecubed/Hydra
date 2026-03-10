# GitHub Copilot CLI Integration — Planning Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate [GitHub Copilot CLI](https://github.com/github/copilot-cli) as a fifth physical agent in Hydra, enabling `copilot` alongside `claude`, `gemini`, `codex`, and `local` in all dispatch modes, council deliberation, worker pools, and MCP tooling.

**Status:** Ready for implementation — validated against live CLI 2026-03-10

**Depends on:** ~~Agent Plugin Refactor (2026-03-08)~~ — **DONE.** The plugin refactor made the executor data-driven. Adding Copilot now requires **zero executor changes** — only a `PHYSICAL_AGENTS` entry with plugin fields, UI colors, model profiles, config, and setup.

**TypeScript prerequisite (preferred, not required):** Phases 1–4 of the [TypeScript Migration Plan](./2026-03-10-typescript-migration.md) are _preferred_ before implementing this integration so the Copilot plugin is written in TypeScript from day one. However, Tasks 1 and 11 **may be implemented in JSDoc-typed JavaScript first** and converted to TypeScript during Phase 3/4 of the migration. This avoids blocking feature delivery on a long-running refactor. Choose based on current team priority.

**Architecture:** Add `copilot` as a new `PHYSICAL_AGENTS` entry in `hydra-agents.mjs` with full plugin interface (`features`, `parseOutput`, `errorPatterns`, `modelBelongsTo`, `quotaVerify`, `economyModel`, `readInstructions`, `taskRules`). Wire it into `hydra-ui.mjs` for colored output, register it in `hydra-model-profiles.mjs` and `hydra.config.json`, add CLI detection in `hydra-setup.mjs`, and create a `COPILOT.md` agent instructions file. The agent's council role is **advisor** — it brings GitHub-integrated context (issues, PRs, CI) that the other agents lack.

**Tech Stack:** Node.js ESM, `copilot` CLI binary (GitHub Copilot CLI), existing Hydra agent infrastructure. No new npm dependencies. No executor changes needed — the plugin architecture handles everything.

---

## Background: GitHub Copilot CLI

GitHub Copilot CLI (`copilot`) is a terminal-native agentic coding assistant backed by GitHub's Copilot service. Key properties relevant to Hydra:

| Property                  | Value                                                                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Binary**                | `copilot`                                                                                                                                                                                                                                                                                                |
| **npm package**           | `@github/copilot`                                                                                                                                                                                                                                                                                        |
| **Install (macOS/Linux)** | `curl -fsSL https://gh.io/copilot-install \| bash` or `brew install copilot-cli`                                                                                                                                                                                                                         |
| **Install (Windows)**     | `winget install GitHub.Copilot`                                                                                                                                                                                                                                                                          |
| **Install (npm)**         | `npm install -g @github/copilot`                                                                                                                                                                                                                                                                         |
| **Auth requirement**      | GitHub account with active Copilot subscription; `GH_TOKEN`/`GITHUB_TOKEN` env var for PAT auth                                                                                                                                                                                                          |
| **Default model**         | Claude Sonnet 4.6 (as of March 2026; first in `--model` choices list)                                                                                                                                                                                                                                    |
| **Other models**          | `claude-sonnet-4.5`, `claude-haiku-4.5`, `claude-opus-4.6`, `claude-opus-4.6-fast`, `claude-opus-4.5`, `claude-sonnet-4`, `gemini-3-pro-preview`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1-codex`, `gpt-5.1`, `gpt-5.1-codex-mini`, `gpt-5-mini`, `gpt-4.1` |
| **MCP support**           | Ships with GitHub MCP server built-in; accepts custom MCP servers via `~/.copilot/mcp-config.json` or `.github/mcp.json`                                                                                                                                                                                 |
| **LSP support**           | Language Server Protocol via `~/.copilot/lsp-config.json`                                                                                                                                                                                                                                                |
| **Custom instructions**   | Via `.github/copilot-instructions.md` (project-level)                                                                                                                                                                                                                                                    |
| **Context window**        | ~128K tokens (Claude Sonnet 4.5 base)                                                                                                                                                                                                                                                                    |

### Interfaces

**Interactive mode** (default):

```bash
copilot               # Start REPL session with animated banner
copilot --banner      # Show banner again on launch
copilot --experimental  # Enable experimental features (Autopilot mode)
```

**Programmatic mode** (headless-compatible):

```bash
# Single prompt, exits after completion
copilot -p "prompt text"
copilot --prompt "prompt text"

# Silent mode (output only agent response, no stats) — recommended for scripting
copilot -p "prompt text" --silent

# With tool approval (required for file modification in programmatic mode)
copilot -p "refactor auth.js" --allow-all-tools
copilot -p "show commits" --allow-tool 'shell(git:*)'

# Structured JSON output (JSONL: one JSON event object per line)
copilot -p "prompt text" --output-format json --allow-all-tools

# Autonomous mode (disables ask_user tool — agent works without asking questions)
copilot -p "prompt text" --allow-all-tools --no-ask-user

# Autopilot continuation (agent continues until task complete, up to --max-autopilot-continues)
copilot -p "prompt text" --autopilot --allow-all-tools
```

**Approval flags** (permission model, maps to Hydra's `permissionMode`):

| Hydra `permissionMode` | Copilot flag                                       | Behavior                         |
| ---------------------- | -------------------------------------------------- | -------------------------------- |
| `plan`                 | _(none — interactive approval required)_           | Asks before each tool use        |
| `auto-edit`            | `--allow-tool 'shell(git:*)' --allow-tool 'write'` | Allow file + shell, one session  |
| `full-auto`            | `--allow-all-tools` (or `--allow-all` / `--yolo`)  | Allow all tools without approval |

### Known Limitations for Headless Integration

`copilot -p` supports `--output-format json` (confirmed in CLI v1.x). The output is **JSONL** (one JSON event object per newline), not a single JSON object. Key event types:

- `assistant.message` — final assembled message with `content` field (the response text); `toolRequests: []` on the last response turn
- `assistant.message_delta` — streaming delta (ephemeral, can be ignored in batch mode)
- `result` — final event with `usage.premiumRequests` and timing

The `parseOutput()` plugin method handles both JSONL (when `features.jsonOutput: true`) and plain text fallback. See Task 1 for the implementation.

> **Note on `--silent`**: Add `--silent` (`-s`) to headless invocations to suppress the stats footer ("Session complete — X premium requests"). This keeps stdout clean for JSONL parsing. Without it, non-JSON stats appear after the JSONL stream.

---

## Reference: Copilot CLI Config Locations

### MCP Server Registration

- **File:** `~/.copilot/mcp-config.json` (user-level) or `.github/mcp.json` (project-level)
- **Format:**

```json
{
  "mcpServers": {
    "hydra": {
      "command": "node",
      "args": ["/path/to/hydra-mcp-server.mjs"],
      "description": "Hydra multi-agent orchestration"
    }
  }
}
```

### Custom Instructions

- **File:** `.github/copilot-instructions.md` (project-level)
- Contains persistent instructions injected into every Copilot session

### LSP Configuration

- **File:** `~/.copilot/lsp-config.json` (user-level) or `.github/lsp.json` (project-level)

---

## Task 1: Agent Definition — `lib/hydra-agents.mjs`

**Files:**

- `lib/hydra-agents.mjs` — Add `copilot` entry to `PHYSICAL_AGENTS` with full plugin interface

**What to add** — insert after `local` in the `PHYSICAL_AGENTS` object. The entry includes all plugin fields that the executor, metrics, usage, actualize, daemon, and recovery modules consume via the data-driven plugin interface:

```javascript
copilot: {
  name: 'copilot',
  type: 'physical',
  displayName: 'Copilot',
  label: 'GitHub Copilot CLI',
  cli: 'copilot',
  invoke: {
    // nonInteractive runs with plan-mode approval (no --allow flags) to match
    // the permission table above. Callers (daemon, triage) must not expect
    // file-modification side-effects from nonInteractive calls.
    // NOTE: resolveCliModelId() must be applied to both headless() and nonInteractive()
    // — anywhere opts.model is passed to --model.
    nonInteractive: (prompt, opts = {}) => {
      const args = ['-p', prompt];
      if (opts.model) args.push('--model', resolveCliModelId(opts.model));
      return ['copilot', args];
    },
    interactive: (prompt) => ['copilot', [prompt]],
    headless: (prompt, opts = {}) => {
      const args = ['-p', prompt, '--silent'];  // --silent strips stats footer from stdout
      if (opts.model) args.push('--model', opts.model);
      // JSON output — enabled by default (features.jsonOutput: true)
      if (opts.jsonOutput !== false) args.push('--output-format', 'json');
      // Autonomous headless — disable the ask_user tool so agent doesn't stall waiting for input
      args.push('--no-ask-user');
      if (opts.permissionMode === 'full-auto') {
        args.push('--allow-all-tools');
      } else if (opts.permissionMode === 'auto-edit') {
        // 'write' allows file edits; 'shell(git:*)' allows git commands
        args.push('--allow-tool', 'shell(git:*)', '--allow-tool', 'write');
      }
      // Default (plan): no --allow flags; Copilot will prompt interactively
      return ['copilot', args];
    },
  },
  contextBudget: 128_000,
  contextTier: 'medium',

  // ── Plugin interface fields ───────────────────────────────────────
  // These are consumed by the data-driven executor, metrics, usage,
  // actualize, daemon, and recovery modules — no per-agent if/else
  // blocks needed anywhere.

  features: {
    executeMode: 'spawn',     // Standard CLI spawn — not an API agent
    jsonOutput: true,         // --output-format json is live; output is JSONL (event stream)
    stdinPrompt: false,       // Copilot uses -p flag, not stdin
    reasoningEffort: false,   // No --reasoning-effort flag (yet)
  },

  parseOutput(stdout, opts) {
    // JSON path: JSONL format — one event object per line
    // Relevant event types:
    //   assistant.message  — final assembled response; content + outputTokens
    //   result             — final summary; usage.premiumRequests
    if (opts?.jsonOutput) {
      try {
        const lines = stdout.split('\n').filter(Boolean);
        const events = lines.map((l) => JSON.parse(l));

        // Find the last assistant.message that is a final text response
        // (toolRequests is empty, meaning it's the final answer turn)
        const messages = events.filter(
          (e) => e.type === 'assistant.message' && Array.isArray(e.data?.toolRequests) && e.data.toolRequests.length === 0,
        );
        const lastMsg = messages.at(-1);
        const output = lastMsg?.data?.content ?? stdout;

        // Extract usage from the final result event
        const resultEvent = events.findLast?.((e) => e.type === 'result') ??
          [...events].reverse().find((e) => e.type === 'result');
        const premiumRequests = resultEvent?.usage?.premiumRequests ?? null;

        return {
          output,
          tokenUsage: premiumRequests !== null ? { premiumRequests } : null,
          costUsd: null, // Subscription-based — no per-call cost
        };
      } catch {}
    }
    // Plain text fallback (same approach as Gemini text mode)
    return { output: stdout, tokenUsage: null, costUsd: null };
  },

  errorPatterns: {
    authRequired:         /not logged in|authentication required|copilot subscription|no copilot access/i,
    rateLimited:          /rate limit|quota exceeded|too many requests/i,
    quotaExhausted:       /premium request.*limit|monthly.*quota.*exceeded/i,
    networkError:         /network error|connection refused|ECONNREFUSED|ENOTFOUND/i,
    subscriptionRequired: /copilot plan required|upgrade your plan/i,
  },

  modelBelongsTo: (id) => String(id).toLowerCase().startsWith('copilot-'),

  // GitHub-managed subscription — not verifiable via API key
  quotaVerify: async () => null,

  // Economy mode: Sonnet uses the least premium-request quota
  economyModel: () => 'copilot-claude-sonnet-4-6',

  readInstructions: (f) =>
    `Read ${f} and any relevant GitHub context (issues, PRs) before responding.`,

  taskRules: [
    '- Cross-reference with open issues and CI history when reviewing code.',
  ],

  // ── Standard agent metadata ───────────────────────────────────────

  strengths: [
    'github-integration',
    'issue-pr-awareness',
    'ci-workflow',
    'code-suggestion',
    'real-time-assist',
    'mcp-native',
    'multi-model',             // Claude Opus/Sonnet 4.6, GPT-5.4, Gemini 3.1 Pro
  ],
  weaknesses: [
    'subscription-required',   // Requires active Copilot plan
    'github-account-auth',     // Must be authenticated via GH_TOKEN or device flow
    'complex-architecture',
  ],
  councilRole: 'advisor',
  taskAffinity: {
    planning: 0.65,
    architecture: 0.55,
    review: 0.80,
    refactor: 0.70,
    implementation: 0.75,
    analysis: 0.65,
    testing: 0.70,
    research: 0.60,
    documentation: 0.75,
    security: 0.70,
  },
  rolePrompt:
    `You are the GitHub integration advisor. Your responsibilities:

1. **GitHub Context**: Leverage your built-in access to GitHub issues, PRs, CI workflows, and repository context. Always use this context to inform your suggestions.
2. **Workflow Automation**: Identify opportunities to automate GitHub workflows — CI improvements, PR templates, issue triage, branch protection.
3. **Code Review Integration**: When reviewing code, cross-reference with open issues, related PRs, and CI failure patterns.
4. **Practical Suggestions**: Prioritize actionable changes over theoretical improvements. Provide \`git\`/\`gh\` CLI commands the team can run immediately.

Output structure: GitHub context summary → Actionable suggestions → Commands to run.`,
  timeout: 7 * 60 * 1000,
  tags: ['github', 'integration', 'copilot', 'advisory'],
  enabled: true,
},
```

### What the plugin architecture provides automatically

Because the executor is now data-driven, adding this single `PHYSICAL_AGENTS` entry gives Copilot:

| Capability            | Plugin field used      | Where consumed                                                                    |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| CLI arg building      | `invoke.headless()`    | `agent-executor.mjs` — args built via `agentDef.invoke.headless(prompt, opts)`    |
| Output parsing        | `parseOutput()`        | `agent-executor.mjs` — output parsed via `agentDef.parseOutput(rawOutput, opts)`  |
| Error categorization  | `errorPatterns`        | `agent-executor.mjs`, `hydra-evolve.mjs` — pattern matching against stderr/stdout |
| Model ownership       | `modelBelongsTo()`     | `hydra-usage.mjs` — tracks which models belong to Copilot                         |
| Economy fallback      | `economyModel()`       | `hydra-actualize.mjs` — economy mode model selection                              |
| Quota verification    | `quotaVerify()`        | `hydra-model-recovery.mjs` — returns null (GitHub-managed)                        |
| Instructions preamble | `readInstructions()`   | `orchestrator-daemon.mjs` — context preamble for agent tasks                      |
| Task rules            | `taskRules`            | `orchestrator-daemon.mjs`, `hydra-operator.mjs` — appended to task prompts        |
| Routing               | `features.executeMode` | `agent-executor.mjs` — routes to spawn path                                       |
| Stdin vs flag         | `features.stdinPrompt` | `agent-executor.mjs` — uses `-p` flag, not stdin                                  |

**No changes to `agent-executor.mjs`, `hydra-metrics.mjs`, `hydra-usage.mjs`, `hydra-actualize.mjs`, `orchestrator-daemon.mjs`, `hydra-model-recovery.mjs`, or `hydra-evolve.mjs` are needed.**

---

## Task 2: UI Integration — `lib/hydra-ui.mjs`

**Files:**

- `lib/hydra-ui.mjs` — Add Copilot color and icon

> - Update `agentHeader()` in `hydra-ui.mjs` which may have 3-agent hardcoded layout assumptions
> - Review usage/metrics rendering loops in `hydra-usage.mjs` for any hardcoded `['claude','gemini','codex']` arrays that need to become registry-driven

**What to add:**

```javascript
// GitHub Copilot brand color (#1F6FEB — GitHub blue)
const copilotBlue = (str) => `\x1b[38;2;31;111;235m${str}\x1b[39m`;

export const AGENT_COLORS = {
  gemini: pc.cyan,
  codex: pc.green,
  claude: claudeOrange,
  copilot: copilotBlue, // ← add this
  human: pc.yellow,
  system: pc.blue,
};

export const AGENT_ICONS = {
  gemini: '\u2726', // ✦
  codex: '\u058E', // ֎
  claude: '\u274B', // ❋
  copilot: '\u29BF', // ⦿ — circled bullet; single-codepoint, matches existing icon style
  human: '\u{1F16F}', // 🅯
  system: '\u{1F5B3}', // 🖳
};
```

> **Note on icon:** `\u29BF` (⦿) is chosen for terminal safety — it is a single BMP codepoint consistent with the existing icon set (`✦`, `֎`, `❋`). The emoji `🦾` (`\u{1F9BE}`) is a more expressive alternative for terminals with emoji support, but it is a surrogate pair that may not render uniformly across all terminal emulators. A terminal capability check can be added later to upgrade the icon dynamically.

---

## Task 3: ~~Output Parsing~~ — No Executor Changes Needed ✅ SIMPLIFIED

> **Post-plugin-refactor:** This task is **eliminated**. The entire output parsing, stdin routing, and error pattern logic that was previously described here is now handled by the plugin fields in the Task 1 agent definition:
>
> - **Output parsing** → `parseOutput(stdout, opts)` in the `PHYSICAL_AGENTS.copilot` entry
> - **Stdin routing** → `features.stdinPrompt: false` (executor reads this, uses `-p` flag)
> - **Error patterns** → `errorPatterns` object in the agent definition
> - **JSON output gating** → `features.jsonOutput: false` (executor passes to `invoke.headless()` and `parseOutput()`)
>
> The executor's data-driven pipeline handles all of this automatically:
>
> 1. `agentDef.invoke.headless(prompt, opts)` builds the CLI args (including model resolution)
> 2. `agentDef.parseOutput(rawOutput, opts)` extracts output, tokenUsage, costUsd
> 3. `agentDef.errorPatterns` are checked against stderr/stdout for error categorization
>
> **No files need to be modified in `agent-executor.mjs`, `hydra-metrics.mjs`, or `hydra-evolve.mjs`.**
>
> The `features.jsonOutput: false → true` flip is the **only change needed** when the Copilot CLI ships `--output-format json`. The `parseOutput()` method already handles both paths.

---

## Task 4: Model Profiles — `lib/hydra-model-profiles.mjs`

**Files:**

- `lib/hydra-model-profiles.mjs` — Add Copilot model entries

**What to add** to `MODEL_PROFILES`:

> **Note on model IDs:** The `id` field is Hydra's internal profile key (prefixed `copilot-`). The `cliModelId` field is the actual value passed to `copilot --model <id>`. **All `cliModelId` values below are validated against the live CLI `--model` choices list.** Claude models use dots (e.g. `claude-sonnet-4.6`), not hyphens. Gemini is `gemini-3-pro-preview` (not `gemini-3.1-pro`).

> **Note on rate limits:** All rate limit values below are estimates. Copilot subscription tiers (Individual = tier 1, Business = tier 2, Enterprise = tier 3) share quota pools across models. The rpm/tpm values reflect sustained throughput, not monthly premium-request quota. Update from GitHub's official rate limit documentation when published.

```javascript
'copilot-claude-sonnet-4-6': {
  id: 'copilot-claude-sonnet-4-6',
  cliModelId: 'claude-sonnet-4.6',         // value passed to copilot --model
  provider: 'github',
  agent: 'copilot',
  displayName: 'Copilot (Claude Sonnet 4.6)',
  shortName: 'copilot-sonnet',
  tier: 'mid',
  contextWindow: 128_000,
  maxOutput: 64_000,
  pricePer1M: { input: 0, output: 0 },     // Included in Copilot subscription
  costPer1K: { input: 0, output: 0 },
  tokPerSec: 75,                            // Estimated; inherits Sonnet 4.6 base perf
  ttft: 2.0,
  reasoning: { type: 'none', levels: ['off'], default: 'off' },
  benchmarks: { sweBench: 79.2 },          // Inherits Claude Sonnet 4.6 base; GitHub tuning may vary
  qualityScore: 85,
  valueScore: 92,                           // High — subscription cost amortized
  speedScore: 32,
  strengths: ['github-integration', 'pr-awareness', 'code-suggestion', 'mcp-native', 'price-performance'],
  bestFor: ['review', 'documentation', 'implementation', 'refactor'],
  rateLimits: {
    free: { rpm: 10, tpm: 100_000 },
    1: { rpm: 10, tpm: 100_000 },          // Individual: 300 premium reqs/month quota
    2: { rpm: 30, tpm: 300_000 },          // Business/Enterprise: higher rate + quota
    3: { rpm: 50, tpm: 500_000 },
  },
},
'copilot-claude-opus-4-6': {
  id: 'copilot-claude-opus-4-6',
  cliModelId: 'claude-opus-4.6',           // value passed to copilot --model
  provider: 'github',
  agent: 'copilot',
  displayName: 'Copilot (Claude Opus 4.6)',
  shortName: 'copilot-opus',
  tier: 'flagship',
  contextWindow: 128_000,
  maxOutput: 64_000,
  pricePer1M: { input: 0, output: 0 },
  costPer1K: { input: 0, output: 0 },
  tokPerSec: 55,                            // Estimated; Opus is slower than Sonnet
  ttft: 2.5,
  reasoning: { type: 'none', levels: ['off'], default: 'off' },
  benchmarks: { sweBench: 80.8 },          // Inherits Claude Opus 4.6 base
  qualityScore: 95,
  valueScore: 88,                           // Premium model, high quality, subscription-included
  speedScore: 22,
  strengths: ['github-integration', 'abstract-reasoning', 'agentic', 'code-quality', 'long-context'],
  bestFor: ['planning', 'architecture', 'security', 'review'],
  rateLimits: {
    free: { rpm: 5, tpm: 50_000 },
    1: { rpm: 5, tpm: 50_000 },            // Individual: lower quota for flagship model
    2: { rpm: 15, tpm: 150_000 },
    3: { rpm: 30, tpm: 300_000 },
  },
},
'copilot-gpt-5-4': {
  id: 'copilot-gpt-5-4',
  cliModelId: 'gpt-5.4',                   // value passed to copilot --model
  provider: 'github',
  agent: 'copilot',
  displayName: 'Copilot (GPT-5.4)',
  shortName: 'copilot-gpt5.4',
  tier: 'flagship',
  contextWindow: 128_000,
  maxOutput: 64_000,
  pricePer1M: { input: 0, output: 0 },
  costPer1K: { input: 0, output: 0 },
  tokPerSec: 70,                            // Estimated; GPT-5.4 is faster than Opus
  ttft: 2.2,
  reasoning: { type: 'effort', levels: ['none', 'low', 'medium', 'high'], default: 'none' },
  benchmarks: { sweBenchPro: 57.7, gpqaDiamond: 84.2 }, // Inherits GPT-5.4 base
  qualityScore: 93,
  valueScore: 90,
  speedScore: 40,
  strengths: ['github-integration', 'reasoning', 'long-context', 'implementation', 'code-generation'],
  bestFor: ['implementation', 'refactor', 'analysis', 'complex-tasks'],
  rateLimits: {
    free: { rpm: 5, tpm: 50_000 },
    1: { rpm: 10, tpm: 100_000 },
    2: { rpm: 20, tpm: 200_000 },
    3: { rpm: 40, tpm: 400_000 },
  },
},
'copilot-gemini-3-pro-preview': {
  id: 'copilot-gemini-3-pro-preview',
  cliModelId: 'gemini-3-pro-preview',      // value passed to copilot --model (confirmed from --model choices)
  provider: 'github',
  agent: 'copilot',
  displayName: 'Copilot (Gemini 3.1 Pro)',
  shortName: 'copilot-gemini',
  tier: 'flagship',
  contextWindow: 128_000,                   // Copilot context cap; underlying model is 1M
  maxOutput: 64_000,
  pricePer1M: { input: 0, output: 0 },
  costPer1K: { input: 0, output: 0 },
  tokPerSec: 120,                           // Estimated; Gemini 3.1 Pro is fast
  ttft: 1.8,
  reasoning: { type: 'none', levels: ['off'], default: 'off' },
  benchmarks: { sweBench: 76.2, gpqaDiamond: 91.9 }, // Inherits Gemini 3.1 Pro base
  qualityScore: 88,
  valueScore: 90,
  speedScore: 55,
  strengths: ['github-integration', 'algorithmic-coding', 'analysis', 'multimodal', 'speed'],
  bestFor: ['analysis', 'review', 'research', 'documentation'],
  rateLimits: {
    free: { rpm: 5, tpm: 50_000 },
    1: { rpm: 10, tpm: 100_000 },
    2: { rpm: 25, tpm: 250_000 },
    3: { rpm: 50, tpm: 500_000 },
  },
},
```

**Also add** to `AGENT_PRESETS`:

```javascript
copilot: {
  default: 'copilot-claude-sonnet-4-6',    // Balanced — good for most tasks
  fast:    'copilot-claude-sonnet-4-6',    // Sonnet is the fastest premium option
  cheap:   'copilot-claude-sonnet-4-6',    // All models included in subscription; sonnet uses least quota
  flagship: 'copilot-claude-opus-4-6',     // Highest quality Claude option
},
```

**Also add** to `ROLE_DEFAULTS`:

```javascript
copilot: {
  role: 'advisor',
  agent: 'copilot',
  model: 'copilot-claude-sonnet-4-6',
},
'copilot-reviewer': {
  role: 'reviewer',
  agent: 'copilot',
  model: 'copilot-claude-sonnet-4-6',      // Sonnet is well-suited for review tasks
},
'copilot-architect': {
  role: 'architect',
  agent: 'copilot',
  model: 'copilot-claude-opus-4-6',        // Opus for planning/architecture depth
},
```

---

## Task 5: Config Updates — `hydra.config.json`

**Files:**

- `hydra.config.json` — Add Copilot model config, aliases, mode tiers, and role

**`models` section** — add:

```json
"copilot": {
  "default": "copilot-claude-sonnet-4-6",
  "fast": "copilot-claude-sonnet-4-6",
  "cheap": "copilot-claude-sonnet-4-6",
  "flagship": "copilot-claude-opus-4-6",
  "active": "copilot-claude-sonnet-4-6",
  "reasoningEffort": null
}
```

**`aliases` section** — add:

```json
"copilot": {
  "sonnet": "copilot-claude-sonnet-4-6",
  "opus": "copilot-claude-opus-4-6",
  "gpt5.4": "copilot-gpt-5-4",
  "gpt-5.4": "copilot-gpt-5-4",
  "gemini": "copilot-gemini-3-pro-preview",
  "gemini-3-pro-preview": "copilot-gemini-3-pro-preview"
}
```

**`modeTiers` section** — add `"copilot"` to each tier:

```json
"performance": { "copilot": "flagship" },
"balanced":    { "copilot": "default" },
"economy":     { "copilot": "fast" },
"custom":      { "copilot": "default" }
```

> `performance` maps to `flagship` (Opus 4.6) for maximum quality. `balanced` and `economy` both use Sonnet 4.6 since all models cost the same quota-wise and Sonnet covers most tasks well.

**`roles` section** — add three roles to support per-task model selection:

```json
"copilot": {
  "agent": "copilot",
  "model": null,
  "reasoningEffort": null
},
"copilot-reviewer": {
  "agent": "copilot",
  "model": "copilot-claude-sonnet-4-6",
  "reasoningEffort": null
},
"copilot-architect": {
  "agent": "copilot",
  "model": "copilot-claude-opus-4-6",
  "reasoningEffort": null
}
```

---

## Task 6: Setup & CLI Detection — `lib/hydra-setup.mjs`

**Files:**

- `lib/hydra-setup.mjs` — Add Copilot CLI detection and MCP registration

### Step 1: CLI Detection

Add `copilot` to `detectInstalledCLIs()`:

```javascript
export function detectInstalledCLIs() {
  return {
    claude: commandExists('claude'),
    gemini: commandExists('gemini'),
    codex: commandExists('codex'),
    copilot: commandExists('copilot'), // ← add this
  };
}
```

### Step 2: MCP Registration for Copilot

> **Post-plugin-refactor note:** `registerCustomAgentMcp({ configPath, format })` already exists in `hydra-setup.mjs` and handles JSON config files generically. For Copilot, we can either:
>
> 1. **Reuse `registerCustomAgentMcp()`** with `configPath: ~/.copilot/mcp-config.json` and `format: 'json'` — simplest approach
> 2. **Add a dedicated `mergeCopilotConfig()`** — gives more control over Copilot-specific entry format (e.g. `description` field)
>
> **Recommended:** Option 2 for the initial implementation (Copilot's MCP format includes a `description` field that `registerCustomAgentMcp()` doesn't handle). Also add `copilot` to `KNOWN_CLI_MCP_PATHS`:

```javascript
export const KNOWN_CLI_MCP_PATHS = {
  gh: null,
  aider: null,
  continue: '.continue/config.json',
  copilot: '.copilot/mcp-config.json', // ← add this (user-level: ~/.copilot/mcp-config.json)
};
```

Add `mergeCopilotConfig()`:

```javascript
/**
 * Register Hydra MCP server with GitHub Copilot CLI.
 * Config file: ~/.copilot/mcp-config.json
 */
export function mergeCopilotConfig(mcpEntry, opts = {}) {
  const configPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');
  let config = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // Corrupt config — start fresh
    }
  }

  if (!config.mcpServers) config.mcpServers = {};

  if (opts.uninstall) {
    delete config.mcpServers['hydra'];
  } else {
    if (!opts.force && config.mcpServers['hydra']) {
      return { status: 'already_registered', path: configPath };
    }
    config.mcpServers['hydra'] = mcpEntry;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { status: opts.uninstall ? 'unregistered' : 'registered', path: configPath };
}
```

**MCP entry format** for Copilot:

```javascript
{
  command: resolveNodePath(),
  args: [resolveMcpServerPath()],
  description: 'Hydra multi-agent orchestration',
}
```

### Step 3: Wire Into `main()` Setup Flow

In the `setup` command handler, add Copilot detection + registration alongside the existing Claude/Gemini/Codex entries.

---

## Task 7: Tandem Pair Routing — `lib/hydra-utils.mjs`

**Files:**

- `lib/hydra-utils.mjs` — Add Copilot to `selectTandemPair()` task type matrix

Copilot is well-suited as a **follow** agent for review and documentation tasks (it has GitHub context to enrich feedback):

```javascript
// In selectTandemPair() task type matrix:
review: { lead: 'gemini', follow: 'copilot' },       // Gemini finds issues, Copilot adds GitHub context
documentation: { lead: 'claude', follow: 'copilot' }, // Claude writes, Copilot adds GitHub workflow notes
```

> **Note:** Keep existing pairs as defaults. Add Copilot pairs as alternatives that activate when Copilot is enabled and available.

---

## Task 8: Council Role — `lib/hydra-council.mjs`

**Files:**

- `lib/hydra-council.mjs` — Add Copilot as optional 4th council participant

In the adversarial council mode (`'adversarial'`), Copilot can participate in the **DIVERGE** phase (independent answers) when enabled. It contributes GitHub integration perspective that the other three agents cannot provide.

**What to add:** An optional `copilotEnabled` check in the council phase builder that adds Copilot to the parallel DIVERGE agents when the `copilot` agent is registered and available.

This is **optional** — council can function with 3 agents. Copilot participation is additive only.

---

## Task 9: Documentation — `COPILOT.md`

**Files:**

- `COPILOT.md` — Agent instructions for Copilot (root level, matching `CLAUDE.md` / `GEMINI.md` / `AGENTS.md` pattern)

The file should:

1. Explain Copilot's role in the Hydra orchestration system (`advisor`)
2. Document how to check for handoffs (`hydra_handoffs_pending` with `agent: "copilot"`)
3. Document how to claim and report on tasks
4. Reference Copilot's unique strengths (GitHub integration, MCP-native)
5. Include instructions for authentication (`GH_TOKEN` env var)

---

## Task 10: README & CLAUDE.md Updates

**Files:**

- `README.md` — Add Copilot to agent table, prerequisites, install step
- `CLAUDE.md` — Update Architecture section to show 5 agents; update `detectInstalledCLIs()` reference; add Copilot plugin fields to agent conventions

---

## Implementation Phases

> **Post-plugin-refactor impact:** The plugin architecture eliminates Task 3 entirely (no executor changes needed) and simplifies Phase 1 significantly. Adding a new agent is now primarily a definition + config + UI task.

### Phase 1 — Core Agent (Must-Have)

Tasks 1, 2 (agent definition with full plugin interface, UI colors/icon). This is the minimum viable integration: Copilot appears in the registry with all plugin fields populated, renders with proper colors/icons, and can be dispatched via the data-driven executor. The plugin architecture means **no executor, metrics, usage, or recovery changes are needed** — just the `PHYSICAL_AGENTS` entry.

### Phase 2 — Full Config Integration (Should-Have)

Tasks 4, 5, 6 (model profiles, config, setup). Adds model-aware routing, tier support, and `hydra setup` registration of Copilot's MCP config. Leverages existing `KNOWN_CLI_MCP_PATHS` and `registerCustomAgentMcp()` infrastructure from the custom agents work.

### Phase 3 — Routing & Council (Nice-to-Have)

Tasks 7, 8 (tandem pairs, council participation). Upgrades Copilot from passive participant to active routing target.

### Phase 4 — Documentation (Must-Have)

Tasks 9, 10 (COPILOT.md, README/CLAUDE.md updates). Required before merging.

### Phase 5 — Dynamic Dispatch & Extensibility (See separate plan)

Task 11 (below) is the Phase 1 prerequisite from the dynamic dispatch plan. The broader work —
role-configurable dispatch, registry-driven CLI detection, availability-filtered routing — is
tracked in **[`2026-03-10-dynamic-agent-dispatch.md`](./2026-03-10-dynamic-agent-dispatch.md)**.
That plan's implementation phases are independent of this integration and can proceed in parallel.

---

## Task 11: Fix `invoke.headless()` Model ID Translation

**Files:** `lib/hydra-model-profiles.mjs`, `lib/hydra-agents.mjs` (Copilot plugin)

**Prerequisite for:** Task 1 (Copilot agent definition). Must be done before Copilot can be used
with `--model` flag in headless mode.

**Problem:**  
The executor calls `invoke.headless(prompt, { model: getActiveModel('copilot') })`. `getActiveModel`
returns the Hydra internal model ID (e.g. `copilot-claude-sonnet-4-6`), but the CLI `--model` flag
requires the actual CLI model ID (e.g. `claude-sonnet-4.6`). Passing the Hydra internal ID to
`--model` results in "unknown model" errors.

This is Copilot-specific because existing agents (`claude`, `gemini`, `codex`) happen to use the
same identifier for both. Copilot's internal IDs are prefixed (`copilot-*`) to avoid collision.

**Solution:**  
Add `resolveCliModelId(modelId)` to `lib/hydra-model-profiles.mjs` that returns
`MODEL_PROFILES[modelId]?.cliModelId ?? modelId`. Apply it in Copilot's `invoke.headless()`:

```javascript
import { resolveCliModelId } from '../hydra-model-profiles.mjs';

headless: (prompt, opts = {}) => {
  const args = ['-p', prompt, '--output-format', 'json', '--silent', '--no-ask-user'];
  if (opts.model) args.push('--model', resolveCliModelId(opts.model));
  // ...
  return ['copilot', args];
},
```

Each `MODEL_PROFILES` entry for a Copilot model carries a `cliModelId` field:

```javascript
'copilot-claude-sonnet-4-6': {
  name: 'Claude Sonnet 4.6 (via Copilot)',
  agent: 'copilot',
  tier: 'default',
  contextWindow: 200000,
  cliModelId: 'claude-sonnet-4.6',     // ← CLI flag value (dots, not hyphens)
},
'copilot-gemini-3-pro-preview': {
  name: 'Gemini 3 Pro Preview (via Copilot)',
  agent: 'copilot',
  tier: 'premium',
  contextWindow: 1000000,
  cliModelId: 'gemini-3-pro-preview',  // ← matches live --model choice
},
// ...
```

`resolveCliModelId` falls back to the input value unchanged, so existing agents (`claude`, `gemini`,
`codex`) that already use the correct CLI IDs require **no changes**.

> This pattern is now the **documented convention** for all future agent plugins. See
> [Task E in `2026-03-10-dynamic-agent-dispatch.md`](./2026-03-10-dynamic-agent-dispatch.md#task-e-extensibility-contract--future-agent-guide)
> for the extensibility contract every new agent must follow.

**Tests:**

```javascript
describe('resolveCliModelId', () => {
  it('returns cliModelId when present in MODEL_PROFILES', () => {
    // Copilot internal ID → CLI flag value
    assert.equal(resolveCliModelId('copilot-claude-sonnet-4-6'), 'claude-sonnet-4.6');
    assert.equal(resolveCliModelId('copilot-gemini-3-pro-preview'), 'gemini-3-pro-preview');
    assert.equal(resolveCliModelId('copilot-gpt-5-4'), 'gpt-5.4');
  });

  it('returns input unchanged for IDs already matching CLI format', () => {
    // Existing agents — IDs are their own cliModelId
    assert.equal(resolveCliModelId('claude-sonnet-4.6'), 'claude-sonnet-4.6');
    assert.equal(resolveCliModelId('gpt-5.4'), 'gpt-5.4');
  });

  it('returns input unchanged for unknown IDs (safe fallback)', () => {
    assert.equal(resolveCliModelId('some-unknown-model'), 'some-unknown-model');
  });
});
```

---

## Known Risks & Open Questions

| Risk                                    | Severity   | Mitigation                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~No JSON output from `copilot -p`~~    | ~~Medium~~ | **RESOLVED** — `--output-format json` is live. Output is JSONL (event stream). `parseOutput()` parses line-by-line; see Task 1 for schema details.                                                                                                                                                                                  |
| `cliModelId` values                     | **Low**    | **VALIDATED** against live `--model` choices. Claude uses dots (`claude-sonnet-4.6`); Gemini is `gemini-3-pro-preview`. Keep in sync with CLI version.                                                                                                                                                                              |
| Auth flow in CI/headless                | **High**   | Require `GH_TOKEN` env var; document clearly; skip Copilot tasks when not authenticated                                                                                                                                                                                                                                             |
| Premium request quota limits            | **Medium** | `modelBelongsTo()` plugin method enables `hydra-usage.mjs` tracking automatically; `premiumRequests` from JSONL `result` event provides usage data                                                                                                                                                                                  |
| Copilot CLI still in preview            | **Medium** | Pin to versioned install; monitor changelog for breaking changes (especially JSONL schema evolution)                                                                                                                                                                                                                                |
| `--allow-all-tools` security            | **Medium** | Only used when `permissionMode === 'full-auto'`; handled by `invoke.headless()` — default is no allow flags                                                                                                                                                                                                                         |
| Windows `copilot` binary path           | **Low**    | Use `cross-spawn` (already used for all agents via `features.executeMode: 'spawn'`); test with WinGet install                                                                                                                                                                                                                       |
| JSONL schema versioning                 | **Medium** | Copilot CLI updates may change event types silently; `parseOutput` returns empty string with no warning. Add assertion: if no `assistant.message` event found after full stream, log a `warn` with the raw first 200 chars for debugging. Pin CLI version in CI.                                                                    |
| Copilot installed but not authenticated | **Medium** | `detectInstalledCLIs()` checks binary existence only; an unauthenticated Copilot install routes tasks then fails. Extend `quotaVerify()` in the Copilot plugin to run `copilot auth status` (or check `~/.copilot/token` existence) and return `{ verified: false, status: 'unauthenticated', reason: 'Run: copilot auth login' }`. |

---

## Testing Strategy

Tests follow the existing `node:test` + `node:assert/strict` pattern.

### Unit Tests — `test/hydra-agents-copilot.test.mjs`

```javascript
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('copilot agent definition', () => {
  let initAgentRegistry, getAgent;

  before(async () => {
    ({ initAgentRegistry, getAgent } = await import('../lib/hydra-agents.mjs'));
    initAgentRegistry();
  });

  it('registers copilot as a physical agent', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.type, 'physical');
    assert.equal(agent.cli, 'copilot');
  });

  // ── Plugin interface tests ──────────────────────────────────────
  // These verify the data-driven plugin fields that the executor,
  // metrics, usage, and recovery modules consume.

  it('has complete features object', () => {
    const agent = getAgent('copilot');
    assert.equal(typeof agent.features, 'object');
    assert.equal(agent.features.executeMode, 'spawn');
    assert.equal(agent.features.jsonOutput, true); // --output-format json is live
    assert.equal(agent.features.stdinPrompt, false);
    assert.equal(agent.features.reasoningEffort, false);
  });

  it('parseOutput returns correct shape for plain text', () => {
    const agent = getAgent('copilot');
    const result = agent.parseOutput('some text output');
    assert.ok('output' in result);
    assert.ok('tokenUsage' in result);
    assert.ok('costUsd' in result);
    assert.equal(result.output, 'some text output');
    assert.equal(result.tokenUsage, null);
    assert.equal(result.costUsd, null);
  });

  it('parseOutput parses JSONL and extracts last assistant.message content', () => {
    const agent = getAgent('copilot');
    const events = [
      { type: 'assistant.turn_start', data: { turnId: '0' } },
      {
        type: 'assistant.message',
        data: {
          messageId: 'a',
          content: 'Hello! 👋 How can I help?',
          toolRequests: [],
          outputTokens: 10,
        },
      },
      { type: 'assistant.turn_end', data: { turnId: '0' } },
      {
        type: 'result',
        timestamp: '2026-03-10T00:00:00Z',
        usage: { premiumRequests: 1, totalApiDurationMs: 2000 },
      },
    ];
    const stdout = events.map((e) => JSON.stringify(e)).join('\n');
    const result = agent.parseOutput(stdout, { jsonOutput: true });
    assert.equal(result.output, 'Hello! 👋 How can I help?');
    assert.deepEqual(result.tokenUsage, { premiumRequests: 1 });
    assert.equal(result.costUsd, null);
  });

  it('parseOutput falls back to raw stdout on bad JSON', () => {
    const agent = getAgent('copilot');
    const result = agent.parseOutput('not json', { jsonOutput: true });
    assert.equal(result.output, 'not json');
  });

  it('modelBelongsTo matches copilot- prefixed models', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.modelBelongsTo('copilot-claude-sonnet-4-6'), true);
    assert.equal(agent.modelBelongsTo('copilot-gpt-5-4'), true);
    assert.equal(agent.modelBelongsTo('claude-opus-4-6'), false);
    assert.equal(agent.modelBelongsTo('gpt-5.4'), false);
  });

  it('quotaVerify returns null (GitHub-managed)', async () => {
    const agent = getAgent('copilot');
    const result = await agent.quotaVerify();
    assert.equal(result, null);
  });

  it('economyModel returns copilot-claude-sonnet-4-6', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.economyModel(), 'copilot-claude-sonnet-4-6');
  });

  it('readInstructions returns string containing the file path', () => {
    const agent = getAgent('copilot');
    const result = agent.readInstructions('COPILOT.md');
    assert.ok(result.includes('COPILOT.md'));
  });

  it('taskRules is a non-empty array', () => {
    const agent = getAgent('copilot');
    assert.ok(Array.isArray(agent.taskRules));
    assert.ok(agent.taskRules.length > 0);
  });

  it('errorPatterns has expected keys', () => {
    const agent = getAgent('copilot');
    assert.ok(agent.errorPatterns.authRequired instanceof RegExp);
    assert.ok(agent.errorPatterns.rateLimited instanceof RegExp);
    assert.ok(agent.errorPatterns.quotaExhausted instanceof RegExp);
    assert.ok(agent.errorPatterns.networkError instanceof RegExp);
  });

  // ── Invoke tests ────────────────────────────────────────────────

  it('headless plan mode uses -p flag with prompt, --silent, and no allow flags', () => {
    const agent = getAgent('copilot');
    const [cmd, args] = agent.invoke.headless('test prompt', { permissionMode: 'plan' });
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('test prompt'), 'Missing prompt in args');
    assert.ok(args.includes('--silent'), 'Missing --silent flag');
    assert.ok(args.includes('--no-ask-user'), 'Missing --no-ask-user flag');
    assert.ok(!args.includes('--allow-all-tools'), 'Unexpected --allow-all-tools in plan mode');
    assert.ok(
      !args.some((a) => a.startsWith('--allow-tool')),
      'Unexpected --allow-tool in plan mode',
    );
  });

  it('headless passes --model when opts.model provided', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke.headless('test prompt', { model: 'claude-sonnet-4-6' });
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx !== -1, 'Missing --model flag');
    assert.equal(args[modelIdx + 1], 'claude-sonnet-4-6');
  });

  it('headless does NOT pass --model when opts.model is omitted', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke.headless('test prompt', {});
    assert.ok(!args.includes('--model'), 'Unexpected --model flag when no model specified');
  });

  it('headless always passes --output-format json by default (features.jsonOutput: true)', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke.headless('test prompt', {});
    assert.ok(args.includes('--output-format'), 'Missing --output-format');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  });

  it('headless omits --output-format when opts.jsonOutput explicitly false', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke.headless('test prompt', { jsonOutput: false });
    assert.ok(
      !args.includes('--output-format'),
      'Unexpected --output-format when jsonOutput false',
    );
  });

  it('headless full-auto uses --allow-all-tools', () => {
    const agent = getAgent('copilot');
    const [cmd, args] = agent.invoke.headless('test prompt', { permissionMode: 'full-auto' });
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('--allow-all-tools'), 'Missing --allow-all-tools in full-auto mode');
  });

  it('headless auto-edit uses specific allow-tool flags', () => {
    const agent = getAgent('copilot');
    const [cmd, args] = agent.invoke.headless('test prompt', { permissionMode: 'auto-edit' });
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('--allow-tool'), 'Missing --allow-tool in auto-edit mode');
    assert.ok(
      !args.includes('--allow-all-tools'),
      'Unexpected --allow-all-tools in auto-edit mode',
    );
  });

  it('has required taskAffinity keys', () => {
    const agent = getAgent('copilot');
    const requiredKeys = [
      'planning',
      'architecture',
      'review',
      'refactor',
      'implementation',
      'analysis',
      'testing',
      'research',
      'documentation',
      'security',
    ];
    for (const key of requiredKeys) {
      assert.ok(key in agent.taskAffinity, `Missing affinity key: ${key}`);
    }
  });
});
```

### UI Tests — extend `test/hydra-ui.test.mjs`

```javascript
it('copilot has a registered color', () => {
  assert.ok(AGENT_COLORS.copilot, 'Missing AGENT_COLORS.copilot');
  assert.equal(typeof AGENT_COLORS.copilot, 'function');
});

it('copilot has a registered icon', () => {
  assert.ok(AGENT_ICONS.copilot, 'Missing AGENT_ICONS.copilot');
  assert.ok(AGENT_ICONS.copilot.length > 0);
});
```

### Setup Tests — extend `test/hydra-setup.test.mjs`

```javascript
it('detectInstalledCLIs includes copilot key', () => {
  const result = detectInstalledCLIs();
  assert.ok('copilot' in result, 'Missing copilot key from detectInstalledCLIs()');
  assert.equal(typeof result.copilot, 'boolean');
});
```

---

## Appendix: Copilot CLI Flag Reference

Key flags for Hydra integration (from `copilot --help`):

```
copilot [options]

Core programmatic flags:
  -p, --prompt <text>              Run non-interactively with the given prompt
  -s, --silent                     Output only the agent response (no stats) — use with -p for scripting
  --output-format <format>         Output format: 'text' (default) or 'json' (JSONL, one event per line)
  --model <model>                  Set the AI model (validated choices below)
  --no-ask-user                    Disable the ask_user tool (agent works autonomously)
  --autopilot                      Enable autopilot continuation in prompt mode
  --max-autopilot-continues <n>    Maximum continuation messages in autopilot mode

Permission flags:
  --allow-all-tools                Allow all tools without confirmation (env: COPILOT_ALLOW_ALL)
  --allow-all                      Shorthand: --allow-all-tools --allow-all-paths --allow-all-urls
  --yolo                           Alias for --allow-all
  --allow-tool [tools...]          Allow specific tools (e.g. 'shell(git:*)', 'write')
  --deny-tool [tools...]           Deny specific tools
  --allow-all-paths                Allow access to any file path
  --allow-all-urls                 Allow access to all URLs
  --allow-url [urls...]            Allow specific URLs or domains
  --deny-url [urls...]             Deny specific URLs

Directory / path:
  --add-dir <directory>            Add allowed directory (can be used multiple times)
  --config-dir <directory>         Set config directory (default: ~/.copilot)

MCP:
  --additional-mcp-config <json>   Additional MCP servers as JSON string or @filepath
  --add-github-mcp-tool <tool>     Enable GitHub MCP tool (or '*' for all)
  --add-github-mcp-toolset <set>   Enable GitHub MCP toolset (or 'all')
  --enable-all-github-mcp-tools    Enable all GitHub MCP tools
  --disable-builtin-mcps           Disable all built-in MCP servers
  --disable-mcp-server <name>      Disable a specific MCP server

Session:
  -i, --interactive <prompt>       Start interactive mode and execute prompt
  --continue                       Resume most recent session
  --resume [sessionId]             Resume previous session
  --stream <mode>                  Enable/disable streaming (on|off)
  --acp                            Start as Agent Client Protocol server

Output / logging:
  --no-color                       Disable all color output
  --log-level <level>              Log level: none|error|warning|info|debug|all
  --log-dir <directory>            Log file directory

Validated --model choices (as of 2026-03-10):
  claude-sonnet-4.6    claude-sonnet-4.5    claude-haiku-4.5
  claude-opus-4.6      claude-opus-4.6-fast claude-opus-4.5    claude-sonnet-4
  gemini-3-pro-preview
  gpt-5.4   gpt-5.3-codex  gpt-5.2-codex  gpt-5.2
  gpt-5.1-codex-max  gpt-5.1-codex  gpt-5.1  gpt-5.1-codex-mini  gpt-5-mini  gpt-4.1

Interactive slash commands:
  /login        Authenticate with GitHub
  /logout       Remove credentials
  /model        Switch active model
  /compact      Compress conversation context
  /context      Show token usage breakdown
  /lsp          Show LSP server status
  /feedback     Submit feedback survey
  /experimental Toggle experimental mode
```

---

## Appendix: Copilot MCP Config Reference

GitHub Copilot CLI supports two MCP config scopes:

**User-level** (`~/.copilot/mcp-config.json`):

```json
{
  "mcpServers": {
    "hydra": {
      "command": "node",
      "args": ["/absolute/path/to/hydra-mcp-server.mjs"],
      "description": "Hydra multi-agent orchestration"
    }
  }
}
```

**Project-level** (`.github/mcp.json` in repository root):

```json
{
  "mcpServers": {
    "hydra": {
      "command": "node",
      "args": ["/absolute/path/to/hydra-mcp-server.mjs"],
      "description": "Hydra multi-agent orchestration"
    }
  }
}
```

**Per-session injection** (no file edit needed, good for CI):

```bash
copilot -p "..." --additional-mcp-config '{"mcpServers":{"hydra":{"command":"node","args":["/path/to/hydra-mcp-server.mjs"]}}}'
# Or from file:
copilot -p "..." --additional-mcp-config @/path/to/mcp-entry.json
```

The project-level config allows teams to automatically give Copilot access to Hydra's MCP tools without each developer needing to set up the user-level config. The `hydra init` command (from `hydra-setup.mjs`) could optionally write this file when initializing a project.

---

## Related Plans

- [`2026-03-10-dynamic-agent-dispatch.md`](./2026-03-10-dynamic-agent-dispatch.md) — Makes dispatch
  role-configurable and adds extensibility contract for future agents (opencode, etc.). Task 11
  above (the `resolveCliModelId` helper) is Phase 1 of that plan and also a prerequisite for this
  integration's Task 1.
- [`2026-03-08-agent-plugin-refactor.md`](./2026-03-08-agent-plugin-refactor.md) — The data-driven
  plugin architecture that eliminates the need for executor changes in this integration.

---

_Document created: 2026-03-07_
_Updated: 2026-03-08 — expanded model set (Sonnet 4.6, Opus 4.6, GPT-5.4, Gemini 3.1 Pro); added --model flag to invoke functions; added features.jsonOutput gate for upcoming JSON output mode; added per-role model assignments (copilot-reviewer, copilot-architect); downgraded JSON output risk from High to Medium_
_Updated: 2026-03-10 — aligned with agent plugin refactor (2026-03-08). Task 1 now includes full plugin interface (features, parseOutput, errorPatterns, modelBelongsTo, quotaVerify, economyModel, readInstructions, taskRules). Task 3 eliminated — no executor changes needed. Task 6 updated to leverage existing registerCustomAgentMcp() infra. Tests expanded to cover all plugin fields. Implementation phases simplified._
_Updated: 2026-03-10 (v2) — validated against live CLI. **`--output-format json` is now live** (JSONL event stream). `features.jsonOutput` set to `true`. `parseOutput()` rewritten for JSONL schema (assistant.message content + result.usage.premiumRequests). `cliModelId` values validated: Claude uses dots (`claude-sonnet-4.6`), Gemini is `gemini-3-pro-preview`. MCP config path corrected to `~/.copilot/mcp-config.json`. Added `--silent`, `--no-ask-user` to headless invocation. Auto-edit permission flags updated to `shell(git:*)` / `write`. Risk table updated: JSON output risk resolved, cliModelId risk downgraded to Low. Appendix flag reference rewritten from live `--help` output._
_Updated: 2026-03-10 (v3) — Added Task 11 (`resolveCliModelId` translation helper — prerequisite for Task 1). Added Phase 5 reference to dynamic dispatch plan. Added Related Plans section linking to `2026-03-10-dynamic-agent-dispatch.md`._
_Status: **Ready for implementation** — all CLI options validated against live binary_
