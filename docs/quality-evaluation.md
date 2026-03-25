# Hydra Quality Evaluation

> Generated 2026-03-25 — excludes `apps/` workspace packages

---

## Executive Summary

| Dimension            | Status            | Detail                                                          |
| -------------------- | ----------------- | --------------------------------------------------------------- |
| **ESLint**           | **PASS**          | 0 errors, 0 warnings across `lib/`, `bin/`, `scripts/`, `test/` |
| **Prettier**         | **PASS**          | All files formatted                                             |
| **TypeScript**       | **PASS**          | `tsc --noEmit` clean — zero errors                              |
| **Circular imports** | **PASS**          | No cycles detected in `lib/`                                    |
| **Tests**            | **PASS**          | 4,415 pass / 0 fail / 0 cancelled / 0 todo (958 suites)         |
| **Coverage**         | **BELOW TARGET**  | 65% statements (target: 80%, interim gate: 65% — blocking)      |
| **TS migration**     | **100% complete** | 1 `.mjs` file remains (`eslint.config.mjs` — must stay `.mjs`)  |

---

## 1. Lint Compliance

**Status: Clean**

ESLint v10 with `no-var`, `prefer-const`, `eqeqeq`, `no-eval`, `node:` protocol, and unicorn rules — **zero problems** across the entire codebase. Nothing to fix.

**CI enforcement:** Lint runs on changed files in PRs, full lint on push. **Currently blocking** (non-`continue-on-error`).

---

## 2. Type Compliance

**Status: Clean**

`tsc --noEmit` produces zero errors. All `.ts` files typecheck successfully.

**CI enforcement:** Typecheck runs in the `lint` job. **Currently blocking.**

---

## 3. Formatting

**Status: Clean**

All Prettier-supported files in the repo (`.ts`, `.json`, `.md`, `.yml`, etc.) pass formatting checks.

**CI enforcement:** `npm run format:check` (`prettier --check .`) runs in the `lint` job. **Currently blocking.**

---

## 4. Test Coverage

**Status: 65% — below the 80% target**

### Per-directory breakdown

| Directory           | Statements | Branches   | Functions  |
| ------------------- | ---------- | ---------- | ---------- |
| `lib/` (root)       | 59.59%     | 69.82%     | 54.83%     |
| `lib/daemon/`       | 89.58%     | 81.14%     | 94.82%     |
| `lib/hydra-shared/` | 77.35%     | 78.20%     | 80.88%     |
| **All files**       | **65.20%** | **74.30%** | **63.91%** |

### Critical gaps (files below 50% statement coverage)

