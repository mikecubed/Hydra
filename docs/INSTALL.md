# Installation Guide

## Prerequisites

| Requirement               | Minimum | Notes                          |
| ------------------------- | ------- | ------------------------------ |
| **Node.js**               | 24+     | For all Hydra modules          |
| **PowerShell**            | 7+      | For launchers and agent heads  |
| **AI CLI (at least one)** |         | `gemini`, `codex`, or `claude` |

### AI CLI Installation

- **Gemini CLI**: `npm install -g @google/gemini-cli`
- **Codex CLI**: `npm install -g @openai/codex`
- **Claude Code**: `npm install -g @anthropic-ai/claude-code`

## Installation

> **Important:** Hydra must be installed through a **packed artifact** (tarball or registry)
> when used as a dependency. Raw local-folder installs (`npm install /path/to/repo`,
> `npm link`) are **not supported** because the JavaScript runtime files are generated
> during `npm pack` and do not exist in the source tree. A postinstall guard will reject
> unsupported install methods with a clear error message.

### Supported Install Methods

| Method                                | Command                                      | Notes                             |
| ------------------------------------- | -------------------------------------------- | --------------------------------- |
| **Development (clone + npm install)** | `git clone <url> && cd Hydra && npm install` | Works directly with `.ts` sources |
| **Global from repo checkout**         | `npm run install:global`                     | Packs then installs the tarball   |
| **Global from tarball**               | `npm install -g hydra-<version>.tgz`         | From `npm pack` output            |
| **Registry**                          | `npm install hydra`                          | When published to npm             |

### 1. Clone or Copy

```powershell
# Clone to a dedicated directory
git clone <repo-url> C:\path\to\Hydra
cd C:\path\to\Hydra
```

### 2. Install Dependencies

```powershell
npm install
```

### 3. Install Hydra CLI Globally

```powershell
npm run install:global
```

This packs a tarball and installs it globally, adding a real `hydra` command to your
npm global bin (no PowerShell profile function required).

> **Note:** Do not use `npm install -g .` or the legacy `bin\install-hydra-cli.ps1`
> script directly — raw local-folder installs are unsupported (see the guard in step
> above). `npm run install:global` handles packing automatically.

### 4. Verify Installation

```powershell
# Check CLI wiring
hydra --help
```

### 5. Initialize for Your Project

```powershell
cd E:\Dev\YourProject
hydra-client init
```

This creates the `docs/coordination/` directory with:

- `AI_SYNC_STATE.json` - Shared state file
- `AI_SYNC_LOG.md` - Activity log
- `AI_ORCHESTRATOR_EVENTS.ndjson` - Event stream

### 6. (Optional) Legacy PowerShell Profile Function

```powershell
pwsh -File C:\path\to\Hydra\bin\install-hydra-profile.ps1
```

Use this only if you want the old profile-function based command. The global npm install already provides `hydra`.

Uninstall: `pwsh -File C:\path\to\Hydra\bin\install-hydra-profile.ps1 -Uninstall`

## Build an Installation Package

Create a distributable tarball:

```powershell
npm run package
```

This emits `dist/hydra-<version>.tgz`. Install it on any machine with Node:

```powershell
npm install -g .\dist\hydra-<version>.tgz
```

## Build a True Standalone Windows EXE

```powershell
npm install
npm run build:exe
.\dist\hydra.exe --help
```

This produces a single-file binary at `dist/hydra.exe` that includes Node runtime + Hydra code.

Notes:

- No Node install is required on the target machine.
- Standalone mode supports normal operator/daemon/client flows.
- `--full` mode is disabled in standalone exe builds (PowerShell multi-terminal launcher is repo-install only).

## Integration with Existing Projects

Add these scripts to your project's `package.json`:

```json
{
  "scripts": {
    "hydra:start": "node /path/to/Hydra/lib/orchestrator-daemon.mjs start",
    "hydra:stop": "node /path/to/Hydra/lib/orchestrator-client.mjs stop",
    "hydra:status": "node /path/to/Hydra/lib/orchestrator-client.mjs status",
    "hydra:summary": "node /path/to/Hydra/lib/orchestrator-client.mjs summary",
    "hydra:stats": "node /path/to/Hydra/lib/orchestrator-client.mjs stats",
    "hydra:usage": "node /path/to/Hydra/lib/hydra-usage.mjs",
    "hydra:model": "node /path/to/Hydra/lib/orchestrator-client.mjs model",
    "hydra:go": "node /path/to/Hydra/lib/hydra-operator.mjs mode=auto",
    "hydra:council": "node /path/to/Hydra/lib/hydra-council.mjs",
    "hydra:next": "node /path/to/Hydra/lib/orchestrator-client.mjs next",
    "hydra:add": "node /path/to/Hydra/lib/orchestrator-client.mjs task:add",
    "hydra:update": "node /path/to/Hydra/lib/orchestrator-client.mjs task:update",
    "hydra:handoff": "node /path/to/Hydra/lib/orchestrator-client.mjs handoff",
    "hydra:launch": "pwsh -NoProfile -ExecutionPolicy Bypass -File /path/to/Hydra/bin/hydra-launch.ps1",
    "hydra": "pwsh -NoProfile -ExecutionPolicy Bypass -File /path/to/Hydra/bin/hydra.ps1"
  }
}
```

## Environment Variables

| Variable             | Default                 | Description                                        |
| -------------------- | ----------------------- | -------------------------------------------------- |
| `AI_ORCH_HOST`       | `127.0.0.1`             | Daemon bind host                                   |
| `AI_ORCH_PORT`       | `4173`                  | Daemon bind port                                   |
| `AI_ORCH_URL`        | `http://127.0.0.1:4173` | Daemon URL for clients                             |
| `AI_ORCH_TOKEN`      | (none)                  | Optional auth token                                |
| `HYDRA_PROJECT`      | (cwd)                   | Override target project                            |
| `HYDRA_CLAUDE_MODEL` | (config)                | Override Claude model                              |
| `HYDRA_GEMINI_MODEL` | (config)                | Override Gemini model                              |
| `HYDRA_CODEX_MODEL`  | (config)                | Override Codex model                               |
| `OPENAI_API_KEY`     | (none)                  | Concierge primary provider (OpenAI models)         |
| `ANTHROPIC_API_KEY`  | (none)                  | Concierge fallback provider (Anthropic models)     |
| `GEMINI_API_KEY`     | (none)                  | Concierge fallback provider (Google Gemini models) |
| `GOOGLE_API_KEY`     | (none)                  | Alternative to GEMINI_API_KEY for Google provider  |

## Troubleshooting

**"Not a valid project directory"**
Hydra needs at least one project marker file (package.json, .git, CLAUDE.md, etc.) in the target directory.

**Concierge unavailable**
Set at least one API key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`/`GOOGLE_API_KEY`. The concierge uses a multi-provider fallback chain — it will use whichever providers have keys available. Without any key, the operator falls back to direct dispatch (no conversational layer).

**Agent CLI not found**
Ensure the agent CLI is installed globally and available in PATH. Run `node lib/sync.mjs doctor` to check.

**Port already in use**
Change the port: `node lib/orchestrator-daemon.mjs start port=4174`

## Next Steps

After installation, pick the guide that matches how you want to work:

- [EFFECTIVE_BUILDING.md](./EFFECTIVE_BUILDING.md) — recommended workflows for feature work, bug fixing, refactors, and verification
- [WORKFLOW_SCENARIOS.md](./WORKFLOW_SCENARIOS.md) — scenario walkthroughs with Mermaid diagrams and interaction examples
- [USAGE.md](./USAGE.md) — full command and configuration reference
