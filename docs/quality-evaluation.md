# Hydra Quality Evaluation

> Generated 2026-03-25 — excludes `apps/` workspace packages

---

## Executive Summary

| Dimension            | Status           | Detail                                                          |
| -------------------- | ---------------- | --------------------------------------------------------------- |
| **ESLint**           | **PASS**         | 0 errors, 0 warnings across `lib/`, `bin/`, `scripts/`, `test/` |
| **Prettier**         | **PASS**         | All files formatted                                             |
| **TypeScript**       | **PASS**         | `tsc --noEmit` clean — zero errors                              |
| **Circular imports** | **PASS**         | No cycles detected in `lib/`                                    |
| **Tests**            | **PASS**         | 4,231 pass / 0 fail / 0 cancelled / 19 todo (909 suites)        |
| **Coverage**         | **BELOW TARGET** | 64% statements (target: 80%, interim gate: 63% — blocking)      |
| **TS migration**     | **91% complete** | 40 `.mjs` files remain vs 212 `.ts` files                       |

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

All `.ts` and `.mjs` files pass Prettier checks.

**CI enforcement:** Format check runs in the `lint` job. **Currently blocking.**

---

## 4. Test Coverage

**Status: 63% — below the 80% target**

### Per-directory breakdown

| Directory           | Statements | Branches   | Functions  |
| ------------------- | ---------- | ---------- | ---------- |
| `lib/` (root)       | 59.59%     | 69.82%     | 54.83%     |
| `lib/daemon/`       | 88.73%     | 80.72%     | 93.96%     |
| `lib/hydra-shared/` | 72.72%     | 81.23%     | 77.44%     |
| **All files**       | **63.26%** | **72.76%** | **60.93%** |

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
| `review-common.ts`             | 40%   | 40%    | 23%   | Review shared code            |
| `hydra-council.ts`             | 39%   | 62%    | 42%   | Multi-round deliberation      |
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
- `test:coverage:check` (63% threshold) — **blocking** (`continue-on-error: false`)
- `test:mutation` (Stryker, hydra-shared only) — **non-blocking** (`continue-on-error`)

---

## 5. TypeScript Migration

**Status: 89% complete by file count, 89% by LOC**

| Metric        | `.ts`  | `.mjs` | Total   |
| ------------- | ------ | ------ | ------- |
| Files         | 205    | 46     | 251     |
| Lines of code | 92,081 | 11,518 | 103,599 |
| Percentage    | 88.9%  | 11.1%  | —       |

### Remaining `.mjs` files

**All 46 `.mjs` files are tests or test helpers** (45 test files + 1 script):

| Category                 | Count | Largest files                                                                                                          |
| ------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| Test files (`.test.mjs`) | 44    | `hydra-agent-executor.test.mjs` (868), `orchestrator-daemon.integration.test.mjs` (702), `hydra-agents.test.mjs` (679) |
| Test helpers             | 1     | `test/helpers/mock-agent.mjs` (171)                                                                                    |
| Scripts                  | 1     | `scripts/detect-cycles.mjs` (34)                                                                                       |

**All production source code (`lib/`, `bin/`) is already TypeScript.** The migration only affects test files and one utility script.

---

## 6. CI Pipeline Summary

| Check              | Job        | Blocking? | Status                         |
| ------------------ | ---------- | --------- | ------------------------------ |
| ESLint             | `lint`     | **Yes**   | Passing                        |
| Prettier           | `lint`     | **Yes**   | Passing                        |
| TypeScript         | `lint`     | **Yes**   | Passing                        |
| Mermaid validation | `lint`     | **Yes**   | Passing                        |
| Circular imports   | `lint`     | **Yes**   | Passing                        |
| Tests              | `test`     | **Yes**   | Passing (0 cancelled, 19 todo) |
| Coverage (63%)     | `coverage` | **Yes**   | Passing (64%)                  |
| Mutation testing   | `mutation` | No        | Unknown                        |

### Non-passing tests

**~~9 cancelled — `packaging` suite~~ FIXED** — All 9 packaging tests now pass after fixing `package.json` bin entries to point to `.ts` source at rest, with prepack rewriting to `.js` during `npm pack`.

**19 todo — `hydra-worktree-isolation.test.mjs`**

All 19 tests are placeholder stubs for the worktree isolation feature (`routing.worktreeIsolation`). They pass trivially but need real implementations:

| Group                 | Tests | What they cover                                                 |
| --------------------- | ----- | --------------------------------------------------------------- |
| `createTaskWorktree`  | 1-4   | Creates worktree dir, branch, returns path, handles git failure |
| `mergeTaskWorktree`   | 5-8   | smartMerge calls, clean merge, conflict handling, exceptions    |
| `cleanupTaskWorktree` | 9-11  | Remove worktree, force mode, best-effort on failure             |
| Daemon integration    | 12-14 | Worktree creation on `/task/claim` (disabled, tandem, council)  |
| Task completion       | 15-17 | Merge on `/task/result`, cleanup on success, conflict flagging  |
| Cleanup/review        | 18-19 | `:cleanup` stale scanner, `:tasks review` conflict display      |

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

