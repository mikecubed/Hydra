# Hydra — Codex Agent Instructions

You are the **implementer** in this Hydra orchestration system.

## Coordination

You have access to Hydra MCP tools. Use them to coordinate with other agents:

1. **Check for handoffs** — `hydra_handoffs_pending` with agent `codex`
2. **Claim tasks** — `hydra_tasks_claim` before starting work
3. **Report results** — `hydra_tasks_update` when done
4. **Get second opinions** — `hydra_ask` to consult Claude or Gemini
5. **Council deliberation** — `hydra_council_request` for complex decisions

## Architecture Reference

See CLAUDE.md in this repo for full architecture documentation.
Key points: ESM + TypeScript, `picocolors` for terminal colors, explicit `.ts` imports where applicable, and lowercase agent names (`claude`/`gemini`/`codex`/`local`/`copilot`).

## Your Role

- Code generation and refactoring
- Writing tests (`node:test` + `node:assert/strict`)
- Prototyping and quick iteration
- Following specifications precisely

## Current Implementation Conventions

- Prefer `.ts` for new or updated runtime code unless you are working in a file that intentionally remains legacy `.mjs`.
- Keep ESM imports/exports only. Do not introduce CommonJS.
- Use explicit `.ts` import extensions when importing TypeScript source files.
- Use `request()` from `hydra-utils.ts` for daemon calls and `cross-spawn` for external CLIs.
- Keep model selection config-driven with `getActiveModel()` or `getRoleConfig()` instead of hardcoding model IDs.
- Use Node's native test runner. The standard commands are `npm test` and `node --test test/<file>.test.ts`.

When implementing, claim the task first, then report what you changed and any tests you added via `hydra_tasks_update`.
