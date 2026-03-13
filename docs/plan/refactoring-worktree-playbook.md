# Refactoring Worktree Playbook

Use this playbook for every task in `docs/plan/refactoring-task-breakdown.md`.

Companion docs:

- `docs/plan/worktree-setup-guide.md` — exact commands for creating and smoke-testing task worktrees
- `docs/plan/validation-gate.md` — standard validation commands and merge-proof expectations

Important bootstrap note: the current repo uses a relative Husky hooks path. `rf-bt00` must normalize that local
configuration for worktree use before parallel execution starts.

## Directory Convention

- Keep task worktrees inside the repository directory under `.worktrees/`.
- Use one folder per task: `.worktrees/<task-id>-<short-name>`.
- Add `.worktrees/` to `.gitignore` from the primary checkout as part of `rf-bt00` before any task worktree is created so task checkouts stay local-only.

Example:

```bash
git worktree add .worktrees/rf-sn01-agent-executor-tests -b feat/rf-sn01-agent-executor-tests
```

## Branch Convention

- One branch per task.
- Branch names should match the task ID closely so reviews and clean-up stay obvious.
- Never reuse a task worktree for a second task.

## Required Start-of-Task Checklist

1. Confirm the task ID, dependency status, and reviewer model pair.
2. Create or refresh the dedicated worktree from current `main`.
3. Install or confirm local dependencies in that worktree so hook commands and validation tools resolve correctly.
4. Verify hooks are active by checking `git config core.hooksPath` in the worktree and confirming `.husky/pre-commit` and `.husky/pre-push` exist at the repo root.
5. Write down the task's expected validation commands before making changes.
6. Identify whether the target component already has adequate tests.

If the component does not have adequate tests, the task becomes a safety-net task first.

If a dependency lands while the task is in flight, merge the latest `main` into the worktree before final verification
so the task is validated on top of its real upstream state. Rebase is acceptable only before a branch is shared or
reviewed.

Dependency strategy for repo-local worktrees:

- Prefer symlinking `node_modules` from the primary checkout into the worktree immediately after creation.
- If symlinking is not appropriate for the task, run `npm install` inside that worktree before coding starts.
- Do not assume the primary checkout's dependencies are automatically available from the worktree.

## Required End-of-Task Checklist

1. Run formatting in the worktree.
2. Run linting in the worktree.
3. Run the targeted tests for the touched surface.
4. Run broader verification when the task touches shared or structural code.
5. Request critique from at least one subagent.
6. Request a second review from another model for structural, architectural, or risky changes.
7. Update docs affected by the change.
8. Merge only when hooks pass without bypasses.

## Hook and Lint Policy

- Never use `--no-verify`.
- Never skip pre-commit or pre-push hooks to get a branch through.
- Never use `HUSKY=0` for local task execution. That escape hatch is CI-only.
- Never accept a change that only passes because linting or tests were suppressed.
- If a scoped lint suppression is genuinely unavoidable, keep it:
  - as narrow as possible,
  - justified inline,
  - reviewed explicitly,
  - linked to follow-up cleanup.

## Subagent Usage Policy

Subagents should be used aggressively to keep the main coordinator context focused:

- Use subagents for discovery when a task touches many files.
- Use `claude-sonnet-4.6` to challenge module boundaries and extraction plans.
- Use `gemini-3-pro-preview` to challenge test completeness, failure handling, and rollback risk.
- Use `gpt-5.4` to synthesize the findings into the next concrete action list.

The coordinator should keep only:

- the task goal,
- the current assumptions,
- the accepted reviewer findings,
- the next validation steps.

Avoid carrying full investigative transcripts forward unless they are essential.

## Merge Coordination Rules

- Merge the smallest dependency-satisfying PRs first.
- Land safety nets before structural extractions.
- Land shared interfaces only after at least one consumer proves the seam.
- If two tasks conflict on a hotspot file, split the work further or serialize the merges.
- Treat `hydra-operator.ts`, `hydra-evolve.ts`, and other oversized hotspot files as locked to one active extraction task at a time unless the merge coordinator approves a lower-conflict split.
- Clean up merged worktrees promptly to reduce stale branch drift.

## Restart Policy for Abandoned Tasks

- Do not recycle a stale task worktree after significant drift.
- If a task stalls or its base moves too far, delete the worktree, refresh from current `main`, and recreate the branch cleanly.
- Re-run the start-of-task checklist before resuming the task.
