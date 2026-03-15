# Refactoring Task Breakdown

This matrix is optimized for maximum safe parallelism. Every task assumes one dedicated worktree and one focused PR.
For `rf-sn*` hotspot safety-net tasks, the default exit bar is public-contract coverage plus 80% function coverage
unless a stronger task-specific bar is documented.

## Current Status Snapshot

- **Program completion**: ~100%
- **Done**: all `rf-bt*`, `rf-tl*`, `rf-sn*`, `rf-cy*`, `rf-op*`, `rf-ev*`, `rf-cs01`, `rf-cs02`, `rf-ab02`,
  `rf-ab03`, `rf-ab04`, `rf-ab05`, `rf-pl01`, `rf-pl03`, and `rf-pl04`
- **All tasks complete**: `rf-cs03` ✅ delivered via `recordExecution<T>()` wrapper (PR #114)
- **All tasks complete**:
  - `rf-ab06` / `rf-ab07` ✅ consumer adoption complete (PR #112)
  - `rf-pl02` — ✅ complete; all direct `process.exit()` call sites in `lib/` have been migrated to the shared `gracefulExit` helper
  - `rf-ab01` ✅ delivered as `IConfigStore` (PRs #111 & #113); 6 consumers adopted

## Task Matrix

| Task ID   | Task                                 | Scope                                                                                                     | Depends on                                            | Worktree                                   | Primary model       | Critique model         | Status                                                | Done when                                                                               |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ | ------------------- | ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `rf-bt00` | Prepare repo for worktrees           | Add `.worktrees/` to `.gitignore` from the primary checkout and normalize the local deps/hooks strategy   | —                                                     | `primary checkout`                         | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | The repo can create task worktrees without polluting status or breaking hooks           |
| `rf-bt01` | Bootstrap worktree protocol          | Add `.worktrees/` convention, naming rules, merge-coordinator workflow                                    | `rf-bt00`                                             | `primary checkout`                         | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | `docs/plan/worktree-setup-guide.md` is documented, tested, and ready to use             |
| `rf-bt02` | Lock validation workflow             | Define mandatory format, lint, test, and subagent review steps per task                                   | `rf-bt00`                                             | `primary checkout`                         | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | `docs/plan/validation-gate.md` is documented and referenced by execution docs           |
| `rf-tl01` | Add cycle detection gate             | Implement `madge` or equivalent wiring into quality and CI                                                | `rf-bt02`                                             | `.worktrees/rf-tl01-cycle-gate`            | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Cycle detection is runnable in the repo and wired into the quality path                 |
| `rf-tl02` | Add coverage gate plan               | Implement `c8` coverage reporting and stage threshold rollout                                             | `rf-bt02`                                             | `.worktrees/rf-tl02-coverage-gate`         | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Coverage reporting is runnable and the rollout path is documented                       |
| `rf-tl03` | Add complexity visibility plan       | Implement warning-level complexity/size visibility without premature breakage                             | `rf-bt02`                                             | `.worktrees/rf-tl03-complexity-visibility` | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Rule rollout lands as runnable visibility and avoids blocking unsafe hotspots too early |
| `rf-sn01` | Characterize agent executor          | Add contract tests for `hydra-shared/agent-executor.ts`                                                   | `rf-bt02`                                             | `.worktrees/rf-sn01-agent-executor-tests`  | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Executor behavior is covered before extraction                                          |
| `rf-sn02` | Characterize config                  | Add contract tests for `hydra-config.ts`                                                                  | `rf-bt02`                                             | `.worktrees/rf-sn02-config-tests`          | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Config behavior is covered before interface work                                        |
| `rf-sn03` | Characterize daemon                  | Add endpoint and state-machine tests for `orchestrator-daemon.ts`                                         | `rf-bt02`                                             | `.worktrees/rf-sn03-daemon-tests`          | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Daemon behavior is covered before route or worktree changes                             |
| `rf-sn04` | Characterize operator                | Add characterization tests for `hydra-operator.ts`                                                        | `rf-bt02`                                             | `.worktrees/rf-sn04-operator-tests`        | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Operator behavior is covered before any extraction work                                 |
| `rf-sn05` | Characterize evolve                  | Add characterization tests for `hydra-evolve.ts`                                                          | `rf-bt02`                                             | `.worktrees/rf-sn05-evolve-tests`          | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Evolve behavior is covered before any extraction work                                   |
| `rf-sn06` | Characterize metrics                 | Add targeted tests for `hydra-metrics.ts` behaviors touched by cycle remediation                          | `rf-bt02`                                             | `.worktrees/rf-sn06-metrics-tests`         | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Metrics behavior is protected before the self-import fix                                |
| `rf-sn07` | Characterize usage                   | Add targeted tests for `hydra-usage.ts` before cycle and usage-tracking consolidation work                | `rf-bt02`                                             | `.worktrees/rf-sn07-usage-tests`           | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Usage behavior is protected before semantic cleanup                                     |
| `rf-sn08` | Characterize nightly                 | Add targeted tests for `hydra-nightly.ts` before shared-interface migrations touch it                     | `rf-bt02`                                             | `.worktrees/rf-sn08-nightly-tests`         | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Nightly behavior is protected before cross-cutting refactors                            |
| `rf-sn09` | Characterize tasks                   | Add targeted tests for `hydra-tasks.ts` before shared-interface migrations touch it                       | `rf-bt02`                                             | `.worktrees/rf-sn09-tasks-tests`           | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Tasks behavior is protected before cross-cutting refactors                              |
| `rf-sn10` | Characterize audit                   | Add targeted tests for `hydra-audit.ts` before shared-interface migrations touch it                       | `rf-bt02`                                             | `.worktrees/rf-sn10-audit-tests`           | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Audit behavior is protected before cross-cutting refactors                              |
| `rf-sn11` | Characterize MCP server              | Add targeted tests for `hydra-mcp-server.ts` before shared-interface migrations touch it                  | `rf-bt02`                                             | `.worktrees/rf-sn11-mcp-server-tests`      | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | MCP server behavior is protected before cross-cutting refactors                         |
| `rf-sn12` | Characterize streaming cycle modules | Add targeted tests for `hydra-rate-limits.ts` and `hydra-streaming-middleware.ts` before cycle extraction | `rf-bt02`                                             | `.worktrees/rf-sn12-streaming-cycle-tests` | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Cycle A is protected by tests before shared types move                                  |
| `rf-cy01` | Fix Cycle B                          | Remove the `hydra-metrics.ts` self-import safely                                                          | `rf-sn06`                                             | `.worktrees/rf-cy01-metrics-cycle`         | `claude-sonnet-4.6` | `gemini-3-pro-preview` | ✅ Done                                               | Self-import is gone and tests still pass                                                |
| `rf-cy02` | Fix Cycle A                          | Extract shared streaming types to break `rate-limits` ↔ `streaming-middleware`                            | `rf-sn12`                                             | `.worktrees/rf-cy02-streaming-cycle`       | `claude-sonnet-4.6` | `gemini-3-pro-preview` | ✅ Done                                               | Mutual dependency is removed behind tests                                               |
| `rf-cy03` | Untangle Cycle C                     | Map and break the `activity → statusbar → usage` loop                                                     | `rf-sn02`, `rf-sn03`, `rf-sn07`                       | `.worktrees/rf-cy03-activity-cycle`        | `claude-sonnet-4.6` | `gemini-3-pro-preview` | ✅ Done                                               | Indirect loop is documented, tested, and removed                                        |
| `rf-cs01` | Deepen executor coverage             | Cover streaming, timeout, cancellation, and agent-type paths                                              | `rf-sn01`                                             | `.worktrees/rf-cs01-executor-contracts`    | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Executor can be refactored safely                                                       |
| `rf-cs02` | Deepen config coverage               | Cover schema defaults, save/load, cache invalidation, role/model helpers                                  | `rf-sn02`                                             | `.worktrees/rf-cs02-config-contracts`      | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Config seam work has contract protection                                                |
| `rf-cs03` | Consolidate usage tracking           | Replace inline usage updates with a tested shared path                                                    | `rf-sn07`, `rf-cy03`                                  | `.worktrees/rf-cs03-usage-tracking`        | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done — PR #114                                     | Usage bookkeeping has one tested entry point                                            |
| `rf-op01` | Extract operator session             | Pull session/history state out of `hydra-operator.ts`                                                     | `rf-sn04`                                             | `.worktrees/rf-op01-operator-session`      | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Session logic has tests and a narrow API                                                |
| `rf-op02` | Extract operator workers             | Pull worker management out of `hydra-operator.ts`                                                         | `rf-sn04`, `rf-op01`                                  | `.worktrees/rf-op02-operator-workers`      | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Worker lifecycle logic is isolated and tested                                           |
| `rf-op03` | Extract operator dispatch            | Pull prompt routing and streaming out of `hydra-operator.ts`                                              | `rf-sn04`, `rf-cs01`, `rf-op02`                       | `.worktrees/rf-op03-operator-dispatch`     | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Dispatch logic is isolated and tested                                                   |
| `rf-op04` | Extract operator commands            | Pull command handlers out of `hydra-operator.ts`                                                          | `rf-sn01`, `rf-op01`, `rf-op02`, `rf-op03`            | `.worktrees/rf-op04-operator-commands`     | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Command surface is modularized behind tests                                             |
| `rf-op05` | Shrink operator entrypoint           | Reduce `hydra-operator.ts` to REPL wiring                                                                 | `rf-op01`, `rf-op02`, `rf-op03`, `rf-op04`            | `.worktrees/rf-op05-operator-shell`        | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Operator entrypoint becomes a thin orchestrator                                         |
| `rf-ev01` | Extract evolve pipeline              | Pull phase state machine out of `hydra-evolve.ts`                                                         | `rf-sn05`                                             | `.worktrees/rf-ev01-evolve-pipeline`       | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Pipeline rules are isolated and tested                                                  |
| `rf-ev02` | Extract evolve executor              | Pull execution and git operations out of `hydra-evolve.ts`                                                | `rf-sn05`, `rf-cs03`, `rf-ev01`                       | `.worktrees/rf-ev02-evolve-executor`       | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Execution side effects are isolated and tested                                          |
| `rf-ev03` | Shrink evolve entrypoint             | Reduce `hydra-evolve.ts` to orchestration wiring                                                          | `rf-ev01`, `rf-ev02`                                  | `.worktrees/rf-ev03-evolve-shell`          | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Evolve entrypoint is a thin orchestrator                                                |
| `rf-ab01` | Introduce `IConfigStore`             | Define the interface and migrate covered consumers in batches                                             | `rf-cs02`, `rf-sn08`, `rf-sn09`, `rf-sn10`, `rf-sn11` | `.worktrees/rf-ab01-ihydraconfig`          | `claude-sonnet-4.6` | `gpt-5.4`              | ✅ Done — delivered as IConfigStore (PRs #111 & #113) | Interface is real, not aspirational, and each migrated consumer is test-backed          |
| `rf-ab02` | Introduce `IAgentExecutor`           | Define the interface and migrate proven consumers                                                         | `rf-cs01`, `rf-op03`, `rf-ab01`                       | `.worktrees/rf-ab02-iagentexecutor`        | `claude-sonnet-4.6` | `gpt-5.4`              | ✅ Done                                               | Executor contract is shared and testable                                                |
| `rf-ab03` | Introduce `IBudgetGate`              | Replace duplicated budget guard logic                                                                     | `rf-cs03`, `rf-sn04`, `rf-sn05`, `rf-sn08`            | `.worktrees/rf-ab03-ibudgetgate`           | `claude-sonnet-4.6` | `gpt-5.4`              | ✅ Done                                               | Budget checks are centralized and testable across covered callers                       |
| `rf-ab04` | Consolidate context building         | Extend `hydra-context.ts` and migrate callers                                                             | `rf-op03`, `rf-ev03`                                  | `.worktrees/rf-ab04-context-consolidation` | `claude-sonnet-4.6` | `gpt-5.4`              | ✅ Done                                               | Context creation follows one tested path                                                |
| `rf-ab05` | Enforce architecture boundaries      | Add boundary rules after extraction seams exist                                                           | `rf-ab01`, `rf-ab02`, `rf-ab04`                       | `.worktrees/rf-ab05-boundary-enforcement`  | `claude-sonnet-4.6` | `gemini-3-pro-preview` | ✅ Done                                               | Boundaries reflect real module seams and pass cleanly                                   |
| `rf-ab06` | Introduce `IMetricsRecorder`         | Extract and migrate a metrics-recording seam after the metrics safety net exists                          | `rf-sn06`, `rf-ab05`                                  | `.worktrees/rf-ab06-imetricsrecorder`      | `claude-sonnet-4.6` | `gpt-5.4`              | ✅ Done — PR #112                                     | Metrics recording is isolated behind a tested interface                                 |
| `rf-ab07` | Introduce `IGitOperations`           | Extract and migrate shared git operations after executor/evolve seams settle                              | `rf-ev02`, `rf-ab05`                                  | `.worktrees/rf-ab07-igitoperations`        | `claude-sonnet-4.6` | `gpt-5.4`              | ✅ Done — PR #112                                     | Git operations are isolated behind a tested interface                                   |
| `rf-pl01` | Fix safe `no-await-in-loop` cases    | Parallelize only behavior-safe loops in modules that already have adequate tests                          | `rf-ab05`, `rf-sn08`, `rf-sn09`, `rf-sn10`, `rf-sn11` | `.worktrees/rf-pl01-await-loops`           | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Every changed loop is backed by existing or newly-added tests and remains behavior-safe |
| `rf-pl02` | Replace `process.exit()`             | Convert exit paths to testable control flow only in modules that already have adequate tests              | `rf-ab05`, `rf-sn08`, `rf-sn09`, `rf-sn10`, `rf-sn11` | `.worktrees/rf-pl02-process-exit`          | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done — all calls migrated                          | Every changed exit path is backed by tests and remains lint-clean                       |
| `rf-pl03` | Add mutation testing                 | Plan and add Stryker for the critical shared modules                                                      | `rf-cs01`, `rf-cs02`, `rf-ab02`                       | `.worktrees/rf-pl03-mutation-testing`      | `gpt-5.4`           | `gemini-3-pro-preview` | ✅ Done                                               | Mutation testing verifies the safety net is meaningful                                  |
| `rf-pl04` | Finalize docs and ADRs               | Update architecture docs, dependency diagrams, and ADRs                                                   | `rf-op05`, `rf-ev03`, `rf-ab05`                       | `.worktrees/rf-pl04-docs-finalization`     | `gpt-5.4`           | `claude-sonnet-4.6`    | ✅ Done                                               | Docs match the landed architecture                                                      |

## Recommended Parallel Batches

### Batch 1 — Start immediately

- `rf-bt00`

### Batch 1a — After the repo is ready for worktrees

- `rf-bt01`
- `rf-bt02`

### Batch 1b — After bootstrap validation is merged

- `rf-sn01`
- `rf-sn02`
- `rf-sn03`
- `rf-sn04`
- `rf-sn05`
- `rf-sn06`
- `rf-sn07`
- `rf-sn08`
- `rf-sn09`
- `rf-sn10`
- `rf-sn11`
- `rf-sn12`

### Batch 2 — After bootstrap validation is merged

- `rf-tl01`
- `rf-tl02`
- `rf-tl03`

### Batch 3 — After the relevant safety-net tasks are green

- `rf-cy01`
- `rf-cy02`
- `rf-cy03`
- `rf-cs01`
- `rf-cs02`

### Batch 3b — After the usage cycle work lands

- `rf-cs03`

### Batch 4 — After the core contracts are protected

- `rf-op01`
- `rf-ev01`

### Batch 4b — Continue hotspot extracts in sequence

- `rf-op02`
- `rf-ev02`

### Batch 4c — Finish hotspot extract prerequisites

- `rf-op03`

### Batch 5 — After the earlier extracts land

- `rf-op04`
- `rf-ev03`

### Batch 5a — Finish hotspot entrypoints

- `rf-op05`

### Batch 5b — After hotspot extracts settle

- `rf-ab01`
- `rf-ab03`
- `rf-ab04`

### Batch 5c — After shared-config migration lands

- `rf-ab02`

### Batch 6 — Shared boundary gate

- `rf-ab05`

### Batch 6b — Shared architecture follow-ons

- `rf-ab06`
- `rf-ab07`

### Batch 7 — Finishers

- `rf-pl01`
- `rf-pl02`
- `rf-pl03`
- `rf-pl04`

## Review Rule

For any task that changes structure, shared contracts, or concurrency:

- one model must critique the design or abstraction move before coding finishes,
- one model must critique the verification plan before merge,
- only the summarized findings should be carried forward into the coordinator context.

For hotspot modules like `hydra-operator.ts` and `hydra-evolve.ts`, assume sequential extraction by default unless the
merge coordinator explicitly approves a lower-conflict split.
