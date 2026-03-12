# Quality + Node 24 Task List — 2026-03-12

**Parent roadmap:** `docs/plans/2026-03-12-quality-node24-remediation-roadmap.md`  
**Draft PR:** `#17`  
**Goal:** Turn the roadmap into an execution-ready, dependency-ordered task list that can be claimed in parallel once prerequisite phases land.

## Global rules

- Every task must preserve or improve real behavioral coverage.
- Do **not** disable, skip, weaken, or over-mock tests to get green.
- Do **not** leave `todo` tests behind (see T0 for the intentional stubs exception).
- If a check, rule, or test must be relaxed temporarily, the reason must be documented in the relevant task PR and in the touched file when appropriate.
- Every modified code file must pass linting and type-checking before merge.
- Use the narrowest possible test run while developing, then run the phase-level validation before merge.
- **Rollback policy:** If a parallel lane breaks passing tests on merge, revert the offending PR immediately. Do not hotfix a broken merge in-place. Re-land only after root cause is identified and the failing test is green on the feature branch.

## Canonical validation commands

### Full validation

```bash
npm run lint
npm run format:check
npm run typecheck
node --test 'test/**/*.test.{ts,mjs}'
```

### Markdown planning-doc validation

```bash
./node_modules/.bin/prettier --check docs/**/*.md
npm run lint:mermaid
```

## Dependency graph

```text
T0  test-integrity-audit
T2  node24-runtime                   depends on T0
T3  ci-node24                        depends on T2
T4  docs-node24                      depends on T2
T5  test-hardening                   depends on T0  ← can run in parallel with T2
T6A operator-ui-errors               depends on T2, T5
T6B pipeline-errors                  depends on T2, T5
T6C daemon-route-errors              depends on T2, T5
T6D shared-runtime-errors            depends on T2, T5
T6E council-deliberation-errors      depends on T2, T5
T6F supplemental-errors              depends on T2, T5
T7A operator-ui-warnings             depends on T6A
T7B pipeline-warnings                depends on T6B
T7C daemon-route-warnings            depends on T6C
T7D shared-runtime-warnings          depends on T6D
T7E council-deliberation-warnings    depends on T6E
T7F supplemental-warnings            depends on T6F
T8  ci-tightening                    depends on T7A, T7B, T7C, T7D, T7E, T7F
```

> **T1 (Baseline lock) has been folded into T0's exit criteria.** There is no separate blocking T1 gate — updating `docs/quality-baseline-2026-03-12.md` with T0 findings is part of T0.
>
> **T5 can start immediately after T0**, in parallel with T2. Test hardening files do not require Node 24 to be running — they only require the test suite to be trustworthy (T0 complete).

## Task list

