# Quality + Node 24 Task List — 2026-03-12

**Parent roadmap:** `docs/plans/2026-03-12-quality-node24-remediation-roadmap.md`  
**Draft PR:** `#17`  
**Goal:** Turn the roadmap into an execution-ready, dependency-ordered task list that can be claimed in parallel once prerequisite phases land.

## Global rules

- Every task must preserve or improve real behavioral coverage.
- Do **not** disable, skip, weaken, or over-mock tests to get green.
- Do **not** leave `todo` tests behind.
- If a check, rule, or test must be relaxed temporarily, the reason must be documented in the relevant task PR and in the touched file when appropriate.
- Every modified code file must pass linting and type-checking before merge.
- Use the narrowest possible test run while developing, then run the phase-level validation before merge.

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
T1  baseline-lock                    depends on T0
T2  node24-runtime                   depends on T1
T3  ci-node24                        depends on T2
T4  docs-node24                      depends on T2
T5  test-hardening                   depends on T0, T1
T6A operator-ui-errors               depends on T2, T5
T6B pipeline-errors                  depends on T2, T5
T6C daemon-route-errors              depends on T2, T5
T6D shared-runtime-errors            depends on T2, T5
T7A operator-ui-warnings             depends on T6A
T7B pipeline-warnings                depends on T6B
T7C daemon-route-warnings            depends on T6C
T7D shared-runtime-warnings          depends on T6D
T8  ci-tightening                    depends on T7A, T7B, T7C, T7D
```

## Task list

## T0 — Test integrity audit

**Objective:** Make the suite trustworthy before it becomes the safety net for refactors.

### Deliverables

- Enumerate the current test `todo`s and implement them or document why they are invalid/outdated coverage candidates.
- Audit tests that use fakes where real code paths are available.
- Produce a removal/rewrite candidate list for stale or low-value tests.

### Suggested validation

- `node --test 'test/**/*.test.{ts,mjs}'`
- rerun every touched test file directly

### Notes

- This task blocks everything else.
- Prefer documenting questionable tests in a dedicated appendix or follow-up doc instead of deleting them in the same pass.

## T1 — Baseline lock

**Objective:** Freeze the live baseline and the working rules for all follow-up branches.

### Deliverables

- Confirm `docs/quality-baseline-2026-03-12.md` remains current.
- Confirm the phase structure and branch sequencing.
- Record any baseline anomalies discovered during T0.

### Suggested validation

- verify docs only
- `./node_modules/.bin/prettier --check docs/**/*.md`

## T2 — Node 24 runtime foundation

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

## T7A-T7D — Warning reduction by subsystem

After each error lane is green, the same subsystem owner should continue into warnings:

- unsafe member access / assignment / argument / call / return
- `no-await-in-loop`
- `strict-boolean-expressions`

### Constraints

- `strict-boolean-expressions` changes require behavior-aware review.
- `no-await-in-loop` fixes require proof that concurrency is safe; otherwise document why serial execution remains intentional.

## T8 — CI tightening

**Objective:** Make the new clean baseline enforceable.

### Deliverables

- revisit `continue-on-error` in quality workflows
- remove temporary comments or transitional notes
- confirm the repo-level validation story matches the actual baseline

### Suggested validation

- full validation commands
- inspect workflow diffs and PR checks

## Parallel execution recommendation

### Sequential gates

Tasks `T0`, `T1`, and `T2` should land in order.

### First parallel fan-out

After `T2`, `T3`, `T4`, and `T5` can proceed in parallel.

### Main parallel fan-out

After `T5`, run `T6A`, `T6B`, `T6C`, and `T6D` in parallel.

### Secondary parallel fan-out

After each T6 lane is complete, the corresponding T7 lane can start without waiting for the others.

### Final join

`T8` starts only after all warning lanes are resolved or explicitly deferred with documented rationale.
