# GitHub Copilot CLI Integration — Planning Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate [GitHub Copilot CLI](https://github.com/github/copilot-cli) as a fourth physical agent in Hydra, enabling `copilot` alongside `claude`, `gemini`, and `codex` in all dispatch modes, council deliberation, worker pools, and MCP tooling.

**Architecture:** Add `copilot` as a new `PHYSICAL_AGENTS` entry in `hydra-agents.mjs`, wire it into `hydra-ui.mjs` for colored output, register it in `hydra-model-profiles.mjs` and `hydra.config.json`, add CLI detection in `hydra-setup.mjs`, and create a `COPILOT.md` agent instructions file. The agent's council role is **advisor** — it brings GitHub-integrated context (issues, PRs, CI) that the other three agents lack.

**Tech Stack:** Node.js ESM, `copilot` CLI binary (GitHub Copilot CLI), existing Hydra agent infrastructure. No new npm dependencies.

---

## Background: GitHub Copilot CLI

GitHub Copilot CLI (`copilot`) is a terminal-native agentic coding assistant backed by GitHub's Copilot service. Key properties relevant to Hydra:

| Property                  | Value                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Binary**                | `copilot`                                                                                                         |
| **npm package**           | `@github/copilot`                                                                                                 |
| **Install (macOS/Linux)** | `curl -fsSL https://gh.io/copilot-install \| bash` or `brew install copilot-cli`                                  |
| **Install (Windows)**     | `winget install GitHub.Copilot`                                                                                   |
| **Install (npm)**         | `npm install -g @github/copilot`                                                                                  |
| **Auth requirement**      | GitHub account with active Copilot subscription; `GH_TOKEN`/`GITHUB_TOKEN` env var for PAT auth                   |
| **Default model**         | Claude Sonnet 4.5 (as of March 2026)                                                                              |
| **Other models**          | GPT-5 (selectable via `/model` slash command)                                                                     |
| **MCP support**           | Ships with GitHub MCP server built-in; accepts custom MCP servers via `~/.copilot/mcp.json` or `.github/mcp.json` |
| **LSP support**           | Language Server Protocol via `~/.copilot/lsp-config.json`                                                         |
| **Custom instructions**   | Via `.github/copilot-instructions.md` (project-level)                                                             |
| **Context window**        | ~128K tokens (Claude Sonnet 4.5 base)                                                                             |

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

# Pipe options from a script
./generate-options.sh | copilot