> **✅ ALL TASKS COMPLETE** — T0–T8 fully merged into `chore/quality-node24-plan` (PR #17).
> Final state: 0 ESLint errors / 567 warnings / 0 TypeScript errors / 939 tests pass.
> CI is fully green with no `continue-on-error` bypasses remaining.

## T0 — Test integrity audit

**Status: ✅ DONE** — merged PR #18  

**Objective:** Make the suite trustworthy before it becomes the safety net for refactors.

### Deliverables

- **Todo stubs:** All 19 `todo` tests are in `test/hydra-worktree-isolation.test.mjs`. They are **intentional integration stubs** for daemon-internal functions that are not exported (`createTaskWorktree`, `mergeTaskWorktree`, `cleanupTaskWorktree`). The file header documents why. For each stub: confirm it still describes valid future work and record it formally in the baseline doc as "accepted deferred integration coverage". Record what export/refactor changes would unblock them.
- Audit tests that use fakes where real code paths are available.
- Produce a removal/rewrite candidate list for stale or low-value tests.
- Update `docs/quality-baseline-2026-03-12.md` with any anomalies found (this replaces the former T1 "baseline lock" gate).

### Coverage gap note

50 of 82 `lib/*.ts` files have no corresponding test file. The hotspot files (`hydra-operator.ts`, `hydra-evolve.ts`, `hydra-council.ts`, etc.) are all in this group. T0 should record this gap; adding coverage for uncovered files is a T5 responsibility, not a T0 blocker.

### Suggested validation

- `node --test 'test/**/*.test.{ts,mjs}'`
- rerun every touched test file directly

### Notes

- This task blocks everything else.
- Prefer documenting questionable tests in a dedicated appendix or follow-up doc instead of deleting them in the same pass.

## T2 — Node 24 runtime foundation

**Status: ✅ DONE** — merged PR #19  

**Objective:** Raise the minimum supported runtime to Node 24 LTS in code and dependencies.

### Deliverables

- update `package.json` engine and runtime-related dev dependencies
- refresh `package-lock.json`
- update `tsconfig.json` runtime target/lib if approved
- evaluate whether `tsx` remains necessary or can be replaced by `node --strip-types`

### Suggested validation

- `npm install`
- `npm run typecheck`
- `node --test 'test/**/*.test.{ts,mjs}'`

### Constraints

- Do not remove `tsx` unless all script entrypoints are verified.
- Any transitional choice must be documented.

## T3 — CI Node 24 alignment

**Status: ✅ DONE** — merged PR #20  

**Objective:** Make GitHub Actions match the supported runtime story.

### Deliverables

- update `.github/workflows/ci.yml`
- update `.github/workflows/quality.yml`
- update `.github/workflows/build-windows-exe.yml`
- document any temporary matrix overlap if retained

### Suggested validation

- lint workflow YAML formatting
- re-check workflow docs references
- run `npm run typecheck`

## T4 — Docs Node 24 alignment

**Status: ✅ DONE** — merged PR #21  

**Objective:** Update all human-facing runtime and workflow documentation.

### Deliverables

- update `README.md`
- update `CLAUDE.md`
- update `HYDRA.md`
- update any affected plan or handoff docs that still claim Node 22 as minimum

### Suggested validation

- `./node_modules/.bin/prettier --check README.md CLAUDE.md HYDRA.md docs/**/*.md`
- `npm run lint:mermaid`

## T5 — Shared test hardening

**Status: ✅ DONE** — merged PR #22  

**Objective:** Add the tests needed to make the lint cleanup safe.

### Deliverables

- CLI exit-path tests
- nullish/defaulting tests
- async-ordering tests
- exported-API contract tests for hotspot helpers

### Suggested validation

- targeted `node --test` runs for every new or changed test file
- `npm run typecheck`

## T6A — Operator/UI error cleanup

**Status: ✅ DONE** — merged PR #33  

**Target files**

- `lib/hydra-operator.ts`
- `lib/hydra-ui.ts`
- `lib/hydra-statusbar.ts`
- `lib/hydra-prompt-choice.ts`

### Priority rules

- `@typescript-eslint/prefer-nullish-coalescing`
- `@typescript-eslint/restrict-template-expressions`
- `@typescript-eslint/no-unnecessary-condition`
- `@typescript-eslint/explicit-module-boundary-types`
- `no-nested-ternary`

### Suggested validation

- targeted UI/operator tests
- `npm run typecheck`
- lint on touched files plus full lint before merge

## T6B — Pipeline error cleanup

**Status: ✅ DONE** — merged PR #23  

**Target files**

- `lib/hydra-evolve.ts`
- `lib/hydra-nightly.ts`
- `lib/hydra-actualize.ts`
- review/status companions

### Priority rules

- same as T6A, plus any pipeline-specific template/string normalization issues

### Suggested validation

- targeted pipeline tests
- `npm run typecheck`

## T6C — Daemon/route error cleanup

**Status: ✅ DONE** — merged PR #24  

**Target files**

- `lib/orchestrator-daemon.ts`
- `lib/daemon/write-routes.ts`
- `lib/orchestrator-client.ts`

### Priority rules

- `n/no-process-exit`
- `@typescript-eslint/no-unnecessary-condition`
- `require-atomic-updates`
- `no-promise-executor-return`

### Suggested validation

- route/integration tests
- daemon/client targeted tests
- `npm run typecheck`

## T6D — Shared runtime error cleanup

**Status: ✅ DONE** — merged PR #25  

**Target files**

- `lib/hydra-shared/agent-executor.ts`
- `lib/hydra-agents.ts`
- `lib/hydra-model-recovery.ts`
- `lib/hydra-mcp-server.ts`
- `lib/hydra-mcp.ts`

### Priority rules

- explicit boundary types
- string conversion safety
- condition simplification
- assertion cleanup

### Suggested validation

- targeted shared-runtime tests
- `npm run typecheck`

## T6E — Council and deliberation error cleanup

**Status: ✅ DONE** — merged PR #31  

**Target files**

- `lib/hydra-council.ts` (192E/241W)
- `lib/hydra-concierge.ts`
- `lib/hydra-context.ts`
- `lib/hydra-streaming-middleware.ts`

### Priority rules

- `@typescript-eslint/prefer-nullish-coalescing`
- `@typescript-eslint/restrict-template-expressions`
- `@typescript-eslint/no-unnecessary-condition`
- `@typescript-eslint/explicit-module-boundary-types`

### Suggested validation

- targeted council/concierge tests
- `npm run typecheck`

## T6F — Supplemental error cleanup

**Status: ✅ DONE** — merged PR #26  

**Target files** (owner claims files from this list to avoid double-work; list is representative)

- `lib/hydra-usage.ts` (110E/406W)
- `lib/hydra-tasks.ts` (71E/75W)
- `lib/hydra-worker.ts` (54E/55W)
- `lib/hydra-evolve-suggestions.ts` (57E/46W)
- `lib/hydra-evolve-investigator.ts`
- `lib/hydra-nightly-review.ts`
- `lib/hydra-actualize-review.ts`
- `lib/hydra-models-select.ts`
- `lib/hydra-github.ts`
- `lib/hydra-codebase-context.ts`
- `lib/hydra-metrics.ts`
- `lib/hydra-tasks-review.ts`
- `lib/hydra-evolve-suggestions-cli.ts`
- `lib/hydra-nightly-discovery.ts`
- `lib/hydra-actualize-review.ts`
- `lib/hydra-provider-usage.ts`
- `lib/hydra-setup.ts`
- `lib/hydra-proc.ts`
- `lib/hydra-models.ts`
- `lib/hydra-dispatch.ts`
- `lib/hydra-intent-gate.ts`
- `lib/hydra-hub.ts`
- `lib/hydra-telemetry.ts`
- `lib/hydra-evolve-knowledge.ts`
- `lib/hydra-evolve-guardrails.ts`
- `lib/hydra-output-history.ts`
- `lib/hydra-agents-wizard.ts`
- `bin/hydra-cli.ts`
- `scripts/build-exe.ts`
- `scripts/gen-research-todo.ts`
- all remaining files with errors not owned by T6A–T6E

### Priority rules

- same rule families as T6A–T6E
- `n/no-process-exit` — each call site must be categorized; bulk replace is not acceptable

### Suggested validation

- targeted tests for every file touched
- `npm run typecheck`
- full `npm run lint` before merge

## T7A — Operator/UI warning reduction

**Status: ✅ DONE** — merged PR #35  

After T6A is green, same owner continues into warnings for:

- `lib/hydra-operator.ts`
- `lib/hydra-ui.ts`
- `lib/hydra-statusbar.ts`
- `lib/hydra-prompt-choice.ts`

### Constraints

- `strict-boolean-expressions` changes require behavior-aware review.
- `no-await-in-loop` fixes require proof that concurrency is safe; otherwise document why serial execution remains intentional.

## T7B — Pipeline warning reduction

**Status: ✅ DONE** — merged PR #30  

After T6B is green, same owner continues into warnings for:

- `lib/hydra-evolve.ts`
- `lib/hydra-nightly.ts`
- `lib/hydra-actualize.ts`
- related review/status modules

### Constraints

Same as T7A.

## T7C — Daemon/route warning reduction

**Status: ✅ DONE** — merged PR #34  

After T6C is green, same owner continues into warnings for:

- `lib/orchestrator-daemon.ts`
- `lib/daemon/write-routes.ts`
- `lib/orchestrator-client.ts`

### Constraints

Same as T7A.

## T7D — Shared runtime warning reduction

**Status: ✅ DONE** — merged PR #28  

After T6D is green, same owner continues into warnings for:

- `lib/hydra-shared/agent-executor.ts`
- `lib/hydra-agents.ts`
- `lib/hydra-model-recovery.ts`
- `lib/hydra-mcp-server.ts`
- `lib/hydra-mcp.ts`

### Constraints

Same as T7A.

## T7E — Council warning reduction

**Status: ✅ DONE** — merged PR #32  

After T6E is green, same owner continues into warnings for:

- `lib/hydra-council.ts`
- `lib/hydra-concierge.ts`
- `lib/hydra-context.ts`
- `lib/hydra-streaming-middleware.ts`

### Constraints

Same as T7A.

## T7F — Supplemental warning reduction

**Status: ✅ DONE** — merged PR #29  

After T6F is green, same owner continues into warnings for the supplemental file set.

### Constraints

Same as T7A.

**Warning families for all T7 lanes:**

- `@typescript-eslint/no-unsafe-member-access`
- `@typescript-eslint/no-unsafe-assignment`
- `@typescript-eslint/no-unsafe-argument`
- `@typescript-eslint/no-unsafe-call`
- `@typescript-eslint/no-unsafe-return`
- `no-await-in-loop`
- `@typescript-eslint/strict-boolean-expressions`

## T8 — CI tightening

**Status: ✅ DONE** — merged PR #36  

**Objective:** Make the new clean baseline enforceable.

### Deliverables

- revisit `continue-on-error` in quality workflows
- remove temporary comments or transitional notes
- confirm the repo-level validation story matches the actual baseline

### Suggested validation

- full validation commands
- inspect workflow diffs and PR checks

## Parallel execution recommendation

### Sequential gate

`T0` must land first. All downstream work depends on a trustworthy test suite.

### First parallel fan-out

After `T0`, three workstreams can start simultaneously:

- `T2` (Node 24 runtime)
- `T5` (test hardening — does not need Node 24; only needs T0)

### Second fan-out after T2

After `T2` lands, `T3` (CI alignment) and `T4` (docs alignment) can proceed in parallel with each other and with ongoing `T5` work.

### Main parallel fan-out

After both `T2` and `T5` are complete, all six error lanes run in parallel:

- `T6A`, `T6B`, `T6C`, `T6D`, `T6E`, `T6F`

### Warning reduction (per-lane)

After each T6 lane completes, the corresponding T7 lane starts immediately without waiting for the other T6 lanes.

### Final join

`T8` starts only after all warning lanes (T7A–T7F) are resolved or any deferrals are documented with rationale.
