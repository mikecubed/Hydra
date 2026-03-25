# Hydra Quality Evaluation

> Generated 2026-03-25 — excludes `apps/` workspace packages

---

## Executive Summary

| Dimension            | Status           | Detail                                                              |
| -------------------- | ---------------- | ------------------------------------------------------------------- |
| **ESLint**           | **PASS**         | 0 errors, 0 warnings across `lib/`, `bin/`, `scripts/`, `test/`     |
| **Prettier**         | **PASS**         | All files formatted                                                 |
| **TypeScript**       | **PASS**         | `tsc --noEmit` clean — zero errors                                  |
| **Circular imports** | **PASS**         | No cycles detected in `lib/`                                        |
| **Tests**            | **PASS**         | 4,149 pass / 0 fail / 9 cancelled / 19 todo (883 suites)            |
| **Coverage**         | **BELOW TARGET** | 63% statements (target: 80%)                                        |
| **TS migration**     | **89% complete** | 46 `.mjs` files remain (11,518 LOC) vs 205 `.ts` files (92,081 LOC) |

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

- `test:coverage` runs in a **`continue-on-error: true`** job — **non-blocking**
- `test:coverage:check` (80% threshold) also runs — **non-blocking** (`continue-on-error`)
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
| Tests              | `test`     | **Yes**   | Passing (9 cancelled, 19 todo) |
| Coverage (80%)     | `coverage` | No        | **Failing** (63%)              |
| Mutation testing   | `mutation` | No        | Unknown                        |

### Non-passing tests

**9 cancelled — `packaging` suite**

The entire packaging suite fails because the `prepack` build pipeline doesn't produce expected `.js` artifacts. All 9 tests are cancelled by the parent suite:

1. tarball contains .js bin entrypoints alongside .ts source
2. .js bin files contain no .ts import specifiers
3. hydra --help exits 0
4. hydra-client help exits 0
5. hydra-daemon help exits 0
6. package.json bin entries point to .js files
7. packed package.json scripts reference .js for lib/bin entrypoints
8. installed package "start" script runs daemon help via .js
9. source repo package.json is restored after pack (not mutated)

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

1. **Convert small `.mjs` test files to `.ts`**
   - Start with files under 100 lines: `hydra-self.test.mjs` (46), `hydra-provider-presets.test.mjs` (54), `hydra-intent-gate.test.mjs` (58), `hydra-telemetry.test.mjs` (70), `hydra-prompt-choice.test.mjs` (70), `hydra-dispatch.test.mjs` (73)
   - Convert `scripts/detect-cycles.mjs` (34 lines)
   - **12 files, ~700 LOC** — mostly rename + add types to imports

2. **Add tests for high-impact, easily testable files**
   - `hydra-models.ts` (24% → target 70%): pure config/resolution logic
   - `hydra-cleanup.ts` (34% → target 70%): file system ops, easy to mock
   - `hydra-output-history.ts` (48% → target 70%): data structure logic
   - `hydra-provider-usage.ts` (45% → target 70%): tracking/accumulation logic

3. **Fix packaging test suite (9 cancelled tests)**
   - Investigate why the `prepack` build pipeline fails to produce `.js` bin entrypoints
   - Fix the build script (`scripts/build-pack.ts`) or update tests to match current packaging strategy
   - Goal: 0 cancelled tests — all 9 packaging tests passing

4. **Set an interim CI coverage gate at 65%**
   - Update `.c8rc.json` thresholds to 65% for all metrics
   - Change `coverage` CI job to **blocking** (`continue-on-error: false`)

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

| Metric               | Current           | Target | Gap                      |
| -------------------- | ----------------- | ------ | ------------------------ |
| ESLint errors        | 0                 | 0      | —                        |
| Type errors          | 0                 | 0      | —                        |
| Format violations    | 0                 | 0      | —                        |
| Circular imports     | 0                 | 0      | —                        |
| Test pass rate       | 99.6% (4149/4177) | 100%   | **9 cancelled, 19 todo** |
| Statement coverage   | 63%               | 80%    | **-17pp**                |
| Branch coverage      | 73%               | 80%    | **-7pp**                 |
| Function coverage    | 61%               | 80%    | **-19pp**                |
| `.mjs` remaining     | 46 files          | 0      | **46 files**             |
| `.mjs` LOC remaining | 11,518            | 0      | **11,518 lines**         |