3. **Fix packaging test suite (9 cancelled tests)** ✅
   - Root cause: `package.json` bin entries pointed to `.js` files that don't exist at rest
   - Fix: bin entries now point to `.ts` source; prepack rewrites to `.js` during `npm pack`
   - Result: all 9 packaging tests passing

4. **Set an interim CI coverage gate** ✅
   - Set `.c8rc.json` thresholds to 63% statements/lines/branches, 60% functions
   - Changed `coverage` CI job to **blocking** (`continue-on-error: false`)
   - Note: target was 65% but current coverage is 64% — gate set at achievable level to enforce non-regression

### Phase 2: Coverage Push to 75% (est. effort: medium)

**Goal: Cover core business logic and convert mid-size test files**

5. **Convert mid-size `.mjs` test files to `.ts`**
   - 100-200 line files: `hydra-action-pipeline.test.mjs`, `hydra-mcp.test.mjs`, `hydra-proc.test.mjs`, `hydra-streaming-middleware.test.mjs`, `hydra-concierge-providers.test.mjs`, `hydra-agents-local-routing.test.mjs`, `hydra-commit-attribution.test.mjs`, etc.
   - **~15 files, ~2,200 LOC**

6. **Implement worktree isolation test stubs (19 todo tests)**
   - Replace the 19 placeholder stubs in `hydra-worktree-isolation.test.mjs` with real assertions
   - `createTaskWorktree` (4 tests): mock `git worktree add` / `git branch`, verify path and error handling
   - `mergeTaskWorktree` (4 tests): mock `smartMerge`, verify clean/conflict/exception paths
   - `cleanupTaskWorktree` (3 tests): mock `git worktree remove` / `git branch -d`, verify force mode
   - Daemon integration (5 tests): mock daemon `/task/claim` and `/task/result` with worktree config
   - Cleanup/review (3 tests): mock stale worktree scanning and conflict display
   - Goal: 0 todo tests — all 19 passing with real assertions

7. **Add tests for shared infrastructure**
   - `gemini-executor.ts` (46%): executor logic with stub providers
   - `review-common.ts` (40%): review pipeline shared code
   - `hydra-council.ts` (39%): deliberation pipeline (mock agent calls)
   - `hydra-dispatch.ts` (31%): headless dispatch (mock daemon)

8. **Add tests for provider modules**
   - `hydra-anthropic.ts`, `hydra-openai.ts`, `hydra-google.ts`: mock HTTP responses
   - These are straightforward to test with intercepted network calls

9. **Raise CI gate to 75%**
   - Update `.c8rc.json` thresholds

### Phase 3: Coverage Target 80% + Full TS Migration (est. effort: large)

**Goal: Hit the 80% target and complete TypeScript migration**

10. **Convert large `.mjs` test files to `.ts`**
    - Files over 400 lines: `hydra-agent-executor.test.mjs` (868), `orchestrator-daemon.integration.test.mjs` (702), `hydra-agents.test.mjs` (679), `hydra-setup.test.mjs` (661), `hydra-utils.test.mjs` (629), `dispatch-pipeline.integration.test.mjs` (530), `daemon-extended.integration.test.mjs` (521)
    - **7 files, ~4,700 LOC** — these will need careful type additions
    - Convert `test/helpers/mock-agent.mjs` to `.ts`

11. **Add tests for operator/UI modules** (the hardest files)
    - `hydra-operator.ts` (17%): Extract testable functions, test REPL logic
    - `hydra-statusbar.ts` (32%): Mock terminal output
    - `hydra-prompt-choice.ts` (19%): Mock readline
    - `hydra-operator-commands.ts` (42%): Command dispatch logic
    - `hydra-worker.ts` (11%): Worker lifecycle with mock processes
    - Consider refactoring large files to separate pure logic from I/O

12. **Add tests for evolve subsystem**
    - `hydra-evolve-executor.ts` (17%): Mock phase execution
    - `hydra-evolve-investigator.ts` (35%): Mock knowledge queries

13. **Raise CI gate to 80% — make blocking**
    - Update `.c8rc.json` to final 80% thresholds
    - Remove `continue-on-error: true` from coverage job

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

---

## Appendix: Current Quality Score Card

| Metric             | Current           | Target | Gap          |
| ------------------ | ----------------- | ------ | ------------ |
| ESLint errors      | 0                 | 0      | —            |
| Type errors        | 0                 | 0      | —            |
| Format violations  | 0                 | 0      | —            |
| Circular imports   | 0                 | 0      | —            |
| Test pass rate     | 99.6% (4231/4250) | 100%   | **19 todo**  |
| Statement coverage | 64%               | 80%    | **-16pp**    |
| Branch coverage    | 73%               | 80%    | **-7pp**     |
| Function coverage  | 62%               | 80%    | **-18pp**    |
| `.mjs` remaining   | 40 files          | 0      | **40 files** |
| Coverage CI gate   | 63% (blocking)    | 80%    | **-17pp**    |
