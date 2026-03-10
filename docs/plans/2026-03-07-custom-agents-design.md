# Custom Agent Registration Design

**Date:** 2026-03-07
**Status:** Approved

## Goal

Allow users to register arbitrary AI coding agents — both CLI-based (e.g. GitHub Copilot CLI, Aider) and API-based (any OpenAI-compatible endpoint) — as first-class Hydra agents with full routing, task affinity, and MCP integration.

## Architecture

Three new surfaces, all building on existing infrastructure:

1. **Config schema** — `hydra.config.json` gets an `agents.custom[]` array. On startup, `initAgentRegistry()` in `hydra-agents.mjs` loads and registers each entry via the existing `registerAgent()`.

2. **Runtime execution** — `executeAgent()` in `agent-executor.mjs` gets a `"cli-custom"` branch. CLI agents use template expansion (`{prompt}`, `{cwd}`, `{outputFile}` placeholders). API agents reuse `streamLocalCompletion()` from `hydra-local.mjs` — no new networking code.

3. **Wizard + MCP setup** — `:agents add` operator command walks two tracks (CLI or API), writes to `agents.custom[]`, then extends `hydra-setup.mjs` to auto-register the Hydra MCP server with the new agent's config. Known CLIs get auto-detected paths; unknown CLIs get printed manual instructions.

No new modules needed — wires into `hydra-agents.mjs`, `agent-executor.mjs`, `hydra-setup.mjs`, and `hydra-operator.mjs`.

## Config Schema

### CLI Agent

```json
{
  "name": "copilot",
  "type": "cli",
  "displayName": "GitHub Copilot",
  "invoke": {
    "nonInteractive": { "cmd": "gh", "args": ["copilot", "suggest", "-p", "{prompt}"] },
    "headless": { "cmd": "gh", "args": ["copilot", "suggest", "-p", "{prompt}"] }
  },
  "responseParser": "plaintext",
  "contextBudget": 32000,
  "councilRole": null,
  "taskAffinity": {
    "implementation": 0.7,
    "research": 0.6,
    "documentation": 0.5,
    "planning": 0.4,
    "architecture": 0.35,
    "review": 0.45,
    "refactor": 0.55,
    "analysis": 0.5,
    "testing": 0.5,
    "security": 0.4
  },
  "mcp": { "configPath": "~/.config/gh/copilot/settings.json", "format": "json" },
  "enabled": true
}
```

### API Agent

```json
{
  "name": "mixtral",
  "type": "api",
  "displayName": "Mixtral 8x7B",
  "baseUrl": "http://localhost:11434/v1",
  "model": "mixtral:8x7b",
  "contextBudget": 32000,
  "councilRole": null,
  "taskAffinity": {
    "implementation": 0.75,
    "refactor": 0.8,
    "testing": 0.7,
    "documentation": 0.55,
    "planning": 0.3,
    "architecture": 0.25,
    "review": 0.45,
    "analysis": 0.45,
    "research": 0.0,
    "security": 0.3
  },
  "enabled": true
}
```

### Template Placeholders (CLI track)

| Placeholder    | Description                                           |
| -------------- | ----------------------------------------------------- |
| `{prompt}`     | The task prompt (required)                            |
| `{cwd}`        | Project root directory                                |
| `{outputFile}` | Temp file path for agents that write output to a file |

### Response Parsers

| Value         | Behavior                                      |
| ------------- | --------------------------------------------- |
| `"plaintext"` | Capture stdout as-is                          |
| `"json"`      | Parse JSON stdout, extract text content field |
| `"markdown"`  | Capture markdown from stdout                  |

### Task Affinity Presets

Wizard lets users pick a preset instead of entering 10 numbers:

| Preset             | Boosted affinities                     |
| ------------------ | -------------------------------------- |
| `balanced`         | All at 0.50                            |
| `code-focused`     | implementation, refactor, testing high |
| `review-focused`   | review, analysis, security high        |
| `research-focused` | research, documentation, analysis high |

