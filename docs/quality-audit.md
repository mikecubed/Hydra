# Code Quality Audit Report

> Generated: 2026-03-09 | Branch: `fix/code-quality-gates` | Tools: ESLint v10, Prettier v3, TypeScript v5

---

## Executive Summary

| Tool                         | Files Checked | Issues Found                     | Auto-fixable         | Severity |
| ---------------------------- | ------------- | -------------------------------- | -------------------- | -------- |
| ESLint                       | 123 files     | 1,160 (968 errors, 192 warnings) | 585 (50%)            | High     |
| Prettier                     | 156 files     | 156 files need reformatting      | 156 (100%)           | Low      |
| TypeScript (`tsc --checkJs`) | 91 files      | 5,001 errors                     | ~646 via @types/node | High     |

**Total issues**: ~6,317 across 3 tools. Roughly 65% of ESLint issues and 100% of Prettier issues are mechanical/auto-fixable. TypeScript errors require a multi-phase approach.

---

## ESLint Results

### Totals

- **968 errors**, **192 warnings** across **123 files**
- **585 issues are auto-fixable** via `npm run lint:fix`

### Issues by Rule (sorted by frequency)

| #   | Rule                                           | Count | Type    | Fix                                    |
| --- | ---------------------------------------------- | ----- | ------- | -------------------------------------- |
| 1   | `n/prefer-node-protocol`                       | 176   | Error   | Auto-fix (`node:fs`, `node:path` etc.) |
| 2   | `no-unused-vars`                               | 129   | Error   | Manual (prefix with `_` or remove)     |
| 3   | `prefer-template`                              | 118   | Error   | Auto-fix (template literals)           |
| 4   | `no-await-in-loop`                             | 104   | Warning | Manual (refactor to `Promise.all`)     |
| 5   | `no-nested-ternary`                            | 95    | Error   | Manual (extract to if/else)            |
| 6   | `n/no-process-exit`                            | 83    | Error   | Manual (`process.exitCode = X`)        |
| 7   | `unicorn/no-negated-condition`                 | 82    | Warning | Manual (swap if/else branches)         |
| 8   | `n/no-unsupported-features/node-builtins`      | 68    | Error   | Config fix (see §3.2)                  |
| 9   | `unicorn/prefer-number-properties`             | 63    | Error   | Auto-fix (`Number.parseInt`)           |
| 10  | `unicorn/catch-error-name`                     | 48    | Error   | Mechanical (`error` → `err`)           |
| 11  | `n/hashbang`                                   | 46    | Error   | Config fix (see §3.1)                  |
| 12  | `require-atomic-updates`                       | 29    | Error   | Manual (real async race risks)         |
| 13  | `unicorn/no-for-loop`                          | 19    | Error   | Auto-fix (use `for...of`)              |
| 14  | `no-promise-executor-return`                   | 17    | Error   | Manual                                 |
| 15  | `unicorn/no-useless-undefined`                 | 13    | Error   | Auto-fix                               |
| 16  | `no-useless-assignment`                        | 13    | Error   | Manual                                 |
| 17  | `no-shadow`                                    | 10    | Error   | Manual (rename shadowed vars)          |
| 18  | `prefer-const`                                 | 7     | Error   | Auto-fix                               |
| 19  | `unicorn/prefer-ternary`                       | 6     | Warning | Manual                                 |
| 20  | `unicorn/prefer-at`                            | 4     | Error   | Auto-fix                               |
| 21  | `no-useless-escape`                            | 4     | Error   | Manual                                 |
| 22  | `no-param-reassign`                            | 4     | Error   | Manual                                 |
| 23  | `unicorn/no-array-for-each`                    | 3     | Error   | Auto-fix                               |
| 24  | `unicorn/prefer-string-starts-ends-with`       | 2     | Error   | Auto-fix                               |
| 25  | `prefer-exponentiation-operator`               | 2     | Error   | Auto-fix                               |
| 26  | `no-empty`                                     | 2     | Error   | Manual                                 |
| 27  | `no-control-regex`                             | 2     | Error   | Review                                 |
| 28  | `arrow-body-style`                             | 2     | Error   | Auto-fix                               |
| 29  | `unicorn/prefer-logical-operator-over-ternary` | 1     | Error   | Auto-fix                               |
| 30  | `unicorn/prefer-includes`                      | 1     | Error   | Auto-fix                               |

### §3.1 — False Positive: `n/hashbang` (46 errors)