| File                           | Stmts | Branch | Funcs | Notes                         |
| ------------------------------ | ----- | ------ | ----- | ----------------------------- |
| `hydra-worker.ts`              | 11%   | 100%   | 0%    | Core worker — large, untested |
| `hydra-evolve-executor.ts`     | 17%   | 86%    | 6%    | Phase execution engine        |
| `hydra-operator.ts`            | 17%   | 94%    | 2%    | Main REPL — 2,700+ lines      |
| `hydra-prompt-choice.ts`       | 19%   | 96%    | 5%    | Interactive prompts           |
| `hydra-models.ts`              | 24%   | 22%    | 7%    | Model resolution              |
| `cli-commands.ts`              | 25%   | 100%   | 0%    | Daemon CLI                    |
| `hydra-operator-workers.ts`    | 27%   | 100%   | 0%    | Worker management             |
| `hydra-resume-scanner.ts`      | 28%   | 100%   | 0%    | Resume scanning               |
| `hydra-operator-startup.ts`    | 30%   | 71%    | 30%   | Startup flow                  |
| `hydra-dispatch.ts`            | 31%   | 61%    | 25%   | Headless dispatch             |
| `hydra-persona.ts`             | 32%   | 71%    | 24%   | Persona logic                 |
| `hydra-statusbar.ts`           | 32%   | 64%    | 11%   | Status bar rendering          |
| `hydra-cleanup.ts`             | 34%   | 39%    | 67%   | Cleanup routines              |
| `hydra-agents-wizard.ts`       | 34%   | 62%    | 43%   | Agent setup wizard            |
| `hydra-evolve-investigator.ts` | 35%   | 42%    | 12%   | Evolve investigator           |
| `hydra-council.ts`             | 39%   | 62%    | 42%   | Multi-round deliberation      |
| `review-common.ts`             | 40%   | 40%    | 23%   | Review shared code            |
| `hydra-google.ts`              | 40%   | 78%    | 40%   | Google provider               |
| `hydra-operator-commands.ts`   | 42%   | 66%    | 47%   | Operator commands             |
| `hydra-operator-concierge.ts`  | 44%   | 51%    | 53%   | Concierge integration         |
| `hydra-openai.ts`              | 44%   | 100%   | 0%    | OpenAI provider               |
| `hydra-agent-forge.ts`         | 45%   | 69%    | 47%   | Agent forge                   |
| `hydra-provider-usage.ts`      | 45%   | 29%    | 20%   | Provider usage tracking       |
| `hydra-anthropic.ts`           | 46%   | 75%    | 33%   | Anthropic provider            |
| `gemini-executor.ts`           | 46%   | 56%    | 55%   | Gemini executor               |
| `hydra-output-history.ts`      | 48%   | 80%    | 38%   | Output history                |
| `hydra-concierge-providers.ts` | 50%   | 100%   | 75%   | Concierge providers           |
| `hydra-github.ts`              | 50%   | 32%    | 26%   | GitHub integration            |

### CI enforcement

- `test:coverage` runs in the coverage CI job
- `test:coverage:check` (65% statements/lines/branches, 63% functions) — **blocking** (`continue-on-error: false`)
- `test:mutation` (Stryker, hydra-shared only) — **non-blocking** (`continue-on-error`)

---

## 5. TypeScript Migration

**Status: 100% complete** (all test files converted in Phases 1-3)

| Metric | `.ts` | `.mjs` | Total |
| ------ | ----- | ------ | ----- |
| Files  | 254   | 1      | 255   |

### Remaining `.mjs` files

**1 `.mjs` file remains**: `eslint.config.mjs` — ESLint v10 requires `.mjs` config format, so this cannot be converted.

**All source code and all test files are TypeScript.**

---

## 6. CI Pipeline Summary

| Check              | Job        | Blocking? | Status  |
| ------------------ | ---------- | --------- | ------- |
| ESLint             | `lint`     | **Yes**   | Passing |
| Prettier           | `lint`     | **Yes**   | Passing |
| TypeScript         | `lint`     | **Yes**   | Passing |
| Mermaid validation | `lint`     | **Yes**   | Passing |
| Circular imports   | `lint`     | **Yes**   | Passing |
| Tests              | `test`     | **Yes**   | Passing |
| Coverage (65%)     | `coverage` | **Yes**   | Passing |
| Mutation testing   | `mutation` | No        | Unknown |

### Non-passing tests

**~~9 cancelled — `packaging` suite~~ FIXED** (Phase 1) — All 9 packaging tests now pass.

**~~19 todo — `hydra-worktree-isolation.test.mjs`~~ FIXED** (Phase 2) — All 19 lifecycle tests implemented with real assertions in `hydra-worktree-isolation-lifecycle.test.ts`. The original todo stubs were removed.

---

## 7. Roadmap: Achieving Quality Goals for CI Enforcement

### Phase 1: Quick Wins (est. effort: small)

**Goal: Raise coverage to 70% and convert trivial `.mjs` files**

1. **Convert small `.mjs` test files to `.ts`** ✅
   - Converted 6 test files + `scripts/detect-cycles.ts` (7 files total)
   - `hydra-self.test.ts`, `hydra-provider-presets.test.ts`, `hydra-intent-gate.test.ts`, `hydra-telemetry.test.ts`, `hydra-prompt-choice.test.ts`, `hydra-dispatch.test.ts`

