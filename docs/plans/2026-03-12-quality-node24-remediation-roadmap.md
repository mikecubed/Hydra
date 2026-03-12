# Quality + Node 24 Remediation Roadmap

**Status:** Proposed  
**Branch:** `chore/quality-node24-plan`  
**Inputs:** `docs/quality-baseline-2026-03-12.md`, `docs/plans/2026-03-11-node24-upgrade.md`

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
- Implement each one or classify it in documentation as invalid/outdated coverage requiring review.

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

## Phase 1 — Baseline lock and execution guardrails

**Objective:** Start from verified data and prevent stale assumptions from steering the work.

### Deliverables

- Keep `docs/quality-baseline-2026-03-12.md` as the source of truth for current counts.
- Confirm the branch for execution work is based on `chore/quality-node24-plan`.
- Record the canonical validation commands for every follow-up branch:
  - `npm run lint`
  - `npm run format:check`
  - `npm run typecheck`
  - `node --test 'test/**/*.test.{ts,mjs}'`

### Parallelism

- None required; this is the dependency gate for all later phases.

### Exit criteria

- Everyone is using the live baseline numbers.
- Follow-up work items are split by subsystem and phase rather than by stale doc sections.

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

#### 1A — Runtime and dependency lane

- Update Node engine and `@types/node`
- Refresh the lockfile
- Decide whether `tsx` removal is same-phase or a follow-up

#### 1B — CI lane

- Move required workflows to Node 24
- Keep any temporary compatibility checks non-blocking if they remain at all

#### 1C — Documentation lane

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

#### 2A — CLI contract tests

- Add tests that assert exit code, stderr/stdout shape, and non-abrupt termination behavior for CLI entrypoints and error paths

#### 2B — Async behavior tests

- Add tests for sequencing-sensitive loops before converting any to batched or helper-based flows

#### 2C — Config/defaulting tests

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
6. `n/no-process-exit` — 75
7. `@typescript-eslint/no-unnecessary-type-conversion` — 69
8. `@typescript-eslint/no-unnecessary-type-assertion` — 61
9. `@typescript-eslint/restrict-plus-operands` — 18
10. `require-atomic-updates` / `no-promise-executor-return` / `n/hashbang` and smaller tails

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

Reuse the same four subsystem streams from Phase 3 so owners can keep context and tests.

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

1. `phase-1/node24-foundation`
2. `phase-2/baseline-lock`
3. `phase-3/test-guardrails`
4. `phase-4a/operator-ui-errors`
5. `phase-4b/pipeline-errors`
6. `phase-4c/daemon-errors`
7. `phase-4d/shared-runtime-errors`
8. `phase-5/warnings-burn-down`
9. `phase-6/ci-tightening`

Phase 0 must land before the rest. Phase 4A-4D are the main parallel lanes once Phases 1-3 land.

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
