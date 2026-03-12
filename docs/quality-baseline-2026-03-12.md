# Quality Baseline — 2026-03-12

**Branch:** `chore/quality-node24-plan`  
**Purpose:** Replace the stale pre-TypeScript-migration quality audit with the live baseline used for the new remediation plan.

## Commands run

```bash
./node_modules/.bin/eslint . --format json
npm run format:check
npm run typecheck
node --test 'test/**/*.test.{ts,mjs}'
```

## ✅ Final state — remediation complete (2026-03-12)

All T0–T8 phases have landed on `chore/quality-node24-plan` (PR #17). The branch is
clean and all CI checks pass.

| Check      | Baseline (start)              | Final state                     |
| ---------- | ----------------------------- | ------------------------------- |
| ESLint     | 2,975 errors / 5,777 warnings | **0 errors / 567 warnings**     |
| Prettier   | Clean                         | **Clean**                       |
| TypeScript | Clean                         | **Clean** (0 `tsc` errors)      |
| Tests      | 887 pass / 19 todo / 0 fail   | **939 pass / 19 todo / 0 fail** |
| Node min   | 22 LTS                        | **24 LTS**                      |
| CI matrix  | Node 20 + 22                  | **Node 24 only, strict gates**  |

The 19 todo tests are intentional integration stubs in
`test/hydra-worktree-isolation.test.mjs` — see the T0 audit section below.

---

## Original baseline

### Executive summary

| Check      | Result                        | Notes                                                                                 |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| ESLint     | 2,975 errors / 5,777 warnings | All current debt is in lint; most volume is TypeScript-aware ESLint rather than `tsc` |
| Prettier   | Clean                         | `npm run format:check` passes                                                         |
| TypeScript | Clean                         | `npm run typecheck` passes                                                            |
| Tests      | Clean baseline                | Direct `node --test` exits 0 with 887 pass / 19 todo / 0 fail                         |

### Important baseline correction

Older docs in `docs/quality-audit.md` and `docs/quality-fix-plan.md` describe a pre-migration state with thousands of `tsc --checkJs` errors and `.mjs`-centric fixes. That is no longer the current repo shape. The current repository is TypeScript-first, `tsc` is already clean, and the backlog is concentrated in type-aware ESLint rules.

## ESLint totals (original baseline)

- **2,975 errors**
- **5,777 warnings**
- **88 files with findings**

### Highest-volume rules

| Rule                                                | Total | Errors | Warnings | Meaning for planning                                                 |
| --------------------------------------------------- | ----: | -----: | -------: | -------------------------------------------------------------------- |
| `@typescript-eslint/strict-boolean-expressions`     | 2,828 |      0 |    2,828 | Large warning-only campaign; defer until targeted module tests exist |
| `@typescript-eslint/no-unsafe-member-access`        | 1,347 |      0 |    1,347 | Mostly requires better local typing and guards                       |
| `@typescript-eslint/prefer-nullish-coalescing`      | 1,005 |  1,005 |        0 | High-value mechanical/error cleanup with behavior review             |
| `@typescript-eslint/restrict-template-expressions`  |   823 |    823 |        0 | Needs explicit string normalization helpers                          |
| `@typescript-eslint/no-unsafe-assignment`           |   530 |      0 |      530 | Warning-only, often follows from missing narrowing                   |
| `@typescript-eslint/no-unnecessary-condition`       |   357 |    357 |        0 | Safe only with tests around fallback/config logic                    |
| `@typescript-eslint/no-explicit-any`                |   335 |      0 |      335 | Warning-only, best fixed opportunistically                           |
| `@typescript-eslint/no-unsafe-argument`             |   259 |      0 |      259 | Often falls as types improve                                         |
| `@typescript-eslint/explicit-module-boundary-types` |   194 |    194 |        0 | Good parallel track on stable exported APIs                          |
| `@typescript-eslint/no-unsafe-call`                 |   174 |      0 |      174 | Warning-only, often paired with unsafe member access                 |
| `no-await-in-loop`                                  |   104 |      0 |      104 | Concurrency-sensitive warning; fix only with explicit ordering tests |
| `no-nested-ternary`                                 |    84 |     84 |        0 | Readability/error cleanup; low-risk with snapshots/assertions        |
| `n/no-process-exit`                                 |    75 |     75 |        0 | CLI semantics sensitive; add exit-path tests before change           |

### Hotspot files (original baseline)

| File                                 | Errors | Warnings |
| ------------------------------------ | -----: | -------: |
| `lib/hydra-operator.ts`              |    437 |    1,483 |
| `lib/hydra-evolve.ts`                |    282 |      336 |
| `lib/hydra-council.ts`               |    192 |      241 |
| `lib/hydra-ui.ts`                    |    168 |      289 |
| `lib/daemon/write-routes.ts`         |    147 |      136 |
| `lib/hydra-nightly.ts`               |    117 |      288 |
| `lib/hydra-usage.ts`                 |    110 |      406 |
| `lib/hydra-statusbar.ts`             |     99 |      148 |
| `lib/hydra-shared/agent-executor.ts` |     84 |      149 |
| `lib/hydra-evolve-review.ts`         |     83 |      125 |
| `lib/orchestrator-daemon.ts`         |     83 |       91 |

These hotspots are the best units for parallel work because each maps to a recognizable subsystem with localized behavior and tests.

## Test baseline

Direct test run summary:

- **906 tests**
- **123 suites**
- **887 passing**
- **19 todo**
- **0 failing**

One earlier `npm test` wrapper invocation returned non-zero despite a `# fail 0` trailer. A direct `node --test 'test/**/*.test.{ts,mjs}'` rerun exited `0`, so the baseline for planning purposes is currently green. If the wrapper anomaly recurs during implementation, it should become a short, separate investigation task.

## Test integrity constraints for remediation

The cleanup effort must begin by validating that the test suite is actually protecting behavior instead of just providing a green signal.

- Do **not** fake anything that can be exercised through real code paths.
- Do **not** disable, skip, or weaken failing tests just to make the suite pass.
- Do **not** treat `todo` tests as acceptable backlog during this effort; the current 19 test todos must be implemented or explicitly documented as candidates for rewrite/removal review.
- If a test is no longer relevant, over-mocked, or not exercising production behavior, document it so it can be investigated for replacement or deletion in a follow-up.

This means test quality is a prerequisite to trusting any lint-driven refactor that follows.

## Node 24 impact surface

The minimum-version upgrade touches more than `package.json`. Current confirmed touchpoints:

- `package.json` — `engines.node`, `@types/node`, and any scripts that should adopt `--strip-types`
- `package-lock.json` — lockfile refresh after dependency updates
- `tsconfig.json` — candidate `target`/`lib` move from `ES2022` to `ES2024`
- `.github/workflows/ci.yml`
- `.github/workflows/quality.yml`
- `.github/workflows/build-windows-exe.yml`
- `README.md`
- `CLAUDE.md`
- `HYDRA.md`

## Planning implications

1. **Do not use the old audit numbers** as execution targets.
2. **Treat Node 24 as a first-class phase**, not an afterthought, so lint fixes target the intended runtime semantics.
3. **Audit test integrity before code cleanup**, including the current `todo` coverage and any tests that avoid real code paths.
4. **Burn down lint by subsystem**, not by global search-and-replace.
5. **Add tests before semantics-changing fixes**, especially nullish/boolean/coalescing, async flow, CLI exits, and exported API typing changes.

---

## T0 Test Integrity Audit — phase-0/test-integrity

**Audit date:** 2026-03-12 (committed on branch `phase-0/test-integrity`)  
**Scope:** All 49 test files in `test/` (906 tests, 887 passing, 19 todo, 0 failing)

### Summary

| Metric                       | Count |
| ---------------------------- | ----: |
| Test files audited           |    49 |
| Total tests                  |   906 |
| Passing tests (pre-audit)    |   887 |
| Passing tests (post-audit)   |   888 |
| Todo stubs (all in worktree) |    19 |
| Tests rewritten              |     1 |
| Removal candidates           |     0 |
| Anomalies found              |     1 |

### Tests rewritten

**`test/hydra-model-recovery.test.mjs` — `recoverFromModelError` disabled-path test**

- **Before:** Test titled "returns recovered: false when recovery is disabled" but its assertion was `assert.equal(recovery.recovered, true)` — the title and the code were directly contradictory. The body contained an explanation saying it could not test the disabled path "without mocking."
- **Root cause:** `saveHydraConfig()` and `_setTestConfigPath()` are already imported in that file and already used in `beforeEach` to redirect config I/O to a temp dir. The disabled path was therefore fully testable using `saveHydraConfig({ modelRecovery: { enabled: false } })`.
- **Fix:** Replaced the body with a real assertion: call `saveHydraConfig({ modelRecovery: { enabled: false } })`, then assert `recovery.recovered === false` and `recovery.newModel === null`.
- **Verdict:** This was the only test in the suite where the title, the inline comment, and the assertion were all mutually inconsistent. No mock was needed or added.

### Anomalies found (non-critical)

**`test/hydra-action-pipeline.test.mjs` — export-only smoke tests**

Several describe blocks in this file (`hydra-action-pipeline`, `hydra-cleanup`, `hydra-doctor`) contain tests that only verify `typeof mod.fn === 'function'`. These are not fakes or mocks, but they exercise no code paths beyond the module loader. They are documented here for completeness; they are **not** removal candidates because they serve as import health checks and catch circular-dependency failures. No action required in T0.

---

## Accepted deferred integration coverage

**Source file:** `test/hydra-worktree-isolation.test.mjs`  
**Status:** 19 `it.todo` stubs — intentional, all verified as still valid  
**Unblocking change needed:** Export `createTaskWorktree`, `mergeTaskWorktree`, and `cleanupTaskWorktree` from `lib/hydra-worktree.ts` (or a dedicated `lib/hydra-worktree-ops.ts`) as named exports, and add a git-repo fixture helper to `test/helpers/`.

These stubs were written to document the intended contract of three daemon-internal functions that currently live inside `lib/hydra-worktree.ts` and are not exported. They cannot be unit-tested without either exporting the functions or spinning up a full integration daemon with a real git repo. The stubs describe valid, observable behavior; they are not aspirational.

### Group 1 — `createTaskWorktree` (4 stubs)

| Stub description                                 | What export/refactor unblocks it                                      |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| Creates worktree at `.hydra/worktrees/task-{id}` | Export `createTaskWorktree(taskId, cfg)` from `lib/hydra-worktree.ts` |
| Creates branch named `hydra/task/{id}`           | Same                                                                  |
| Returns absolute path on success                 | Same                                                                  |
| Returns `null` and logs warning on git failure   | Same; also needs a git-stub or tmp git repo fixture                   |

### Group 2 — `mergeTaskWorktree` (4 stubs)

| Stub description                                                | What export/refactor unblocks it                  |
| --------------------------------------------------------------- | ------------------------------------------------- |
| Calls `smartMerge(projectRoot, hydra/task/{id}, currentBranch)` | Export `mergeTaskWorktree(taskId, cfg)`           |
| Returns `{ ok: true }` on clean merge                           | Same + git repo fixture                           |
| Returns `{ ok: false, conflict: true }` on conflict             | Same + git repo fixture with conflicting branches |
| Returns `{ ok: false, error }` on exception                     | Same                                              |

### Group 3 — `cleanupTaskWorktree` (3 stubs)

| Stub description                            | What export/refactor unblocks it          |
| ------------------------------------------- | ----------------------------------------- |
| Removes worktree and deletes branch         | Export `cleanupTaskWorktree(taskId, cfg)` |
| `force=true` passes `--force`/`-D` flags    | Same                                      |
| Does not throw on git failure (best-effort) | Same                                      |

### Group 4 — daemon integration stubs (8 stubs)

These require a running daemon instance with `worktreeIsolation.enabled: true` in config. They belong in an integration test file, not the unit test file. The stubs document the intended observable behavior from the HTTP layer:

| Stub description                                                                 | Integration test precondition              |
| -------------------------------------------------------------------------------- | ------------------------------------------ |
| `enabled: false` → `/task/claim` does NOT call `createTaskWorktree`              | Daemon with `enabled: false` (default)     |
| `enabled: true` + `mode=tandem` → creates worktree on `/task/claim`              | Daemon with `enabled: true`, real git repo |
| `enabled: true` + `mode=council` → creates worktree on `/task/claim`             | Same                                       |
| Task completion with `worktreePath` calls `mergeTaskWorktree` via `/task/result` | Same                                       |
| Clean merge + `cleanupOnSuccess: true` → calls `cleanupTaskWorktree`             | Same                                       |
| Conflict merge → sets `worktreeConflict: true`, does NOT delete worktree         | Same                                       |
| `:cleanup` scanner finds `task-*` dirs older than 24h                            | Same + elapsed time or mocked clock        |
| `:tasks review` shows conflict worktrees when `worktreeConflict: true`           | Same + running operator console            |

---

## Coverage gap — uncovered lib files (T5 scope)

50 of 82 `lib/*.ts` files have no corresponding test file. This section records the gap for T5 (coverage expansion). Do not add coverage for these files in T0.

### Hotspot files (highest lint violation count — most important to cover before refactoring)

| File                    | ESLint errors | ESLint warnings |
| ----------------------- | ------------: | --------------: |
| `lib/hydra-operator.ts` |           437 |           1,483 |
| `lib/hydra-evolve.ts`   |           282 |             336 |
| `lib/hydra-council.ts`  |           192 |             241 |
| `lib/hydra-usage.ts`    |           110 |             406 |
| `lib/hydra-nightly.ts`  |           117 |             288 |

### Full list of uncovered lib files

```
lib/hydra-actualize.ts
lib/hydra-actualize-review.ts
lib/hydra-anthropic.ts
lib/hydra-audit.ts
lib/hydra-cleanup.ts          (import smoke tests exist in hydra-action-pipeline.test.mjs)
lib/hydra-cli-detect.ts
lib/hydra-concierge.ts
lib/hydra-config.ts           (diffConfig tested in hydra-config-diff.test.mjs; core untested)
lib/hydra-context.ts
lib/hydra-env.ts
lib/hydra-evolve.ts
lib/hydra-evolve-guardrails.ts
lib/hydra-evolve-investigator.ts
lib/hydra-evolve-knowledge.ts
lib/hydra-evolve-review.ts
lib/hydra-evolve-suggestions-cli.ts
lib/hydra-exec.ts
lib/hydra-google.ts
lib/hydra-investigator.ts
lib/hydra-knowledge.ts
lib/hydra-mcp-server.ts
lib/hydra-models.ts
lib/hydra-models-select.ts
lib/hydra-nightly.ts
lib/hydra-nightly-discovery.ts
lib/hydra-nightly-review.ts
lib/hydra-openai.ts
lib/hydra-operator.ts
lib/hydra-output-history.ts   (import smoke tests exist in hydra-action-pipeline.test.mjs)
lib/hydra-persona.ts
lib/hydra-provider-usage.ts
lib/hydra-rate-limits.ts
lib/hydra-resume-scanner.ts
lib/hydra-roster.ts
lib/hydra-routing-constants.ts
lib/hydra-self-index.ts       (tested indirectly via hydra-self.test.mjs)
lib/hydra-statusbar.ts
lib/hydra-sub-agents.ts
lib/hydra-tasks.ts
lib/hydra-tasks-review.ts
lib/hydra-tasks-scanner.ts
lib/hydra-updater.ts
lib/hydra-usage.ts
lib/hydra-version.ts
lib/hydra-worker.ts
lib/hydra-worktree.ts
lib/orchestrator-client.ts
lib/orchestrator-daemon.ts    (integration tests in orchestrator-daemon.integration.test.mjs)
lib/sync.ts
lib/types.ts                  (partially tested in hydra-types.test.ts)
```

### Highest-volume rules

| Rule                                                | Total | Errors | Warnings | Meaning for planning                                                 |
| --------------------------------------------------- | ----: | -----: | -------: | -------------------------------------------------------------------- |
| `@typescript-eslint/strict-boolean-expressions`     | 2,828 |      0 |    2,828 | Large warning-only campaign; defer until targeted module tests exist |
| `@typescript-eslint/no-unsafe-member-access`        | 1,347 |      0 |    1,347 | Mostly requires better local typing and guards                       |
| `@typescript-eslint/prefer-nullish-coalescing`      | 1,005 |  1,005 |        0 | High-value mechanical/error cleanup with behavior review             |
| `@typescript-eslint/restrict-template-expressions`  |   823 |    823 |        0 | Needs explicit string normalization helpers                          |
| `@typescript-eslint/no-unsafe-assignment`           |   530 |      0 |      530 | Warning-only, often follows from missing narrowing                   |
| `@typescript-eslint/no-unnecessary-condition`       |   357 |    357 |        0 | Safe only with tests around fallback/config logic                    |
| `@typescript-eslint/no-explicit-any`                |   335 |      0 |      335 | Warning-only, best fixed opportunistically                           |
| `@typescript-eslint/no-unsafe-argument`             |   259 |      0 |      259 | Often falls as types improve                                         |
| `@typescript-eslint/explicit-module-boundary-types` |   194 |    194 |        0 | Good parallel track on stable exported APIs                          |
| `@typescript-eslint/no-unsafe-call`                 |   174 |      0 |      174 | Warning-only, often paired with unsafe member access                 |
| `no-await-in-loop`                                  |   104 |      0 |      104 | Concurrency-sensitive warning; fix only with explicit ordering tests |
| `no-nested-ternary`                                 |    84 |     84 |        0 | Readability/error cleanup; low-risk with snapshots/assertions        |
| `n/no-process-exit`                                 |    75 |     75 |        0 | CLI semantics sensitive; add exit-path tests before change           |

### Hotspot files

| File                                 | Errors | Warnings |
| ------------------------------------ | -----: | -------: |
| `lib/hydra-operator.ts`              |    437 |    1,483 |
| `lib/hydra-evolve.ts`                |    282 |      336 |
| `lib/hydra-council.ts`               |    192 |      241 |
| `lib/hydra-ui.ts`                    |    168 |      289 |
| `lib/daemon/write-routes.ts`         |    147 |      136 |
| `lib/hydra-nightly.ts`               |    117 |      288 |
| `lib/hydra-usage.ts`                 |    110 |      406 |
| `lib/hydra-statusbar.ts`             |     99 |      148 |
| `lib/hydra-shared/agent-executor.ts` |     84 |      149 |
| `lib/hydra-evolve-review.ts`         |     83 |      125 |
| `lib/orchestrator-daemon.ts`         |     83 |       91 |

These hotspots are the best units for parallel work because each maps to a recognizable subsystem with localized behavior and tests.

## Test baseline

Direct test run summary:

- **906 tests**
- **123 suites**
- **887 passing**
- **19 todo**
- **0 failing**

One earlier `npm test` wrapper invocation returned non-zero despite a `# fail 0` trailer. A direct `node --test 'test/**/*.test.{ts,mjs}'` rerun exited `0`, so the baseline for planning purposes is currently green. If the wrapper anomaly recurs during implementation, it should become a short, separate investigation task.

## Test integrity constraints for remediation

The cleanup effort must begin by validating that the test suite is actually protecting behavior instead of just providing a green signal.

- Do **not** fake anything that can be exercised through real code paths.
- Do **not** disable, skip, or weaken failing tests just to make the suite pass.
- Do **not** treat `todo` tests as acceptable backlog during this effort; the current 19 test todos must be implemented or explicitly documented as candidates for rewrite/removal review.
- If a test is no longer relevant, over-mocked, or not exercising production behavior, document it so it can be investigated for replacement or deletion in a follow-up.

This means test quality is a prerequisite to trusting any lint-driven refactor that follows.

## Node 24 impact surface

The minimum-version upgrade touches more than `package.json`. Current confirmed touchpoints:

- `package.json` — `engines.node`, `@types/node`, and any scripts that should adopt `--strip-types`
- `package-lock.json` — lockfile refresh after dependency updates
- `tsconfig.json` — candidate `target`/`lib` move from `ES2022` to `ES2024`
- `.github/workflows/ci.yml`
- `.github/workflows/quality.yml`
- `.github/workflows/build-windows-exe.yml`
- `README.md`
- `CLAUDE.md`
- `HYDRA.md`

## Planning implications

1. **Do not use the old audit numbers** as execution targets.
2. **Treat Node 24 as a first-class phase**, not an afterthought, so lint fixes target the intended runtime semantics.
3. **Audit test integrity before code cleanup**, including the current `todo` coverage and any tests that avoid real code paths.
4. **Burn down lint by subsystem**, not by global search-and-replace.
5. **Add tests before semantics-changing fixes**, especially nullish/boolean/coalescing, async flow, CLI exits, and exported API typing changes.

---

## T0 Test Integrity Audit — phase-0/test-integrity

**Audit date:** 2026-03-12 (committed on branch `phase-0/test-integrity`)  
**Scope:** All 49 test files in `test/` (906 tests, 887 passing, 19 todo, 0 failing)

### Summary

| Metric                       | Count |
| ---------------------------- | ----: |
| Test files audited           |    49 |
| Total tests                  |   906 |
| Passing tests (pre-audit)    |   887 |
| Passing tests (post-audit)   |   888 |
| Todo stubs (all in worktree) |    19 |
| Tests rewritten              |     1 |
| Removal candidates           |     0 |
| Anomalies found              |     1 |

### Tests rewritten

**`test/hydra-model-recovery.test.mjs` — `recoverFromModelError` disabled-path test**

- **Before:** Test titled "returns recovered: false when recovery is disabled" but its assertion was `assert.equal(recovery.recovered, true)` — the title and the code were directly contradictory. The body contained an explanation saying it could not test the disabled path "without mocking."
- **Root cause:** `saveHydraConfig()` and `_setTestConfigPath()` are already imported in that file and already used in `beforeEach` to redirect config I/O to a temp dir. The disabled path was therefore fully testable using `saveHydraConfig({ modelRecovery: { enabled: false } })`.
- **Fix:** Replaced the body with a real assertion: call `saveHydraConfig({ modelRecovery: { enabled: false } })`, then assert `recovery.recovered === false` and `recovery.newModel === null`.
- **Verdict:** This was the only test in the suite where the title, the inline comment, and the assertion were all mutually inconsistent. No mock was needed or added.

### Anomalies found (non-critical)

**`test/hydra-action-pipeline.test.mjs` — export-only smoke tests**

Several describe blocks in this file (`hydra-action-pipeline`, `hydra-cleanup`, `hydra-doctor`) contain tests that only verify `typeof mod.fn === 'function'`. These are not fakes or mocks, but they exercise no code paths beyond the module loader. They are documented here for completeness; they are **not** removal candidates because they serve as import health checks and catch circular-dependency failures. No action required in T0.

---

## Accepted deferred integration coverage

**Source file:** `test/hydra-worktree-isolation.test.mjs`  
**Status:** 19 `it.todo` stubs — intentional, all verified as still valid  
**Unblocking change needed:** Export `createTaskWorktree`, `mergeTaskWorktree`, and `cleanupTaskWorktree` from `lib/hydra-worktree.ts` (or a dedicated `lib/hydra-worktree-ops.ts`) as named exports, and add a git-repo fixture helper to `test/helpers/`.

These stubs were written to document the intended contract of three daemon-internal functions that currently live inside `lib/hydra-worktree.ts` and are not exported. They cannot be unit-tested without either exporting the functions or spinning up a full integration daemon with a real git repo. The stubs describe valid, observable behavior; they are not aspirational.

### Group 1 — `createTaskWorktree` (4 stubs)

| Stub description                                 | What export/refactor unblocks it                                      |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| Creates worktree at `.hydra/worktrees/task-{id}` | Export `createTaskWorktree(taskId, cfg)` from `lib/hydra-worktree.ts` |
| Creates branch named `hydra/task/{id}`           | Same                                                                  |
| Returns absolute path on success                 | Same                                                                  |
| Returns `null` and logs warning on git failure   | Same; also needs a git-stub or tmp git repo fixture                   |

### Group 2 — `mergeTaskWorktree` (4 stubs)

| Stub description                                                | What export/refactor unblocks it                  |
| --------------------------------------------------------------- | ------------------------------------------------- |
| Calls `smartMerge(projectRoot, hydra/task/{id}, currentBranch)` | Export `mergeTaskWorktree(taskId, cfg)`           |
| Returns `{ ok: true }` on clean merge                           | Same + git repo fixture                           |
| Returns `{ ok: false, conflict: true }` on conflict             | Same + git repo fixture with conflicting branches |
| Returns `{ ok: false, error }` on exception                     | Same                                              |

### Group 3 — `cleanupTaskWorktree` (3 stubs)

| Stub description                            | What export/refactor unblocks it          |
| ------------------------------------------- | ----------------------------------------- |
| Removes worktree and deletes branch         | Export `cleanupTaskWorktree(taskId, cfg)` |
| `force=true` passes `--force`/`-D` flags    | Same                                      |
| Does not throw on git failure (best-effort) | Same                                      |

### Group 4 — daemon integration stubs (8 stubs)

These require a running daemon instance with `worktreeIsolation.enabled: true` in config. They belong in an integration test file, not the unit test file. The stubs document the intended observable behavior from the HTTP layer:

| Stub description                                                                 | Integration test precondition              |
| -------------------------------------------------------------------------------- | ------------------------------------------ |
| `enabled: false` → `/task/claim` does NOT call `createTaskWorktree`              | Daemon with `enabled: false` (default)     |
| `enabled: true` + `mode=tandem` → creates worktree on `/task/claim`              | Daemon with `enabled: true`, real git repo |
| `enabled: true` + `mode=council` → creates worktree on `/task/claim`             | Same                                       |
| Task completion with `worktreePath` calls `mergeTaskWorktree` via `/task/result` | Same                                       |
| Clean merge + `cleanupOnSuccess: true` → calls `cleanupTaskWorktree`             | Same                                       |
| Conflict merge → sets `worktreeConflict: true`, does NOT delete worktree         | Same                                       |
| `:cleanup` scanner finds `task-*` dirs older than 24h                            | Same + elapsed time or mocked clock        |
| `:tasks review` shows conflict worktrees when `worktreeConflict: true`           | Same + running operator console            |

---

## Coverage gap — uncovered lib files (T5 scope)

50 of 82 `lib/*.ts` files have no corresponding test file. This section records the gap for T5 (coverage expansion). Do not add coverage for these files in T0.

### Hotspot files (highest lint violation count — most important to cover before refactoring)

| File                    | ESLint errors | ESLint warnings |
| ----------------------- | ------------: | --------------: |
| `lib/hydra-operator.ts` |           437 |           1,483 |
| `lib/hydra-evolve.ts`   |           282 |             336 |
| `lib/hydra-council.ts`  |           192 |             241 |
| `lib/hydra-usage.ts`    |           110 |             406 |
| `lib/hydra-nightly.ts`  |           117 |             288 |

### Full list of uncovered lib files

```
lib/hydra-actualize.ts
lib/hydra-actualize-review.ts
lib/hydra-anthropic.ts
lib/hydra-audit.ts
lib/hydra-cleanup.ts          (import smoke tests exist in hydra-action-pipeline.test.mjs)
lib/hydra-cli-detect.ts
lib/hydra-concierge.ts
lib/hydra-config.ts           (diffConfig tested in hydra-config-diff.test.mjs; core untested)
lib/hydra-context.ts
lib/hydra-env.ts
lib/hydra-evolve.ts
lib/hydra-evolve-guardrails.ts
lib/hydra-evolve-investigator.ts
lib/hydra-evolve-knowledge.ts
lib/hydra-evolve-review.ts
lib/hydra-evolve-suggestions-cli.ts
lib/hydra-exec.ts
lib/hydra-google.ts
lib/hydra-investigator.ts
lib/hydra-knowledge.ts
lib/hydra-mcp-server.ts
lib/hydra-models.ts
lib/hydra-models-select.ts
lib/hydra-nightly.ts
lib/hydra-nightly-discovery.ts
lib/hydra-nightly-review.ts
lib/hydra-openai.ts
lib/hydra-operator.ts
lib/hydra-output-history.ts   (import smoke tests exist in hydra-action-pipeline.test.mjs)
lib/hydra-persona.ts
lib/hydra-provider-usage.ts
lib/hydra-rate-limits.ts
lib/hydra-resume-scanner.ts
lib/hydra-roster.ts
lib/hydra-routing-constants.ts
lib/hydra-self-index.ts       (tested indirectly via hydra-self.test.mjs)
lib/hydra-statusbar.ts
lib/hydra-sub-agents.ts
lib/hydra-tasks.ts
lib/hydra-tasks-review.ts
lib/hydra-tasks-scanner.ts
lib/hydra-updater.ts
lib/hydra-usage.ts
lib/hydra-version.ts
lib/hydra-worker.ts
lib/hydra-worktree.ts
lib/orchestrator-client.ts
lib/orchestrator-daemon.ts    (integration tests in orchestrator-daemon.integration.test.mjs)
lib/sync.ts
lib/types.ts                  (partially tested in hydra-types.test.ts)
```