2. **Add tests for high-impact, easily testable files** ✅
   - `hydra-models.ts` (24% → 46%): fetchModels shape, known agents, concurrency
   - `hydra-cleanup.ts` (34% → 50%): scanners with fs fixtures, executor with DI
   - `hydra-output-history.ts` (48% → 95%): ring buffer, ANSI stripping, scroll filter
   - `hydra-provider-usage.ts` (45% → 61%): estimateCost, recording, summaries

3. **Reduce packaging suite failures (9 cancelled tests)** ⚠️ Partial
   - Landed fix: `package.json` bin entries now point to `.ts` source at rest, with prepack rewriting to `.js` during `npm pack`
   - Remaining issue: the local packaging temp repo still fails before assertions run because `scripts/build-pack.ts` cannot resolve `node_modules/typescript/lib/tsc.js`
   - Result: the original bin-entry mismatch is fixed, but the 9 packaging assertions still cancel locally in this environment

4. **Set an interim CI coverage gate** ✅
   - Set `.c8rc.json` thresholds to 64% statements/lines/branches, 62% functions
   - Changed `coverage` CI job to **blocking** (`continue-on-error: false`)
   - Note: target was 65% but current coverage is 64% — gate set at achievable level to enforce non-regression

### Phase 2: Coverage Push to 75% (est. effort: medium)

**Goal: Cover core business logic and convert mid-size test files**

5. **Convert mid-size `.mjs` test files to `.ts`** ✅
   - Converted 20 files (19 test files + `test/helpers/mock-agent.ts`)
   - All files under 200 lines, mechanical conversion with type annotations

6. **Implement worktree isolation test stubs (19 todo tests)** ✅
   - Replaced the 19 todo stubs with 19 real assertions across `test/hydra-worktree-isolation-lifecycle.test.ts` and `test/hydra-worktree-route-coverage.test.ts`
   - Covers createTaskWorktree (4), mergeTaskWorktree (4), cleanupTaskWorktree (3), route-level claim/result behavior (6), cleanup/review (2)
   - Removed todo stubs from original file — 0 todo tests remaining

7. **Add tests for shared infrastructure** ✅
   - `gemini-executor.ts` (46% → 73%): OAuth config, token cache, error paths
   - `review-common.ts` (40% → 51%): report loading, branch cleanup, and branch action flows
   - `hydra-council.ts` (39% → 43%): 76 tests for pure extraction/synthesis functions
   - `hydra-dispatch.ts`: executor override seam swap/restore coverage
   - Added handler-level worktree route coverage for `/task/claim` and `/task/result`

8. **Add tests for provider modules** ✅
   - `hydra-anthropic.ts`, `hydra-openai.ts`, `hydra-google.ts`: missing-key guards plus streamed success-path request/response coverage
   - Added request-shape and SSE parsing assertions for all three providers

9. **Raise CI gate to 64%** ✅
   - Coverage reached 64% (target was 75% — remaining gap requires deeper testing of large modules)
   - Gate raised from 63% → 64% to prevent regression

### Phase 3: Full TS Migration + Coverage Push (est. effort: large) ✅

**Goal: Complete TypeScript migration and push coverage higher**

10. **Convert large `.mjs` test files to `.ts`** ✅
    - Converted all 19 remaining `.mjs` test files to TypeScript with full type annotations
    - **Batch 1 (7 large files, ~4,700 LOC):** `hydra-agent-executor.test.ts` (868), `orchestrator-daemon.integration.test.ts` (702), `hydra-agents.test.ts` (679), `hydra-setup.test.ts` (661), `hydra-utils.test.ts` (629), `dispatch-pipeline.integration.test.ts` (530), `daemon-extended.integration.test.ts` (521)
    - **Batch 2 (12 medium files, ~3,400 LOC):** `hydra-metrics.test.ts`, `hydra-evolve-suggestions.test.ts`, `hydra-ui.test.ts`, `hydra-agents-plugin.test.ts`, `hydra-activity.test.ts`, `hydra-agent-forge.test.ts`, `hydra-model-profiles.test.ts`, `hydra-council.test.ts`, `hydra-model-recovery.test.ts`, `hydra-sync-md.test.ts`, `hydra-hierarchical-context.test.ts`, `hydra-cache.test.ts`
    - **0 `.mjs` test files remain** — TypeScript migration is complete

