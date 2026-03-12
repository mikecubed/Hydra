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

## Executive summary

| Check      | Result                        | Notes                                                                                 |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| ESLint     | 2,975 errors / 5,777 warnings | All current debt is in lint; most volume is TypeScript-aware ESLint rather than `tsc` |
| Prettier   | Clean                         | `npm run format:check` passes                                                         |
| TypeScript | Clean                         | `npm run typecheck` passes                                                            |
| Tests      | Clean baseline                | Direct `node --test` exits 0 with 887 pass / 19 todo / 0 fail                         |

## Important baseline correction

Older docs in `docs/quality-audit.md` and `docs/quality-fix-plan.md` describe a pre-migration state with thousands of `tsc --checkJs` errors and `.mjs`-centric fixes. That is no longer the current repo shape. The current repository is TypeScript-first, `tsc` is already clean, and the backlog is concentrated in type-aware ESLint rules.

## ESLint totals

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
