# GitHub Copilot CLI Integration — Planning Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate [GitHub Copilot CLI](https://github.com/github/copilot-cli) as a fourth physical agent in Hydra, enabling `copilot` alongside `claude`, `gemini`, and `codex` in all dispatch modes, council deliberation, worker pools, and MCP tooling.

**Architecture:** Add `copilot` as a new `PHYSICAL_AGENTS` entry in `hydra-agents.mjs`, wire it into `hydra-ui.mjs` for colored output, register it in `hydra-model-profiles.mjs` and `hydra.config.json`, add CLI detection in `hydra-setup.mjs`, and create a `COPILOT.md` agent instructions file. The agent's council role is **advisor** — it brings GitHub-integrated context (issues, PRs, CI) that the other three agents lack.

**Tech Stack:** Node.js ESM, `copilot` CLI binary (GitHub Copilot CLI), existing Hydra agent infrastructure. No new npm dependencies.

---

## Background: GitHub Copilot CLI

GitHub Copilot CLI (`copilot`) is a terminal-native agentic coding assistant backed by GitHub's Copilot service. Key properties relevant to Hydra:

| Property | Value |
|---|---|
| **Binary** | `copilot` |
| **npm package** | `@github/copilot` |
| **Install (macOS/Linux)** | `curl -fsSL https://gh.io/copilot-install \| bash` or `brew install copilot-cli` |
| **Install (Windows)** | `winget install GitHub.Copilot` |
| **Install (npm)** | `npm install -g @github/copilot` |
| **Auth requirement** | GitHub account with active Copilot subscription; `GH_TOKEN`/`GITHUB_TOKEN` env var for PAT auth |
| **Default model** | Claude Sonnet 4.5 (as of March 2026) |
| **Other models** | GPT-5 (selectable via `/model` slash command) |
| **MCP support** | Ships with GitHub MCP server built-in; accepts custom MCP servers via `~/.copilot/mcp.json` or `.github/mcp.json` |
| **LSP support** | Language Server Protocol via `~/.copilot/lsp-config.json` |
| **Custom instructions** | Via `.github/copilot-instructions.md` (project-level) |
| **Context window** | ~128K tokens (Claude Sonnet 4.5 base) |

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