The `n/hashbang` rule flags lib files (`lib/*.mjs`) that have `#!/usr/bin/env node` shebangs. Several lib files are designed to be executed directly (e.g., `lib/orchestrator-daemon.mjs`, `lib/hydra-usage.mjs`). The plugin's `n/hashbang` rule requires the `bin` field in `package.json` to list a file before allowing a shebang. These shebangs are **intentional** and the rule needs to be configured with exceptions or set to `warn`.

### §3.2 — False Positive: `n/no-unsupported-features/node-builtins` (68 errors)

The engine range `>=20.0.0` is too broad:

- `fetch` requires Node 21.0.0 (21 violations) — Hydra uses `fetch()` intentionally, with a fallback
- `test.describe` requires Node 20.13.0 (28 violations) — our test runner uses it
- `test.it.todo` requires Node 20.2.0 (19 violations)

**Fix**: Update `engines.node` to `>=20.13.0` to resolve the `test.*` false positives. For `fetch`, either add `/* eslint-disable */` where used or disable that specific check.

---

## Prettier Results

### Totals

- **156 files** with formatting issues (out of ~160 checked)
- **100% auto-fixable** with `npm run format`

### Breakdown by area

| Area         | Files     | Common Issues                                         |
| ------------ | --------- | ----------------------------------------------------- |
| `lib/`       | ~80 files | Quotes, trailing commas, line length, bracket spacing |
| `test/`      | ~47 files | Same as lib                                           |
| `bin/`       | ~10 files | Same                                                  |
| `scripts/`   | ~6 files  | Same                                                  |
| Config files | ~13 files | JSON formatting, YAML spacing                         |

All issues are mechanical and will be resolved by running `npm run format` once.

---

## TypeScript Results

### Totals

- **5,001 errors** across **91 files**
- This is the largest category and requires the most effort

### Top Error Codes

| Code    | Count | Description                                             | Primary Fix                          |
| ------- | ----- | ------------------------------------------------------- | ------------------------------------ |
| TS2339  | 1,645 | Property does not exist on type                         | JSDoc `@type` annotations on objects |
| TS7006  | 1,449 | Parameter implicitly has `any` type                     | JSDoc `@param {type}` annotations    |
| TS2580  | 479   | Cannot find name `process`/`console`/etc.               | Install `@types/node`                |
| TS7053  | 288   | Element implicitly has `any` type (index access)        | Add index signatures or typed Maps   |
| TS2307  | 167   | Cannot find module `node:path` etc.                     | Install `@types/node`                |
| TS18046 | 125   | `err` is of type `unknown`                              | Type narrowing in catch blocks       |
| TS7031  | 121   | Destructuring binding has implicit `any`                | JSDoc `@param` types                 |
| TS6133  | 121   | Declared but value is never read                        | Remove or prefix with `_`            |
| TS7005  | 116   | Variable implicitly has `any` type                      | JSDoc `@type`                        |
| TS2322  | 113   | Type not assignable                                     | Fix type mismatches                  |
| TS2345  | 108   | Argument type mismatch                                  | Fix call-site types                  |
| TS7034  | 71    | Variable implicitly has type `any` (declared initially) | Initial value or `@type`             |
| TS2353  | 67    | Object literal may only specify known properties        | Typed object literals                |
| TS18047 | 24    | Possibly `null`                                         | Null checks                          |
| TS18048 | 14    | Possibly `undefined`                                    | Undefined checks                     |

### Key Observation

**Installing `@types/node` will immediately eliminate ~646 errors** (TS2580 + TS2307). This is the single highest-impact fix in the entire audit. Currently `process`, `console`, `Buffer`, `URL`, all `node:*` module types are unknown to tsc.

The remaining ~4,355 errors are largely due to the codebase having **no JSDoc type annotations**. The codebase is plain JS with no type information — tsc in strict checkJs mode infers `any` for virtually every parameter and property. Resolving all TS errors completely would require annotating the entire codebase with JSDoc.

---

## Summary Matrix

| Category   | Total Issues | Auto-fixable    | Config Fix | Mechanical | Manual/Refactor |
| ---------- | ------------ | --------------- | ---------- | ---------- | --------------- |
| ESLint     | 1,160        | 585             | 114        | ~150       | ~311            |
| Prettier   | 156          | 156             | —          | —          | —               |
| TypeScript | 5,001        | 646             | —          | ~400       | ~3,955          |
| **Total**  | **6,317**    | **1,387 (22%)** | **114**    | **~550**   | **~4,266**      |

---

## Raw Output References

Full output available in session temp files:

- ESLint: `/tmp/eslint-results.txt` (1,414 lines)
- Prettier: `/tmp/prettier-results.txt` (162 lines)
- TypeScript: `/tmp/tsc-results.txt` (5,327 lines)
