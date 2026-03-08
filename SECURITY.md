# Security Policy

## Supported Versions

Only the latest release on `master` is supported with security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, please email **security@primelocus.com** or use [GitHub's private vulnerability reporting](https://github.com/PrimeLocus/Hydra/security/advisories/new).

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment

We'll acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Daemon Security

Hydra's HTTP daemon binds to `127.0.0.1` (localhost only) by default.  It is
designed for local, single-user use.

- **Read routes** (`GET /health`, `/state`, `/events`, etc.) are unauthenticated
  by design so agent CLIs can poll state without configuration.
- **Write routes** (`POST /tasks`, `/session/start`, etc.) require the
  `x-ai-orch-token` header to match `AI_ORCH_TOKEN` when that variable is set.

**Do not expose the daemon port to untrusted networks.**  If you must bind to a
non-loopback interface, always set `AI_ORCH_TOKEN` to a strong random value.

## Credential Handling

Hydra never stores API keys itself.  All credentials are consumed from
environment variables (see `.env.example`) or from the credential files
maintained by the respective CLI tools (`~/.claude/`, `~/.gemini/`, etc.).

### Gemini OAuth (Direct API path)

The Gemini direct-API fallback performs an OAuth refresh-token flow.  The OAuth
`clientSecret` is **required via the `GEMINI_OAUTH_CLIENT_SECRET` environment
variable** — it must never be hardcoded in source code.  If this variable is not
set, token refresh is refused with a clear error rather than silently failing or
using a placeholder value.

Set `GEMINI_OAUTH_CLIENT_ID` and `GEMINI_OAUTH_CLIENT_SECRET` in your `.env`
file (copy from `.env.example`).

## Verification Command Execution

The `verification.command` field in `hydra.config.json` is executed via the
system shell when a task completes.  To guard against shell injection and
command chaining via shell metacharacters, Hydra rejects commands that contain
characters outside the safe set `[a-zA-Z0-9 _./:@=-]`.  Commands with shell
meta-characters (`;`, `|`, `&`, backticks, `$`, `(`, `)`, `<`, `>`, etc.) are
rejected and verification is disabled for that task.  This filter prevents
shell interpretation/chaining but does **not** guarantee that a given command
is non-malicious.

Auto-detected verification commands (`npm test`, `cargo check`, etc.) come
from a hardcoded allowlist and are always safe.

## Agent Subprocess Spawning

Agent CLIs (Claude, Codex, Gemini) are launched with `shell: false` wherever
the args are already an array.  Prompt text is never concatenated into a shell
command string.  The `CLAUDECODE` environment variable is stripped from child
environments to prevent nested session conflicts.

## Supply-Chain Security

Hydra has four production dependencies (`picocolors`, `cross-spawn`, `zod`,
`@modelcontextprotocol/sdk`).  Keep these up to date and review any additions
carefully.  The `npm audit` command should return no high/critical findings.

## Sensitive File Detection

The evolve and nightly pipelines include a `scanForSecrets` guardrail that
checks both filenames and file contents (first 2 KB) for patterns matching
private keys, API tokens, AWS keys, GitHub PATs, and Google API keys before
any autonomous commit is allowed.
