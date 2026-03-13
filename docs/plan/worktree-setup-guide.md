# Worktree Setup Guide

Use this guide when starting any task from `docs/plan/refactoring-task-breakdown.md`.

## Goal

Create one isolated worktree per task under `.worktrees/`, make sure dependencies resolve in that checkout, verify the
Husky hooks are still active, and run a quick smoke check before coding.

## Preconditions

- `rf-bt00` has landed and `.worktrees/` is ignored from the primary checkout.
- The task is ready according to the dependency rules in `docs/plan/refactoring-task-breakdown.md`.
- You know the task ID and branch name you want to create.

## Standard Naming

- Worktree path: `.worktrees/<task-id>-<short-name>`
- Branch name: `feat/<task-id>-<short-name>` for implementation tasks
- Keep the task ID visible in both names so cleanup and review stay obvious.

Example:

```bash
git worktree add .worktrees/rf-sn01-agent-executor-tests -b feat/rf-sn01-agent-executor-tests
```

## Setup Steps

### 1. Start from the primary checkout

Make sure the primary checkout is on a fresh `main` before creating a task worktree:

```bash
git switch main
git pull --ff-only
```

Before creating any worktree, normalize the local hooks path so worktrees resolve Husky hooks correctly:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
git config core.hooksPath "$REPO_ROOT/.husky"
```

The current relative hooks-path setup is not sufficient for repo-local worktrees.

### 2. Create the task worktree

```bash
git worktree add .worktrees/<task-id>-<short-name> -b feat/<task-id>-<short-name>
```

### 3. Make dependencies available inside the worktree

Preferred option:

```bash
ln -s ../../node_modules .worktrees/<task-id>-<short-name>/node_modules
```

Fallback option if symlinking is not appropriate:

```bash
cd .worktrees/<task-id>-<short-name>
npm install
```

Do not assume the primary checkout's dependencies are automatically available from the worktree.

### 4. Verify hooks are still active

From inside the worktree:

```bash
git config core.hooksPath
```

Expected repo setup after the bootstrap fix:

- `core.hooksPath` resolves to an absolute path ending in `/.husky/_`
- `.husky/pre-commit` exists at the repo root
- `.husky/pre-push` exists at the repo root

If those assumptions are no longer true, stop and fix the hook setup before coding.

### 5. Smoke-test actual hook execution

Do not stop at checking config values. Confirm the hooks actually execute from the worktree before real changes start.

One simple approach is to make a disposable empty commit in the fresh task worktree:

```bash
git commit --allow-empty -m "hook smoke test"
```

If the hooks run successfully, immediately remove the disposable commit before real work starts:

```bash
git reset --soft HEAD~1
```

If the hook commands do not execute from the worktree, stop and fix the local hook setup before continuing.

### 6. Run a smoke check

For a docs-only task:

```bash
npx prettier --check <changed-doc-paths>
npm run lint:mermaid
```

For a code task, start with at least:

```bash
npx prettier --check <changed-paths>
npm run lint -- <changed-paths>
```

Then add the task-specific test command from `docs/plan/validation-gate.md`.

## Refreshing a Worktree

If the task is still active but `main` has moved:

```bash
git switch <task-branch>
git merge main
```

Use rebase only before the branch is shared or reviewed.

## Restarting a Stale Task

If the worktree has drifted too far or become confusing:

```bash
git worktree remove .worktrees/<task-id>-<short-name>
git branch -D feat/<task-id>-<short-name>
git worktree add .worktrees/<task-id>-<short-name> -b feat/<task-id>-<short-name>
```

Then repeat the setup steps and smoke check before coding resumes.

## End-of-Task Reminder

Before asking for merge:

- run the validation recipe from `docs/plan/validation-gate.md`,
- request the required subagent critiques,
- keep only the accepted findings in the coordinator context.
