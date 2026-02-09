# Installation Guide

## Prerequisites

| Requirement | Minimum | Notes |
|------------|---------|-------|
| **Node.js** | 20+ | For all Hydra modules |
| **PowerShell** | 7+ | For launchers and agent heads |
| **AI CLI (at least one)** | | `gemini`, `codex`, or `claude` |

### AI CLI Installation

- **Gemini CLI**: `npm install -g @anthropic-ai/gemini-cli` (or via Google)
- **Codex CLI**: `npm install -g @openai/codex`
- **Claude Code**: `npm install -g @anthropic-ai/claude-code`

## Installation

### 1. Clone or Copy

```powershell
# Clone to a dedicated directory
git clone <repo-url> E:\Dev\Hydra
cd E:\Dev\Hydra
```

### 2. Install Dependencies

```powershell
npm install
```

This installs the sole dependency: `picocolors` for terminal colors.

### 3. Verify Installation

```powershell
# Check that the daemon can start
node lib/orchestrator-daemon.mjs help

# Check agent availability
node lib/sync.mjs doctor
```

### 4. Initialize for Your Project

```powershell
cd E:\Dev\YourProject
node E:/Dev/Hydra/lib/orchestrator-client.mjs init
```

This creates the `docs/coordination/` directory with:
- `AI_SYNC_STATE.json` - Shared state file
- `AI_SYNC_LOG.md` - Activity log
- `AI_ORCHESTRATOR_EVENTS.ndjson` - Event stream

### 5. (Optional) Install PowerShell Profile

```powershell
pwsh -File E:\Dev\Hydra\bin\install-hydra-profile.ps1
```

This adds a `hydra` function to your PowerShell profile so you can run `hydra` from any directory.

Uninstall: `pwsh -File E:\Dev\Hydra\bin\install-hydra-profile.ps1 -Uninstall`

## Integration with Existing Projects

Add these scripts to your project's `package.json`:

```json
{
  "scripts": {
    "hydra:start": "node E:/Dev/Hydra/lib/orchestrator-daemon.mjs start",
    "hydra:stop": "node E:/Dev/Hydra/lib/orchestrator-client.mjs stop",
    "hydra:status": "node E:/Dev/Hydra/lib/orchestrator-client.mjs status",
    "hydra:summary": "node E:/Dev/Hydra/lib/orchestrator-client.mjs summary",
    "hydra:stats": "node E:/Dev/Hydra/lib/orchestrator-client.mjs stats",
    "hydra:usage": "node E:/Dev/Hydra/lib/hydra-usage.mjs",
    "hydra:model": "node E:/Dev/Hydra/lib/orchestrator-client.mjs model",
    "hydra:go": "node E:/Dev/Hydra/lib/hydra-operator.mjs mode=auto",
    "hydra:council": "node E:/Dev/Hydra/lib/hydra-council.mjs",
    "hydra:next": "node E:/Dev/Hydra/lib/orchestrator-client.mjs next",
    "hydra:add": "node E:/Dev/Hydra/lib/orchestrator-client.mjs task:add",
    "hydra:update": "node E:/Dev/Hydra/lib/orchestrator-client.mjs task:update",
    "hydra:handoff": "node E:/Dev/Hydra/lib/orchestrator-client.mjs handoff",
    "hydra:launch": "pwsh -NoProfile -ExecutionPolicy Bypass -File E:/Dev/Hydra/bin/hydra-launch.ps1",
    "hydra": "pwsh -NoProfile -ExecutionPolicy Bypass -File E:/Dev/Hydra/bin/hydra.ps1"
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_ORCH_HOST` | `127.0.0.1` | Daemon bind host |
| `AI_ORCH_PORT` | `4173` | Daemon bind port |
| `AI_ORCH_URL` | `http://127.0.0.1:4173` | Daemon URL for clients |
| `AI_ORCH_TOKEN` | (none) | Optional auth token |
| `HYDRA_PROJECT` | (cwd) | Override target project |
| `HYDRA_CLAUDE_MODEL` | (config) | Override Claude model |
| `HYDRA_GEMINI_MODEL` | (config) | Override Gemini model |
| `HYDRA_CODEX_MODEL` | (config) | Override Codex model |

## Troubleshooting

**"Not a valid project directory"**
Hydra needs at least one project marker file (package.json, .git, CLAUDE.md, etc.) in the target directory.

**Agent CLI not found**
Ensure the agent CLI is installed globally and available in PATH. Run `node lib/sync.mjs doctor` to check.

**Port already in use**
Change the port: `node lib/orchestrator-daemon.mjs start port=4174`
