# Refactoring Master Plan

This document turns `docs/REFACTORING_ROADMAP.md` into an execution model optimized for safe parallelism.

## Objectives

- Split the refactoring program into the smallest safe tasks that can run in parallel.
- Use repo-local git worktrees to isolate every task.
- Make TDD and characterization testing the entry ticket for any refactor.
- Require subagent validation for every meaningful change so the coordinating agent can keep a small, durable context.

## Artifact Map

- `docs/REFACTORING_ROADMAP.md` — program-level findings, goals, and phase gates
- `docs/plan/refactoring-task-breakdown.md` — dependency-ordered task matrix
- `docs/plan/refactoring-worktree-playbook.md` — exact worktree, branch, validation, and merge rules
- `docs/plan/worktree-setup-guide.md` — exact worktree creation, dependency, hook, and smoke-test commands
- `docs/plan/validation-gate.md` — standard validation commands, proof format, and review expectations

## Non-Negotiable Rules

1. **TDD first.** If a component lacks adequate tests, the task is to add tests before refactoring.
2. **One task, one worktree.** Use a dedicated worktree for each task under `.worktrees/<task-id>`.
3. **Hooks stay on.** Never use `--no-verify` and never normalize bypassing pre-commit or pre-push hooks.
4. **Always lint and format.** Run formatting and linting on changed files before review, then run the task's required tests.
5. **No casual lint bypasses.** A suppression is acceptable only when it is narrow, reviewed, justified inline, and tracked for removal.
6. **Subagents are mandatory.** Every task needs at least one critique pass from another model before merge.
7. **Keep the coordinator context small.** Let subagents do file discovery, critique, and edge-case exploration, then retain only the distilled findings.
8. **Serialize hotspot files when needed.** Parallelism is preferred, but tasks that modify the same large hotspot file must be explicitly serialized or split into low-conflict slices approved by the merge coordinator.

## Model Roles

| Model                  | Primary use in this program                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `gpt-5.4`              | Drafting implementation plans, decomposing tasks, synthesizing reviewer feedback |
| `claude-sonnet-4.6`    | Architecture and module-boundary critique, decomposition safety review           |
| `gemini-3-pro-preview` | Edge cases, failure-mode review, coverage and regression analysis                |

Recommended pattern:

1. Use `gpt-5.4` to draft or refine the task plan.
2. Use `claude-sonnet-4.6` to critique boundaries, seams, and abstraction moves.
3. Use `gemini-3-pro-preview` to critique tests, failure modes, and missing verification.
4. Fold only the durable conclusions back into the working context.

## Per-Task Execution Loop

1. Claim the task from the matrix and create the dedicated worktree.
2. Read only the minimum files needed for the task.
3. If the touched component lacks adequate tests, write characterization tests first.
4. Make the smallest behavior-preserving change that advances the task.
5. Run format, lint, and targeted tests in the task worktree.
6. Send the diff or summary to at least one critique subagent.
7. Send the distilled summary to a second model for risk and coverage review when the task is structural or safety-critical.
8. Update docs if the extraction changes architecture, workflows, or user-facing behavior.
9. Merge only after hooks pass normally and the required critiques are incorporated.

## Phase Gates

### Phase 0 — Bootstrap

- Establish `.worktrees/` usage and ignore rules.
- Assign task IDs and dependencies.
- Define review pairings and merge coordination.

### Phase 1 — Safety Net

- Add or tighten cycle detection, coverage visibility, and complexity visibility.
- Add characterization tests for the highest-risk modules.
- Remove blocking import cycles only after tests reproduce the behavior they protect.

### Phase 2 — Core Stability

- Harden contracts around `agent-executor`, `hydra-config`, and daemon behavior.
- Tighten gates only after tests exist.

### Phase 3 — Decomposition

- Split `hydra-operator.ts` and `hydra-evolve.ts` in small slices.
- Migrate config seams through tested interfaces, not sweeping rewrites.

### Phase 4 — Shared Abstractions

- Introduce shared interfaces and enforce boundaries only after caller tests exist.

### Phase 5 — Cleanup & Documentation

- Finish long-tail cleanup, mutation testing, diagrams, and ADRs.

## Safety Conditions Before Any Refactor Starts

- The public API or contract of the target component is identified.
- Tests cover the behavior that the refactor might change.
- The target has adequate contract coverage: public exports, key failure paths, and downstream-visible side effects are asserted, with 80% function coverage as the default bar for hotspot modules.
- The task has a dedicated worktree and branch.
- The task has a named reviewer model pairing.
- The validation command set is written down before coding starts.
