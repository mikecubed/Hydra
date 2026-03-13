# Validation Gate

Use this guide to define the proof a task must produce before review and merge.

## Goal

Every task should have a small, explicit validation recipe that proves the change is formatted, lint-clean, tested at
the right scope, and reviewed by the required subagents.

## Minimum Validation Rules

Every task must:

1. format the changed files,
2. lint the changed surface,
3. run the required test set,
4. collect subagent critique,
5. collect a second-model review for structural, shared, or risky work,
6. merge only if hooks pass normally.

Never use `--no-verify` or `HUSKY=0` for local execution.

## Standard Validation Recipe

### Docs-only changes

```bash
npx prettier --write <changed-doc-paths>
npm run lint:mermaid
npx prettier --check <changed-doc-paths>
```

### Focused code changes

```bash
npx prettier --write <changed-paths>
npm run lint -- <changed-paths>
node --test test/<targeted-test-file>.test.ts
```

### Shared or structural changes

```bash
npx prettier --write <changed-paths>
npm run lint -- <changed-paths>
node --test test/<targeted-test-files>.test.ts
npm test
npm run quality
```

Prefer the smallest test command that still proves the behavior, but promote to the shared or structural recipe when a
task touches shared modules, public contracts, worktree/tooling behavior, or extraction boundaries.

## TDD Gate

If the target component lacks adequate tests, stop and create or finish the safety-net task first.

For hotspot modules, the default bar is:

- public contracts covered,
- main failure paths covered,
- important side effects asserted,
- 80% function coverage unless a stronger task-specific bar is defined.

## Review Gate

### Required critique passes

- One critique pass from the task's assigned critique model.
- One second-model review for structural, architectural, concurrency, or shared-contract changes.

Recommended defaults:

- `gpt-5.4` for implementation summaries and plan refinement
- `claude-sonnet-4.6` for architecture and boundary critique
- `gemini-3-pro-preview` for risk, regression, and coverage critique

## Proof Template

Capture this in the task handoff or PR description:

```text
Task: <task-id>
Changed paths: <paths>
Format command: <command and result>
Lint command: <command and result>
Test command(s): <commands and result>
Hooks: <confirmed active / passed>
Critique model: <model + key findings resolved>
Second review model: <model + key findings resolved>
Remaining risks: <none or explicit list>
```

## Merge Coordinator Checks

The merge coordinator should reject the task if:

- the recipe is missing,
- the recipe does not match the risk level of the task,
- hooks were bypassed,
- a required critique pass is missing,
- the task changed a hotspot file out of sequence,
- the task relies on undocumented lint suppression or skipped tests.
