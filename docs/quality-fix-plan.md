# Code Quality Fix Plan

> Based on: `docs/quality-audit.md` | Updated: 2026-03-09

This plan sequences fixes from highest-value/lowest-effort to lowest-value/highest-effort. Each phase is independently committable. The goal is to reach a clean baseline where `npm run quality` exits 0.

---

## Phase 1 — Instant Wins (1–2 hours, fully automated)

These changes require zero manual code review and can be applied in one commit.

### 1.1 — Install `@types/node`

```bash
npm install --save-dev @types/node
```

**Impact**: Eliminates ~646 TypeScript errors (TS2580 `process`/`console` not found, TS2307 `node:*` module not found). This is the single highest-ROI action in the audit.

### 1.2 — Run ESLint auto-fix

```bash
npm run lint:fix
```

**Impact**: Resolves **585 ESLint issues** across 123 files:

- All 176 `n/prefer-node-protocol` errors (`fs` → `node:fs`)
- All 118 `prefer-template` errors (string concat → template literals)
- All 63 `unicorn/prefer-number-properties` errors (`parseInt` → `Number.parseInt`)
- All 19 `unicorn/no-for-loop` errors (C-style loops → `for...of`)
- ~13 `unicorn/no-useless-undefined`, `prefer-const`, `arrow-body-style`, `unicorn/prefer-at`, and others

### 1.3 — Run Prettier auto-format

```bash
npm run format
```

**Impact**: Resolves all **156 Prettier formatting issues** across the entire codebase.

### 1.4 — Commit Phase 1

```bash
git add -A && git commit -m "style: apply auto-fix — node: protocol, template literals, Prettier format"
```

---

## Phase 2 — Config Fixes (30 min)

ESLint rule configuration issues that generate false positives.

### 2.1 — Update `engines.node` minimum version

**Problem**: `n/no-unsupported-features/node-builtins` fires 49 times because `>=20.0.0` is below the minimum for `test.describe` (20.13.0) and `test.it.todo` (20.2.0).

**Fix**: In `package.json`, change:

```json
"engines": { "node": ">=20.13.0" }
```

This resolves 47 of the 68 `n/no-unsupported-features` errors.

### 2.2 — Handle `fetch` unsupported-feature warnings

**Problem**: 21 errors flag `fetch` as unsupported (requires Node 21). Hydra uses `fetch()` intentionally in daemon clients.

**Fix option A** (recommended): Add a targeted disable comment to the affected files with a note that Node 22 is the dev runtime.

**Fix option B**: Disable `n/no-unsupported-features/node-builtins` for `fetch` in `eslint.config.mjs`:

```js
'n/no-unsupported-features/node-builtins': ['error', {
  ignores: ['fetch'],
}],
```

### 2.3 — Configure `n/hashbang` for intentional shebangs

**Problem**: 46 lib files that are runnable directly (e.g., `lib/orchestrator-daemon.mjs`) correctly have `#!/usr/bin/env node` but the rule flags them because they aren't listed in `package.json` `bin`.

**Fix option A** (recommended): Add an override in `eslint.config.mjs` to warn instead of error:

```js
'n/hashbang': 'warn',
```

This acknowledges that some lib files are intentionally executable without requiring all of them to be in `bin`.

**Fix option B**: Disable the rule entirely since bin files handle this correctly.

### 2.4 — Commit Phase 2

```bash
git add -A && git commit -m "ci(eslint): fix false positive rules — engines version, hashbang, fetch"
```

---

## Phase 3 — Mechanical Fixes (2–4 hours, scriptable)

These require code changes but follow a clear, repetitive pattern.

### 3.1 — Rename catch parameters: `error` → `err` (48 instances)

**Rule**: `unicorn/catch-error-name`

All `catch (error)` and `catch (e)` parameters must be renamed to `err`.

```bash
# Partial script — validate each change manually
grep -rn "catch (error)" lib/ bin/ | head -20
```

Strategy: Use `sed` or ESLint auto-fix where possible, then manually review.

### 3.2 — Prefix or remove unused variables (129 instances)

**Rule**: `no-unused-vars`

For each unused variable:

- If it's a deliberate placeholder, prefix with `_` (e.g., `_listWorktrees`)
- If it's dead code, remove it

Priority files (most violations):

- `lib/hydra-worktree-isolation.mjs` — 3+ unused exported functions
- `lib/hydra-ui.mjs` — `ACCENT` and other unused color constants
- Various lib files with unused destructured vars

### 3.3 — Replace `process.exit()` with `process.exitCode` (83 instances)

**Rule**: `n/no-process-exit`

The preferred pattern for graceful shutdown:

```js
// Before
process.exit(1);

// After
process.exitCode = 1;
return; // or throw if in an async context
```

**Note**: In CLI entry points (`bin/`) and daemon shutdown handlers, `process.exit()` may be intentional. Evaluate each call site. Consider adding `/* eslint-disable n/no-process-exit */` with a comment on legitimate forced-exit cases.

### 3.4 — Add TypeScript `@types/node` and basic JSDoc (after Phase 1.1)

After installing `@types/node` in Phase 1.1, remaining TS7006 (`parameter has implicit any`) can be reduced by adding JSDoc `@param` types to frequently-called functions. Prioritize:

- Public-facing exports in `lib/hydra-config.mjs`
- Agent dispatch functions in `lib/hydra-dispatch.mjs`
- HTTP handler utilities in `lib/hydra-utils.mjs`

