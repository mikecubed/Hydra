# Quality + Node 24 Remediation Roadmap

**Status:** ✅ COMPLETE  
**Branch:** `chore/quality-node24-plan`  
**PR:** [#17](https://github.com/mikecubed/Hydra/pull/17) — merged  
**Inputs:** `docs/quality-baseline-2026-03-12.md`, `docs/plans/2026-03-11-node24-upgrade.md`

## Final results

| Check      | Before                        | After                           |
| ---------- | ----------------------------- | ------------------------------- |
| ESLint     | 2,975 errors / 5,777 warnings | **0 errors / 567 warnings**     |
| TypeScript | Clean                         | **Clean** (strict, no bypasses) |
| Prettier   | Clean                         | **Clean**                       |
| Tests      | 887 pass / 19 todo / 0 fail   | **939 pass / 19 todo / 0 fail** |
| Node min   | 22 LTS                        | **24 LTS**                      |
| CI         | `continue-on-error` on 4 jobs | **All gates strict**            |

All 17 PRs (#18–#36) merged into `chore/quality-node24-plan`. CI is green with no bypasses.

---

## Goal

Reach the cleanest safe baseline we can on the current TypeScript-first codebase by:

1. validating that the test suite exercises real behavior and contains no placeholder `todo` coverage,
2. raising the minimum supported runtime to **Node 24 LTS**,
3. eliminating current **ESLint errors**,
4. reducing the highest-value **ESLint warnings** without destabilizing behavior, and
5. adding tests anywhere lint-driven refactors could change runtime semantics.

## Non-goals

- Do not chase cosmetic rewrites that are unrelated to current lint debt.
- Do not force every warning to zero in the same pass if the fix requires broad design changes.
- Do not mass-apply truthiness or async refactors without tests around the affected behavior.
- Do not disable, skip, weaken, or over-mock tests to manufacture a green baseline.

## Working assumptions

- `npm run typecheck` is already green, so the plan focuses on ESLint and Node runtime alignment.
- `npm run format:check` is already green.
- The safest parallelization unit is **subsystem ownership** rather than a repo-wide rule-by-rule sweep.

## Delivery strategy

The work should proceed in **phases**, with **parallel workstreams inside each phase** wherever the dependencies allow it.

## Phase 0 — Test integrity audit

**Objective:** Verify that the test suite is worth trusting before it is used as the safety net for cleanup work.

### Scope

- Inventory all `todo` tests and convert them into implemented coverage.
- Identify tests that bypass real code paths through unnecessary fakes or stubs when production code can be executed directly.
- Identify tests that are stale, irrelevant, or not asserting meaningful behavior.
- Document any test that looks removable or in need of rewrite rather than silently deleting it.

### Hard rules

- No disabling or weakening tests to make the suite pass.
- No fake implementations when the real code path is practical to exercise.
- No leaving `todo` tests in place as accepted debt for this initiative.
- No “cheating” via assertions that only verify mocks instead of behavior.

### Parallel workstreams

#### 0A — Todo test conversion

- Enumerate the current `todo` tests.
- The 19 `todo` tests in `test/hydra-worktree-isolation.test.mjs` are **intentional integration stubs** — the file header explicitly documents that `createTaskWorktree`, `mergeTaskWorktree`, and `cleanupTaskWorktree` are daemon-internal and not exported. These cannot be unit-tested without refactoring the daemon's exports.
- For these stubs: confirm they still describe valid future integration work, document them formally as "accepted deferred integration coverage", and record what export/daemon changes would be needed to make them testable.
- Any `todo` test outside this file, or any newly discovered one, must be implemented or classified as invalid/outdated coverage requiring documented review.

#### 0B — Real-path audit

- Review hotspot test files for excessive mocking or helper indirection that avoids production paths.
- Replace fake-path coverage with real-path coverage where safe and practical.

#### 0C — Relevance audit

- Record tests that no longer match the current architecture, inputs, or public behavior.
- Produce a documented follow-up list for removal/rewrite candidates instead of silently deleting them.

### Validation

- `node --test 'test/**/*.test.{ts,mjs}'`
- Targeted reruns for every touched test module

### Exit criteria

- No `todo` tests remain unaddressed.
- Any questionable tests are documented for follow-up review.
- The suite is judged trustworthy enough to guard later refactors.

## Phase 1 — Baseline lock _(folded into T0 exit criteria)_

**Note:** This phase has no independent deliverables. Its outcome is captured as part of T0's exit criteria. When T0 completes, `docs/quality-baseline-2026-03-12.md` should be updated with any anomalies found during the test audit, and the baseline doc is considered locked.

- Confirm `docs/quality-baseline-2026-03-12.md` is current with any anomalies found during Phase 0.
- Record canonical validation commands (see task list).
- This is **not a blocking gate** — it merges with T0.

## Phase 2 — Node 24 foundation

**Objective:** Move the repo to Node 24 LTS first so the rest of the cleanup targets the intended runtime.

### Scope

- `package.json`
  - bump `engines.node` to `>=24.0.0`
  - bump `@types/node` to the Node 24 line
  - decide whether to keep `tsx` temporarily or move scripts to `node --strip-types`
- `package-lock.json`
- `tsconfig.json`
  - evaluate `target`/`lib` move from `ES2022` to `ES2024`
- CI workflows
  - `.github/workflows/ci.yml`
  - `.github/workflows/quality.yml`
  - `.github/workflows/build-windows-exe.yml`
- docs
  - `README.md`
  - `CLAUDE.md`
  - `HYDRA.md`

### Parallel workstreams

#### 2A — Runtime and dependency lane

- Update Node engine and `@types/node`
- Refresh the lockfile
- Decide whether `tsx` removal is same-phase or a follow-up

#### 2B — CI lane

- Move required workflows to Node 24
- Keep any temporary compatibility checks non-blocking if they remain at all

#### 2C — Documentation lane

- Update all developer- and user-facing minimum-version references
- Document whether `--strip-types` is now the preferred runtime path

### Tests and validation

- `npm install`
- `npm run quality`
- `node --test 'test/**/*.test.{ts,mjs}'`
- If script execution changes, run smoke commands for representative entrypoints:
  - `npm run go -- --help` if safe
  - `npm start -- --help` if supported
  - `npm run setup -- --help` or targeted direct script invocations where supported

### Exit criteria

- Node 24 is the documented and enforced minimum.
- CI config matches the supported runtime story.
- All baseline validation commands still pass.

## Phase 3 — Shared lint scaffolding and test hardening

**Objective:** Add or extend tests before behavior-sensitive lint refactors start landing.

### Priority test targets

- CLI exit semantics around files flagged by `n/no-process-exit`
- Nullish/defaulting behavior in config loading, UI rendering, routing, and status output
- Async ordering or intentional serial behavior in files flagged by `no-await-in-loop`
- Public/exported helpers that will receive explicit return and parameter types

### Parallel workstreams

#### 3A — CLI contract tests

- Add tests that assert exit code, stderr/stdout shape, and non-abrupt termination behavior for CLI entrypoints and error paths

#### 3B — Async behavior tests

- Add tests for sequencing-sensitive loops before converting any to batched or helper-based flows

#### 3C — Config/defaulting tests

- Lock down behavior around optional values before `prefer-nullish-coalescing` and `no-unnecessary-condition` fixes

### Exit criteria

- Every risky lint class has a test harness ready in at least the hotspot modules that will be touched first.

## Phase 4 — Error-first ESLint remediation

**Objective:** Burn down current ESLint **errors** with the highest confidence and smallest semantic blast radius first.

### Error groups to prioritize

1. `@typescript-eslint/prefer-nullish-coalescing` — 1,005
2. `@typescript-eslint/restrict-template-expressions` — 823
3. `@typescript-eslint/no-unnecessary-condition` — 357
4. `@typescript-eslint/explicit-module-boundary-types` — 194
5. `no-nested-ternary` — 84
6. `n/no-process-exit` — 75 (see note below)
7. `@typescript-eslint/no-unnecessary-type-conversion` — 69
8. `@typescript-eslint/no-unnecessary-type-assertion` — 61
9. `@typescript-eslint/require-await` — 17 (may require interface changes)
10. `@typescript-eslint/restrict-plus-operands` — 18
11. `require-atomic-updates` / `no-promise-executor-return` / `n/hashbang` and smaller tails

> **`n/no-process-exit` note:** 87 occurrences across the codebase. Simple replacements with `process.exitCode = X; return` only work when the call-site can actually return to a caller. Calls inside callbacks, event handlers, and deeply nested async functions require case-by-case categorization. This rule must be treated as a dedicated subtask inside each subsystem lane — not a bulk find-and-replace.

> **Coverage gap:** The four primary lanes below cover the hottest 16 files (approximately 62% of all errors). An additional 1,140 errors and 2,255 warnings exist across 65+ smaller files. These are assigned to lanes 3E and 3F and the shared-supplemental pass in Phase 5.

### Parallel subsystem workstreams

#### 3A — Operator + UI

Primary files:

- `lib/hydra-operator.ts`
- `lib/hydra-ui.ts`
- `lib/hydra-statusbar.ts`
- `lib/hydra-prompt-choice.ts`

Focus:

- nullish/defaulting correctness
- display-safe string conversion
- explicit exported API signatures

#### 3B — Automation pipelines

Primary files:

- `lib/hydra-evolve.ts`
- `lib/hydra-nightly.ts`
- `lib/hydra-evolve-review.ts`
- `lib/hydra-actualize.ts`
- review/status companions

Focus:

- branch/task data normalization
- template-expression cleanup
- explicit return types on helpers

#### 3C — Daemon + routes

Primary files:

- `lib/orchestrator-daemon.ts`
- `lib/daemon/write-routes.ts`
- `lib/orchestrator-client.ts`

Focus:

- request payload narrowing
- exit/error-path cleanup
- conditional simplification guarded by integration tests

#### 3D — Shared agent/runtime core

Primary files:

- `lib/hydra-shared/agent-executor.ts`
- `lib/hydra-agents.ts`
- `lib/hydra-model-recovery.ts`
- `lib/hydra-mcp-server.ts`
- `lib/hydra-mcp.ts`

Focus:

- explicit API boundaries
- safer stringification
- helper extraction for repeated narrowing patterns

#### 3E — Council and deliberation

Primary files:

- `lib/hydra-council.ts` (192E/241W — third hottest file)
- `lib/hydra-concierge.ts`
- `lib/hydra-context.ts`
- `lib/hydra-streaming-middleware.ts`

Focus:

- nullish/defaulting cleanup
- unsafe-member-access reduction in council pipeline
- template expression safety
- explicit return types on exported helpers

#### 3F — Supplemental high-debt files

Primary files (representative subset; owner triages remaining files):

- `lib/hydra-usage.ts` (110E/406W)
- `lib/hydra-tasks.ts` (71E/75W)
- `lib/hydra-worker.ts` (54E/55W)
- `lib/hydra-evolve-suggestions.ts` (57E/46W)
- `lib/hydra-evolve-investigator.ts`
- `lib/hydra-nightly-review.ts`
- `lib/hydra-actualize-review.ts`
- `lib/hydra-models-select.ts`
- all remaining files with errors not covered by lanes 3A-3E

Focus:

- same rule priorities as other lanes
- owner claims files from the uncovered list in the task doc to avoid double-work

### Recommended working pattern inside each stream

1. Write or extend tests for the target behavior.
2. Fix one rule family at a time inside the subsystem.
3. Run the narrowest relevant test file(s), then repo-wide validation before merge.

### Exit criteria

- ESLint error count is reduced to zero, or any remaining errors are explicitly documented as blocked with file-level rationale.

## Phase 5 — Warning reduction with guardrails

**Objective:** Reduce warnings that are valuable and safe without turning the effort into a full redesign.

### Warning families to target first

1. `@typescript-eslint/no-unsafe-member-access`
2. `@typescript-eslint/no-unsafe-assignment`
3. `@typescript-eslint/no-unsafe-argument`
4. `@typescript-eslint/no-unsafe-call`
5. `@typescript-eslint/no-unsafe-return`
6. `no-await-in-loop`
7. `@typescript-eslint/strict-boolean-expressions`

### Strategy

- Prefer introducing local types, guards, and helper functions over assertion-heavy fixes.
- Treat `strict-boolean-expressions` as the final large warning campaign; most of its fixes are semantics-adjacent and should follow earlier narrowing work.
- Convert `no-await-in-loop` only when concurrency is truly safe; otherwise document intentional sequencing locally.

### Parallelism

Reuse the same six subsystem streams from Phase 4 so owners can keep context and tests.

### Exit criteria

- High-signal unsafe-operation warnings are substantially reduced.
- Remaining warning families are either low priority or intentionally deferred with documented rationale.

## Phase 6 — CI tightening and final cleanup

**Objective:** Turn the cleaned baseline into an enforced baseline.

### Scope

- Revisit `continue-on-error` in `.github/workflows/quality.yml`
- Recheck whether any lint rules should be promoted or relaxed after cleanup
- Remove any temporary compatibility shims or transitional comments added during the Node 24 upgrade

### Validation

- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `node --test 'test/**/*.test.{ts,mjs}'`
- CI dry run or PR validation where available

### Exit criteria

- CI reflects the new reality instead of accommodating the old baseline.

## Recommended execution order across branches

**Phase 0 must land before anything else.**

1. `phase-0/test-integrity` (T0 — Lane A)
2. `phase-2/node24-foundation` (T2 — Lane B) — runs once T0 merges; T5 can start in parallel on a separate branch
3. `phase-3/test-guardrails` (T5 — supplemental test hardening; can parallel with T2)
4. `phase-2b/ci-node24` (T3 — Lane C; starts once T2 merges)
5. `phase-2c/docs-node24` (T4 — Lane C; parallel with T3)
6. `phase-4a/operator-ui-errors` (T6A — Lane D)
7. `phase-4b/pipeline-errors` (T6B — Lane E)
8. `phase-4c/daemon-errors` (T6C — Lane F)
9. `phase-4d/shared-runtime-errors` (T6D — Lane G)
10. `phase-4e/council-errors` (T6E — Lane H)
11. `phase-4f/supplemental-errors` (T6F — Lane I)
12. `phase-5/warnings-burn-down` (T7A-T7F — parallel by subsystem)
13. `phase-6/ci-tightening` (T8)

Branches 6–11 are fully parallel once T2 and T5 both land. Each branch is owned by its lane.

> **Note:** Phase 1 ("Baseline lock") is folded into T0's exit criteria. The working branch for all execution is the one created from `chore/quality-node24-plan`.

## What should get tests as a hard rule

- Any change that swaps `||` for `??`
- Any change that simplifies conditionals based on `no-unnecessary-condition`
- Any change to `process.exit` behavior
- Any change that parallelizes former sequential async work
- Any change to exported function signatures that affects input or output normalization
- Any change that replaces fake-path coverage with real-path execution

## Success definition

The project should end this effort with:

- a trustworthy, non-placeholder test suite with no unresolved `todo` tests
- Node 24 LTS as the minimum supported runtime
- current docs aligned with that runtime
- a clean `tsc` baseline preserved
- ESLint errors removed or explicitly blocked with rationale
- warning count materially reduced in the highest-value categories
- tests added where lint-driven refactors could otherwise change behavior silently
