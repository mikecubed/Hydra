# Node 24 Upgrade Plan

**Status:** Proposed  
**Date:** 2026-03-11  
**Scope:** Bump minimum Node.js requirement from `>=20.19.0` to `>=24.0.0`, update CI matrix, bump TypeScript target, and optionally replace `tsx` with Node's native TypeScript stripping.

---

## Background

The project currently requires Node `>=20.19.0` and tests against Node 20.19 and 22 in CI.  
Node 20 entered **maintenance mode in October 2025** and reaches **end-of-life in April 2026**.  
Node 24 became LTS in October 2025 with a support window through **April 2029**.

Moving to Node 24 as the minimum closes the EOL gap, enables native TypeScript execution, and unlocks ES2024 language features without any breaking changes to the codebase.

---

## What We Gain

### 1. Drop `tsx` — Native TypeScript Stripping

Node 22.6 introduced `--experimental-strip-types`; **Node 24 stabilizes it as `--strip-types`** (no experimental flag required). Since type-checking already runs separately via `tsc --noEmit`, the project can use Node's native stripping instead of `tsx` as the runtime TypeScript executor.

This affects every script that currently relies on `tsx` under the hood:

- `node --test 'test/**/*.test.{ts,mjs}'`
- `node scripts/setup-hooks.ts`
- `node scripts/gen-research-todo.ts`
- `node scripts/build-exe.ts`

All of these would simply gain a `--strip-types` flag; no source changes required.

> **Limitation:** `--strip-types` does not support decorators or `const enum`. Neither is used in this codebase, so there is no impact.

### 2. ES2024 Language Target

Bumping `tsconfig.json` from `"target": "ES2022"` to `"ES2024"` makes the following built-ins available without polyfills:

| Feature                              | Use case                                                 |
| ------------------------------------ | -------------------------------------------------------- |
| `Promise.withResolvers()`            | Cleaner deferred promise patterns in async orchestration |
| `Object.groupBy()` / `Map.groupBy()` | Task/agent grouping without reduce boilerplate           |
| `Array.fromAsync()`                  | Async iterable collection                                |
| `RegExp /v` flag (set notation)      | More expressive regex in routing/intent matching         |

### 3. Stable `require(esm)`

Node 24 fully stabilizes synchronous `require()` of ES modules. Useful when third-party dependencies still ship CJS — no more interop edge cases.

### 4. Native `node:fs glob()` (stable)

`import { glob } from 'node:fs/promises'` is stable in Node 22+ and well-established in 24. Can replace shell glob patterns in utility scripts where appropriate.

### 5. `node:test` Improvements

The built-in test runner gains stable `mock.timers`, `snapshot` testing, and improved `--test-reporter` API. No migration required — the project already uses `node:test`.

### 6. V8 13.3 Performance

Faster startup and JIT improvements benefit the orchestrator, which spawns multiple agent subprocesses in parallel.

### 7. LTS Longevity

| Version | End of Life   |
| ------- | ------------- |
| Node 20 | April 2026 ⚠️ |
| Node 22 | October 2027  |
| Node 24 | April 2029 ✅ |

---

## Required Changes

### `package.json`

```diff
- "node": ">=20.19.0"
+ "node": ">=24.0.0"
```

```diff
- "@types/node": "^20.19.0"
+ "@types/node": "^24.0.0"
```

### `tsconfig.json`

```diff
- "target": "ES2022",
- "lib": ["ES2022"],
+ "target": "ES2024",
+ "lib": ["ES2024"],
```

### `.github/workflows/ci.yml`

```diff
- node-version: ['20.19', 22]
+ node-version: [22, 24]
```

> Keep Node 22 in the matrix during a transition window to catch any regressions before fully committing to 24-only. Drop it once stable.

### `.github/workflows/quality.yml`

```diff
- node-version: 22
+ node-version: 24
```

### `.github/workflows/build-windows-exe.yml`

```diff
- node-version: 20
+ node-version: 24
```

---

## Optional: Drop `tsx`

If the team wants to remove the `tsx` devDependency and use Node 24's native stripping:

### `package.json` scripts

```diff
- "test": "node --test 'test/**/*.test.{ts,mjs}'",
+ "test": "node --strip-types --test 'test/**/*.test.{ts,mjs}'",
```

```diff
- "setup:hooks": "node scripts/setup-hooks.ts",
+ "setup:hooks": "node --strip-types scripts/setup-hooks.ts",
```

```diff
- "build:exe": "node scripts/build-exe.ts",
- "build:exe:ci": "node scripts/build-exe.ts --ci",
+ "build:exe": "node --strip-types scripts/build-exe.ts",
+ "build:exe:ci": "node --strip-types scripts/build-exe.ts --ci",
```

```diff
- "research:todo": "node scripts/gen-research-todo.ts",
+ "research:todo": "node --strip-types scripts/gen-research-todo.ts",
```

Remove from `devDependencies`:

```diff
- "tsx": "^4.21.0",
```

> **Note:** Audit all scripts that invoke `.ts` files before removing `tsx`. Run `grep -r '\.ts' package.json scripts/` to catch any missed invocations.

---

## No Breaking Changes Expected

| Area                        | Status                         |
| --------------------------- | ------------------------------ |
| ESM-only codebase           | ✅ No changes needed           |
| `node:` protocol imports    | ✅ Already in use throughout   |
| No `--experimental-*` flags | ✅ Nothing to remove           |
| No polyfills or shims       | ✅ Nothing to remove           |
| No deprecated Node APIs     | ✅ Clean audit                 |
| Dependencies                | ✅ All compatible with Node 24 |

---

## Implementation Order

1. Update `package.json` — `engines.node` and `@types/node`
2. Update `tsconfig.json` — `target` and `lib`
3. Update all three CI workflow files
4. Run `npm install` to pull updated `@types/node`
5. Run `npm run quality` — lint + format:check + typecheck must pass
6. Run `npm test` — full test suite must pass
7. **(Optional)** Replace `tsx` with `--strip-types` across all `.ts` script invocations, remove `tsx` from devDeps, run quality + test again
8. Open PR targeting `main`

---

## References

- [Node.js Release Schedule](https://nodejs.org/en/about/previous-releases)
- [Node.js 24 Changelog](https://github.com/nodejs/node/blob/main/CHANGELOG.md)
- [Node.js TypeScript stripping docs](https://nodejs.org/en/learn/typescript/run-natively)
- [V8 13.3 release notes](https://v8.dev/blog/v8-release-133)