Power users can edit `hydra.config.json` directly for fine-grained values.

## Wizard Flow (`:agents add`)

```
1. Agent name        → e.g. "copilot"
2. Type              → [CLI agent] / [API endpoint]

── CLI track ───────────────────────────────────────
3. CLI command       → e.g. "gh"
4. Args template     → e.g. "copilot suggest -p {prompt}"
5. Response parser   → [plaintext] / json / markdown
6. Context budget    → e.g. 32000
7. Task profile      → [balanced] / code-focused / review-focused / research-focused
8. Council role      → [none] / analyst / architect / implementer

── API track ───────────────────────────────────────
3. Base URL          → e.g. "http://localhost:11434/v1"
4. Model name        → e.g. "mixtral:8x7b"
5. Context budget    → e.g. 32000
6. Task profile      → [balanced] / code-focused / review-focused / research-focused

── Both tracks ─────────────────────────────────────
9. MCP setup         → [Auto-detect] / Enter path manually / Skip
```

## Additional Operator Commands

| Command                 | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `:agents add`           | Interactive wizard to register a new custom agent       |
| `:agents list`          | Show all agents (built-in + custom) with enabled status |
| `:agents remove <name>` | Remove a custom agent from config                       |
| `:agents test <name>`   | Send test prompt to verify agent responds               |

## MCP Registration

`hydra-setup.mjs` extended with `registerCustomAgentMcp(agentName, mcpConfig)`:

1. If `mcpConfig.configPath` provided — attempt auto-inject (same mechanism as existing claude/gemini/codex handlers)
2. If auto-inject fails or path unknown — print manual instructions:

```
Could not auto-register MCP. Add this to your agent's MCP config:

  Name: hydra
  Command: node /path/to/lib/hydra-mcp-server.mjs
```

Known CLI auto-detect targets (extensible):

- `gh` → `~/.config/gh/copilot/` (format varies by version)
- `aider` → `~/.aider.conf.yml`

## Error Handling

| Category                  | Trigger                         | Behavior                                      |
| ------------------------- | ------------------------------- | --------------------------------------------- |
| `custom-cli-disabled`     | `enabled: false` in config      | Skip, no fallback                             |
| `custom-cli-unavailable`  | CLI not found on PATH (ENOENT)  | Warn once, fall back to cloud                 |
| `custom-cli-error`        | CLI exits non-zero              | Task failure, reported normally               |
| (API) `local-unavailable` | ECONNREFUSED / ENOTFOUND / etc. | Reuses existing category, falls back to cloud |
| (API) `local-error`       | HTTP error from endpoint        | Reuses existing category                      |

## Testing

- Unit: template expansion (placeholder substitution, missing/extra placeholders)
- Unit: `initAgentRegistry()` loads `agents.custom[]` entries correctly
- Unit: task profile preset → affinity object mapping
- Unit: `agents.custom[]` entries appear in `listAgents()` / `getPhysicalAgentNames()`
- Integration: `:agents add` wizard writes correct config shape (mock `promptChoice`)
- No real CLI/API calls in tests — mock at boundary

## Files to Modify

| File                                  | Change                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `lib/hydra-agents.mjs`                | Load `agents.custom[]` in `initAgentRegistry()`; expand CLI templates in invoke                                  |
| `lib/hydra-config.mjs`                | Add `agents.custom: []` to `DEFAULT_CONFIG`; merge in `mergeWithDefaults()`                                      |
| `lib/hydra-shared/agent-executor.mjs` | Add `"cli-custom"` branch in `executeAgent()`; `custom-cli-unavailable` fallback in `executeAgentWithRecovery()` |
| `lib/hydra-setup.mjs`                 | Add `registerCustomAgentMcp()` + known CLI auto-detect targets                                                   |
| `lib/hydra-operator.mjs`              | Add `:agents add \| list \| remove \| test` command handlers                                                     |
| `CLAUDE.md`                           | Document custom agent config schema                                                                              |
| `README.md`                           | Document `:agents` commands                                                                                      |