| Hydra `permissionMode` | Copilot flag | Behavior |
|---|---|---|
| `plan` | _(none — interactive approval required)_ | Asks before each tool use |
| `auto-edit` | `--allow-tool 'shell(*)' --allow-tool 'file(*)'` | Allow file + shell, one session |
| `full-auto` | `--allow-all-tools` | Allow all tools without approval |

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
    nonInteractive: (prompt) => ['copilot', ['-p', prompt]],
    interactive: (prompt) => ['copilot', [prompt]],
    headless: (prompt, opts = {}) => {
      const args = ['-p', prompt];
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
  strengths: [
    'github-integration',
    'issue-pr-awareness',
    'ci-workflow',
    'code-suggestion',
    'real-time-assist',
    'mcp-native',
  ],
  weaknesses: [
    'no-json-output',          // Structured output not yet supported
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

**Also update** `initAgentRegistry()` output-format detection in `hydra-shared/agent-executor.mjs` to handle Copilot's text-only output (see Task 3).

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
  copilot: copilotBlue,   // ← add this
  human: pc.yellow,
  system: pc.blue,
};

export const AGENT_ICONS = {
  gemini: '\u2726',  // ✦
  codex: '\u058E',   // ֎
  claude: '\u274B',  // ❋
  copilot: '\u29BF', // ⦿ — circled bullet; single-codepoint, matches existing icon style
  human: '\u{1F16F}',  // 🅯
  system: '\u{1F5B3}', // 🖳
};
```

> **Note on icon:** `\u29BF` (⦿) is chosen for terminal safety — it is a single BMP codepoint consistent with the existing icon set (`✦`, `֎`, `❋`). The emoji `🦾` (`\u{1F9BE}`) is a more expressive alternative for terminals with emoji support, but it is a surrogate pair that may not render uniformly across all terminal emulators. A terminal capability check can be added later to upgrade the icon dynamically.

---

## Task 3: Output Parsing — `lib/hydra-shared/agent-executor.mjs`

**Files:**
- `lib/hydra-shared/agent-executor.mjs` — Add Copilot-specific output handling

**Context:** Copilot CLI does not support `--output-format json`. Its output is markdown/text. The executor currently parses JSON for Claude and Codex. Gemini uses `-o json` for JSON output.

**What to change:**

Locate the output parsing section in `executeAgent()` (in `lib/hydra-shared/agent-executor.mjs`, inside the `executeAgent` function after `spawnResult` is obtained) and add a Copilot branch alongside the existing Gemini text-mode handling. Copilot output should be treated as `result.output` (plain text) without JSON parsing — identical to how Gemini text mode works.

In the agent invocation detection block (search for `useStdin` assignment near the top of `executeAgent()`), ensure `useStdin` is set to `false` for Copilot (it uses `-p` flag, not stdin piping):

```javascript
// In the agent → stdin/flag routing
if (agent === 'copilot') {
  useStdin = false;  // Copilot uses -p flag, not stdin
}
```

**Copilot error detection** — add to `AGENT_ERROR_PATTERNS`:

```javascript
copilot: {
  authRequired: /not logged in|authentication required|copilot subscription|no copilot access/i,
  rateLimited: /rate limit|quota exceeded|too many requests/i,
  networkError: /network error|connection refused|ECONNREFUSED/i,
  subscriptionRequired: /copilot plan required|upgrade your plan/i,
}
```

---

## Task 4: Model Profiles — `lib/hydra-model-profiles.mjs`

**Files:**
- `lib/hydra-model-profiles.mjs` — Add Copilot model entries

**What to add** to `MODEL_PROFILES`:

```javascript
'copilot-claude-sonnet-4-5': {
  id: 'copilot-claude-sonnet-4-5',
  provider: 'github',
  agent: 'copilot',
  displayName: 'Copilot (Claude Sonnet 4.5)',
  shortName: 'copilot-sonnet',
  tier: 'mid',
  contextWindow: 128_000,
  maxOutput: 64_000,
  pricePer1M: { input: 0, output: 0 },      // Included in Copilot subscription
  costPer1K: { input: 0, output: 0 },
  tokPerSec: 60,
  ttft: 2.0,
  reasoning: { type: 'none', levels: ['off'], default: 'off' },
  benchmarks: { sweBench: 77.2 },           // Estimated — inherits Claude Sonnet 4.5 base; actual score may differ due to GitHub-specific tuning. Validate before publishing.
  qualityScore: 78,
  valueScore: 90,                            // High — subscription cost amortized
  speedScore: 28,
  strengths: ['github-integration', 'pr-awareness', 'code-suggestion', 'mcp-native'],
  bestFor: ['review', 'documentation', 'implementation', 'refactor'],
  rateLimits: {
    // Note: 'free' and tier 1 share the same *rate* limits (requests per minute /
    // tokens per minute) but differ in *monthly quota* (premium requests):
    //   free tier:  10 premium requests/month
    //   tier 1 (Individual): 300 premium requests/month
    // The rpm/tpm values below reflect sustained throughput capacity, not quota.
    // Update when GitHub publishes official rate limit documentation.
    free: { rpm: 10, tpm: 100_000 },
    1: { rpm: 10, tpm: 100_000 },           // Individual: 300 premium reqs/month quota
    2: { rpm: 30, tpm: 300_000 },           // Business/Enterprise: higher rate + quota
  },
},
'copilot-gpt-5': {
  id: 'copilot-gpt-5',
  provider: 'github',
  agent: 'copilot',
  displayName: 'Copilot (GPT-5)',
  shortName: 'copilot-gpt5',
  tier: 'flagship',
  contextWindow: 128_000,
  maxOutput: 64_000,
  pricePer1M: { input: 0, output: 0 },
  costPer1K: { input: 0, output: 0 },
  tokPerSec: 45,
  ttft: 2.5,
  reasoning: { type: 'none', levels: ['off'], default: 'off' },
  benchmarks: {},
  qualityScore: 88,
  valueScore: 90,
  speedScore: 22,
  strengths: ['github-integration', 'reasoning', 'code-generation'],
  bestFor: ['planning', 'architecture', 'complex-tasks'],
  rateLimits: {
    free: { rpm: 5, tpm: 50_000 },
    1: { rpm: 10, tpm: 100_000 },
    2: { rpm: 20, tpm: 200_000 },
  },
},
```

**Also add** to `AGENT_PRESETS`:

```javascript
copilot: {
  default: 'copilot-claude-sonnet-4-5',
  fast: 'copilot-claude-sonnet-4-5',      // Only one fast model currently available
  cheap: 'copilot-claude-sonnet-4-5',
},
```

**Also add** to `ROLE_DEFAULTS`:

```javascript
copilot: {
  role: 'advisor',
  agent: 'copilot',
  model: 'copilot-claude-sonnet-4-5',
},
```

---

## Task 5: Config Updates — `hydra.config.json`

**Files:**
- `hydra.config.json` — Add Copilot model config, aliases, mode tiers, and role

**`models` section** — add:
```json
"copilot": {
  "default": "copilot-claude-sonnet-4-5",
  "fast": "copilot-claude-sonnet-4-5",
  "cheap": "copilot-claude-sonnet-4-5",
  "active": "copilot-claude-sonnet-4-5",
  "reasoningEffort": null
}
```

**`aliases` section** — add:
```json
"copilot": {
  "sonnet": "copilot-claude-sonnet-4-5",
  "gpt5": "copilot-gpt-5",
  "gpt-5": "copilot-gpt-5"
}
```

**`modeTiers` section** — add `"copilot"` to each tier:
```json
"performance": { "copilot": "default" },
"balanced": { "copilot": "fast" },
"economy": { "copilot": "cheap" },
"custom": { "copilot": "default" }
```

**`roles` section** — add:
```json
"copilot": {
  "agent": "copilot",
  "model": null,
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
    copilot: commandExists('copilot'),   // ← add this
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

| Risk | Severity | Mitigation |
|---|---|---|
| No JSON output from `copilot -p` | **High** | Treat output as plain text (like Gemini text mode); upgrade when upstream adds `--output-format json` |
| Auth flow in CI/headless | **High** | Require `GH_TOKEN` env var; document clearly; skip Copilot tasks when not authenticated |
| Premium request quota limits | **Medium** | Add Copilot to `hydra-usage.mjs` monitoring; warn when quota is low |
| Copilot CLI still in preview | **Medium** | Pin to versioned install; monitor changelog for breaking changes |
| `--allow-all-tools` security | **Medium** | Only use in `full-auto` mode; default to explicit tool allowlist |
| Windows `copilot` binary path | **Low** | Use `cross-spawn` (already used for all agents); test with WinGet install |

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
    assert.ok(!args.some(a => a.startsWith('--allow-tool')), 'Unexpected --allow-tool in plan mode');
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
    assert.ok(!args.includes('--allow-all-tools'), 'Unexpected --allow-all-tools in auto-edit mode');
  });

  it('has required taskAffinity keys', () => {
    const agent = getAgent('copilot');
    const requiredKeys = ['planning', 'architecture', 'review', 'refactor', 'implementation',
      'analysis', 'testing', 'research', 'documentation', 'security'];
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

*Document created: 2026-03-07*
*Status: Draft — pending technical validation of Copilot CLI headless JSON output*