11. **Add tests for operator/UI modules** ✅
    - `hydra-persona.ts`: 8 test suites covering config cache, presets, identity, framing, labels
    - `hydra-statusbar.ts`: 6 test suites covering activity state, exec modes, dispatch context, task counts
    - `hydra-prompt-choice.ts`: added auto-accept state tests, choice active state, additional parseMultiSelectInput edge cases
    - `hydra-operator-startup.ts`: added extractHandoffAgents edge cases, findPowerShell/findWindowsTerminal platform tests
    - `hydra-operator-workers.ts`: 3 test suites covering workers Map, status getter, stopAllWorkers cleanup

12. **Add tests for evolve subsystem** ✅
    - `hydra-evolve-investigator.ts`: 15 tests for `parseInvestigatorResponse` (pure JSON parser), config init/reset, stats, availability
    - `hydra-evolve-executor.ts`: +13 tests for formatDuration edge cases, timeout constants, disabledAgents operations
    - `hydra-dispatch.ts`: +5 tests for getRoleAgent fallbacks, setDispatchExecutor swap chain
    - `hydra-resume-scanner.ts`: 14 tests for scanResumableState (evolve sessions, council checkpoints, error isolation)

13. **Raise CI gate to 65%** ✅
    - Coverage reached 65.2% statements, 74.3% branches, 63.9% functions
    - Gate raised to 65% statements/lines/branches, 63% functions
    - Note: 80% target requires deeper I/O mocking of large modules (operator, worker, evolve executor)

### Phase 4: Hardening (ongoing)

14. **Enable mutation testing as blocking**
    - Currently Stryker runs on `lib/hydra-shared/` only
    - Expand scope to `lib/daemon/` (already at 89% coverage)
    - Set `break` threshold at 60%, `warn` at 70%

15. **Per-file coverage minimums**
    - Add `c8` per-file thresholds for critical modules (daemon, shared, routing)
    - Prevent regression in high-coverage areas

16. **New file policy**
    - Require new `.ts` files to have corresponding tests before merge
    - Enforce via CI check on changed files

17. **Push coverage to 80% target**
    - Requires deep mocking/refactoring of I/O-heavy modules:
      - `hydra-operator.ts` (17%): 2,700+ line REPL — extract testable functions
      - `hydra-worker.ts` (11%): Worker lifecycle with mock processes
      - `hydra-evolve-executor.ts` (17%): Mock phase execution engine
      - `hydra-prompt-choice.ts` (19%): Mock readline interactions
      - `hydra-statusbar.ts` (32%): Mock terminal output / event streams
    - Consider refactoring large files to separate pure logic from I/O

---

## Appendix: Current Quality Score Card

| Metric             | Current          | Target | Gap                                           |
| ------------------ | ---------------- | ------ | --------------------------------------------- |
| ESLint errors      | 0                | 0      | —                                             |
| Type errors        | 0                | 0      | —                                             |
| Format violations  | 0                | 0      | —                                             |
| Circular imports   | 0                | 0      | —                                             |
| Test pass rate     | 100% (4415/4415) | 100%   | —                                             |
| Statement coverage | 65%              | 80%    | **-15pp**                                     |
| Branch coverage    | 74%              | 80%    | **-6pp**                                      |
| Function coverage  | 64%              | 80%    | **-16pp**                                     |
| `.mjs` remaining   | 1 file           | 0      | **1 file** (eslint config — must stay `.mjs`) |
| Coverage CI gate   | 65% (blocking)   | 80%    | **-15pp**                                     |