# With tool approval (required for file modification in programmatic mode)
copilot -p "refactor auth.js" --allow-all-tools
copilot -p "show commits" --allow-tool 'shell(git)'
```

**Approval flags** (permission model, maps to Hydra's `permissionMode`):

| Hydra `permissionMode` | Copilot flag                                     | Behavior                         |
| ---------------------- | ------------------------------------------------ | -------------------------------- |
| `plan`                 | _(none — interactive approval required)_         | Asks before each tool use        |
| `auto-edit`            | `--allow-tool 'shell(*)' --allow-tool 'file(*)'` | Allow file + shell, one session  |
| `full-auto`            | `--allow-all-tools`                              | Allow all tools without approval |

### Known Limitations for Headless Integration

> **⚠️ Investigation Required:** At time of writing, it is not confirmed that `copilot -p` supports a machine-readable JSON output format (`--output-format json` equivalent). The programmatic mode outputs human-readable markdown/text. This is the primary technical risk for Hydra integration.

Mitigation options:

1. **Text parsing** — Parse natural language output (fragile, not recommended)
2. **Wait for upstream** — Monitor Copilot CLI changelog for JSON/structured output support
3. **Wrapper mode** — Execute `copilot -p` and capture stdout as raw markdown (like Gemini's text-based output)
4. **MCP-only mode** — Expose Copilot via Hydra's MCP server as a tool, not a headless agent

The recommended approach is **option 3** for the initial implementation: treat `copilot` output as text (similar to how Gemini's output is handled when JSON mode is unavailable), then upgrade to structured output once the CLI supports it.

---

## Reference: Copilot CLI Config Locations

### MCP Server Registration

- **File:** `~/.copilot/mcp.json` (user-level) or `.github/mcp.json` (project-level)
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

- `lib/hydra-agents.mjs` — Add `copilot` entry to `PHYSICAL_AGENTS`

**What to add** — insert after `codex` in the `PHYSICAL_AGENTS` object:

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
    nonInteractive: (prompt, opts = {}) => {
      const args = ['-p', prompt];
      // opts.model = cliModelId from MODEL_PROFILES entry (e.g. 'claude-sonnet-4-6')
      if (opts.model) args.push('--model', opts.model);
      return ['copilot', args];
    },
    interactive: (prompt) => ['copilot', [prompt]],
    headless: (prompt, opts = {}) => {
      const args = ['-p', prompt];
      // opts.model resolved by agent-executor via getCopilotCliModelId()
      if (opts.model) args.push('--model', opts.model);
      // JSON output — gated on features.jsonOutput; false until CLI ships the flag
      if (opts.jsonOutput) args.push('--output-format', 'json');
      if (opts.permissionMode === 'full-auto') {
        args.push('--allow-all-tools');
      } else if (opts.permissionMode === 'auto-edit') {
        args.push('--allow-tool', 'shell(*)', '--allow-tool', 'file(*)');
      }
      // Default (plan): no --allow flags; Copilot will prompt interactively
      return ['copilot', args];
    },
  },
  contextBudget: 128_000,
  contextTier: 'medium',
  // Feature flags — flip jsonOutput to true when Copilot CLI ships --output-format json
  features: {
    jsonOutput: false,
  },
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
    'no-json-output',          // features.jsonOutput: false — upgrade when CLI ships --output-format json
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
4. **Practical Suggestions**: Prioritize actionable changes over theoretical improvements. Provide `git`/`gh` CLI commands the team can run immediately.

Output structure: GitHub context summary → Actionable suggestions → Commands to run.`,
  timeout: 7 * 60 * 1000,
  tags: ['github', 'integration', 'copilot', 'advisory'],
  enabled: true,
},
```

**Also update** `initAgentRegistry()` output-format detection in `hydra-shared/agent-executor.mjs` to handle Copilot's text-only output (see Task 3). Also add `getCopilotCliModelId(profileKey)` helper that returns `MODEL_PROFILES[profileKey]?.cliModelId ?? profileKey`.

---

## Task 2: UI Integration — `lib/hydra-ui.mjs`

**Files:**

- `lib/hydra-ui.mjs` — Add Copilot color and icon

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

## Task 3: Output Parsing — `lib/hydra-shared/agent-executor.mjs`

**Files:**

- `lib/hydra-shared/agent-executor.mjs` — Add Copilot-specific output handling

**Context:** Copilot CLI currently has no `--output-format json` flag — output is markdown/text. JSON output mode is planned for the next Copilot CLI release and is pre-wired via `features.jsonOutput` (see Task 1). The executor needs to handle both the current text path and the future JSON upgrade path.

**What to change:**

In the agent invocation detection block, ensure `useStdin` is `false` for Copilot (it uses `-p` flag, not stdin piping):

```javascript
// In the agent → stdin/flag routing
if (agent === 'copilot') {
  useStdin = false; // Copilot uses -p flag, not stdin
}
```

Add model resolution before building args. Resolve the `cliModelId` from the active profile:

```javascript
// After: const effectiveModel = modelOverride || getActiveModel(agent) || 'unknown';
// Add for copilot:
if (agent === 'copilot') {
  const copilotProfile = MODEL_PROFILES[effectiveModel];
  opts.model = copilotProfile?.cliModelId ?? effectiveModel;
  opts.jsonOutput = getAgent('copilot')?.features?.jsonOutput ?? false;
}
```

In the output parsing section, add a Copilot branch:

```javascript
if (agent === 'copilot') {
  if (opts.jsonOutput) {
    // Future: parse structured JSON output once CLI ships --output-format json
    // Expected shape: { result: { output: string, ... } } — validate when available
    try {
      const parsed = JSON.parse(stdout);
      result.output = parsed?.result?.output ?? parsed?.output ?? stdout;
    } catch {
      result.output = stdout; // Graceful fallback if JSON parse fails
    }
  } else {
    // Current: treat stdout as plain text (same as Gemini text mode)
    result.output = stdout;
  }
}
```

**Copilot error detection** — add to `AGENT_ERROR_PATTERNS`:

```javascript
copilot: {
  authRequired: /not logged in|authentication required|copilot subscription|no copilot access/i,
  rateLimited: /rate limit|quota exceeded|too many requests/i,
  networkError: /network error|connection refused|ECONNREFUSED/i,
  subscriptionRequired: /copilot plan required|upgrade your plan/i,
  quotaExhausted: /premium request.*limit|monthly.*quota.*exceeded/i,
}
```

---

## Task 4: Model Profiles — `lib/hydra-model-profiles.mjs`

**Files:**

- `lib/hydra-model-profiles.mjs` — Add Copilot model entries

**What to add** to `MODEL_PROFILES`:

> **Note on model IDs:** The `id` field is Hydra's internal profile key (prefixed `copilot-`). The `cliModelId` field is the actual value passed to `copilot --model <id>`. These may differ — validate against `copilot /model` output when the CLI is available.

> **Note on rate limits:** All rate limit values below are estimates. Copilot subscription tiers (Individual = tier 1, Business = tier 2, Enterprise = tier 3) share quota pools across models. The rpm/tpm values reflect sustained throughput, not monthly premium-request quota. Update from GitHub's official rate limit documentation when published.

```javascript
'copilot-claude-sonnet-4-6': {
  id: 'copilot-claude-sonnet-4-6',
  cliModelId: 'claude-sonnet-4-6',         // value passed to copilot --model
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
  cliModelId: 'claude-opus-4-6',           // value passed to copilot --model
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
'copilot-gemini-3-1-pro': {
  id: 'copilot-gemini-3-1-pro',
  cliModelId: 'gemini-3.1-pro',            // value passed to copilot --model
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
  "gemini": "copilot-gemini-3-1-pro"
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

Copilot CLI stores MCP config at `~/.copilot/mcp.json` (user-level). Add a new `mergeCopilotConfig()` function:

```javascript
/**
 * Register Hydra MCP server with GitHub Copilot CLI.
 * Config file: ~/.copilot/mcp.json
 */
export function mergeCopilotConfig(mcpEntry, opts = {}) {
  const configPath = path.join(os.homedir(), '.copilot', 'mcp.json');
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
- `CLAUDE.md` — Update Architecture section to show 4 agents; update `detectInstalledCLIs()` reference

---

## Implementation Phases

### Phase 1 — Core Agent (Must-Have)

Tasks 1, 2, 3 (agent definition, UI, output parsing). This is the minimum viable integration: Copilot appears in the registry, renders with proper colors/icons, and can be dispatched. No structured output yet.

**Estimated effort:** ~2 hours

### Phase 2 — Full Config Integration (Should-Have)

Tasks 4, 5, 6 (model profiles, config, setup). Adds model-aware routing, tier support, and `hydra setup` registration of Copilot's MCP config.

**Estimated effort:** ~3 hours

### Phase 3 — Routing & Council (Nice-to-Have)

Tasks 7, 8 (tandem pairs, council participation). Upgrades Copilot from passive participant to active routing target.

**Estimated effort:** ~2 hours

### Phase 4 — Documentation (Must-Have)

Tasks 9, 10 (COPILOT.md, README/CLAUDE.md updates). Required before merging.

**Estimated effort:** ~1 hour

---

## Known Risks & Open Questions

| Risk                             | Severity   | Mitigation                                                                                                                                               |
| -------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No JSON output from `copilot -p` | **Medium** | Pre-wired via `features.jsonOutput: false`; flip to `true` and validate JSON shape when CLI ships `--output-format json`                                 |
| `cliModelId` values unverified   | **Medium** | Profile `cliModelId` fields (e.g. `'claude-sonnet-4-6'`, `'gpt-5.4'`) are assumed — validate against `copilot /model` interactive output before shipping |
| Auth flow in CI/headless         | **High**   | Require `GH_TOKEN` env var; document clearly; skip Copilot tasks when not authenticated                                                                  |
| Premium request quota limits     | **Medium** | Add Copilot to `hydra-usage.mjs` monitoring; warn when quota is low; Opus uses more quota than Sonnet                                                    |
| Copilot CLI still in preview     | **Medium** | Pin to versioned install; monitor changelog for breaking changes                                                                                         |
| `--allow-all-tools` security     | **Medium** | Only use in `full-auto` mode; default to explicit tool allowlist                                                                                         |
| Windows `copilot` binary path    | **Low**    | Use `cross-spawn` (already used for all agents); test with WinGet install                                                                                |

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

  it('headless plan mode uses -p flag with prompt and no allow flags', () => {
    const agent = getAgent('copilot');
    const [cmd, args] = agent.invoke.headless('test prompt', { permissionMode: 'plan' });
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('test prompt'), 'Missing prompt in args');
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

  it('headless does not pass --output-format json when features.jsonOutput is false', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke.headless('test prompt', { jsonOutput: false });
    assert.ok(
      !args.includes('--output-format'),
      'Unexpected --output-format when jsonOutput false',
    );
  });

  it('headless passes --output-format json when opts.jsonOutput is true', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke.headless('test prompt', { jsonOutput: true });
    assert.ok(args.includes('--output-format'), 'Missing --output-format');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
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

  it('has features.jsonOutput set to false by default', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.features?.jsonOutput, false, 'features.jsonOutput should default to false');
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

```
copilot [options] [prompt]

Options:
  -p, --prompt <text>         Run non-interactively with the given prompt
  --model <id>                Select model (e.g. claude-sonnet-4-6, gpt-5.4, gemini-3.1-pro)
  --output-format <fmt>       Output format: json (planned, not yet released)
  --allow-all-tools           Allow all tool use without approval
  --allow-tool <tool-spec>    Allow specific tool: shell(cmd), file(path)
  --banner                    Show animated welcome banner
  --experimental              Enable experimental features (Autopilot mode)
  --help                      Show help

Slash commands (interactive mode):
  /login                      Authenticate with GitHub
  /logout                     Remove credentials
  /model                      Switch active model
  /compact                    Compress conversation context
  /context                    Show token usage breakdown
  /lsp                        Show LSP server status
  /feedback                   Submit feedback survey
  /experimental               Toggle experimental mode
```

---

## Appendix: Copilot MCP Config Reference

GitHub Copilot CLI supports two MCP config scopes:

**User-level** (`~/.copilot/mcp.json`):

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

The project-level config allows teams to automatically give Copilot access to Hydra's MCP tools without each developer needing to set up the user-level config. The `hydra init` command (from `hydra-setup.mjs`) could optionally write this file when initializing a project.

---

_Document created: 2026-03-07_
_Updated: 2026-03-08 — expanded model set (Sonnet 4.6, Opus 4.6, GPT-5.4, Gemini 3.1 Pro); added --model flag to invoke functions; added features.jsonOutput gate for upcoming JSON output mode; added per-role model assignments (copilot-reviewer, copilot-architect); downgraded JSON output risk from High to Medium_
_Status: Draft — cliModelId values require validation against live Copilot CLI; --output-format json flag name TBD pending release_