### 3.5 — Commit Phase 3

```bash
git add -A && git commit -m "fix: catch error naming, unused vars, process.exit patterns"
```

---

## Phase 4 — Code Quality Improvements (1–2 days, needs thought)

These require careful refactoring and understanding of business logic.

### 4.1 — Eliminate nested ternaries (95 instances)

**Rule**: `no-nested-ternary`

Each nested ternary should be replaced with either:

```js
// Option A — if/else
if (a) {
  x = b;
} else if (c) {
  x = d;
} else {
  x = e;
}

// Option B — named intermediate variable
const intermediate = a ? b : c;
const result = intermediate ? d : e;
```

Start with files having the most violations.

### 4.2 — Fix `no-await-in-loop` (104 warnings)

**Rule**: `no-await-in-loop`

Sequential awaits in loops are a performance anti-pattern. Refactor to `Promise.all()` where order doesn't matter:

```js
// Before (sequential, slow)
for (const agent of agents) {
  await sendTask(agent);
}

// After (concurrent)
await Promise.all(agents.map((agent) => sendTask(agent)));
```

**Caution**: Some loops intentionally run sequentially (rate limiting, ordered side effects). Audit each case before converting. Add `// sequential intentional` comment where `no-await-in-loop` should be suppressed.

### 4.3 — Swap negated conditions (82 warnings)

**Rule**: `unicorn/no-negated-condition`

```js
// Before
if (!isValid) {
  handleError();
} else {
  proceed();
}

// After
if (isValid) {
  proceed();
} else {
  handleError();
}
```

These are low-risk mechanical changes that improve readability.

### 4.4 — Fix `require-atomic-updates` (29 errors)

**Rule**: `require-atomic-updates`

These flag potential race conditions in async code:

```js
// Dangerous
this.state = await fetch(...);  // state can be overwritten between read and write

// Safe
const result = await fetch(...);
this.state = result;
```

Each instance should be reviewed for actual race condition risk in the daemon's concurrent request handling.

### 4.5 — Fix `no-promise-executor-return` (17 errors)

```js
// Before — returns inside Promise executor (ignored)
new Promise((resolve) => {
  return someAsyncOp().then(resolve); // return value ignored
});

// After
new Promise((resolve) => {
  someAsyncOp().then(resolve);
});
```

---

## Phase 5 — TypeScript Deep Dive (1+ week, ongoing)

The 5,001 TypeScript errors are largely a reflection of zero JSDoc annotations on a large JS codebase. Full resolution is a long-term goal.

### 5.1 — Tighten tsc config incrementally

After Phase 1.1 (`@types/node`), re-run `tsc` and use the remaining error count as a baseline. Consider dropping `strict: true` to `noImplicitAny: false` initially, then re-enabling rules one at a time:

```json
{
  "compilerOptions": {
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "noImplicitAny": false, // start here
    "strictNullChecks": true // enable these one at a time
  }
}
```

### 5.2 — Add JSDoc types to core modules

Start with the most-imported modules and work outward:

1. `lib/hydra-config.mjs` — config shape types
2. `lib/hydra-utils.mjs` — HTTP request/response types
3. `lib/hydra-agents.mjs` — agent definition types
4. `lib/orchestrator-daemon.mjs` — daemon state types
5. `lib/hydra-dispatch.mjs` — task/result types

Use TypeScript's `@typedef` for complex shapes:

```js
/**
 * @typedef {{ id: string, agent: string, prompt: string }} Task
 */
```

### 5.3 — Add `// @ts-nocheck` to test files

Test files don't need type checking. Adding `// @ts-nocheck` at the top of each test file will reduce the total error count and keep CI focus on lib code.

### 5.4 — Long-term goal: zero `tsc` errors

A clean TypeScript baseline allows catching real type bugs before they hit production. Set `continue-on-error: false` in `quality.yml` once the error count reaches 0.

---

## Execution Roadmap

| Phase            | Effort   | Impact | ESLint Δ   | Prettier Δ | TS Δ       |
| ---------------- | -------- | ------ | ---------- | ---------- | ---------- |
| 1 — Auto-fix     | 1–2 hr   | High   | -585       | -156       | -646       |
| 2 — Config fixes | 30 min   | Medium | -114       | 0          | 0          |
| 3 — Mechanical   | 2–4 hr   | Medium | -260       | 0          | ~-200      |
| 4 — Code quality | 1–2 days | High   | -311       | 0          | 0          |
| 5 — TypeScript   | 1+ week  | High   | 0          | 0          | ~-4,155    |
| **Total**        |          |        | **-1,160** | **-156**   | **-5,001** |

### Recommended next step

Run Phase 1 immediately (it's a one-liner):

```bash
npm install --save-dev @types/node && npm run lint:fix && npm run format
```

This resolves ~1,387 issues (~22% of all problems) in under 5 minutes with zero manual review.

---

## Tracking

Create a PR per phase to keep diffs reviewable. Suggested PR titles:

- `style: apply auto-fix passes (Phase 1)`
- `ci(eslint): fix false positive rule configs (Phase 2)`
- `fix: mechanical catch/unused-vars/process.exit cleanup (Phase 3)`
- `refactor: eliminate nested ternaries and await-in-loop (Phase 4)`
- `types: add JSDoc annotations to core modules (Phase 5)`
