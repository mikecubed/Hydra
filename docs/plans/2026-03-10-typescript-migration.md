# TypeScript Migration Plan

**Status:** Draft — 2026-03-10  
**Supersedes:** `docs/typescript-migration-handoff.md` (preserved as historical reference)

**Goal:** Convert all Hydra source files from `.mjs` (JS with `--checkJs`) to full `.ts` with the
strictest practically-achievable TypeScript configuration, exhaustive ESLint type-aware rules, and
TDD-gated phase gates.

**Current baseline:** 4,346 typecheck errors across 88 lib files (all due to `--checkJs` limits on
plain JS — not regressions; the code is correct, just unannotated). Tests: 395 passing.

---

## Dependency on Other Plans

This migration is a **prerequisite** for parts of the Copilot integration and dynamic dispatch
work. Specifically:

| TS migration phase           | Unblocks                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase 3 (config & models)    | Task D + Task 11 in `2026-03-07-github-copilot-cli-integration.md` — `resolveCliModelId()` written in TS from day one |
| Phase 4 (agent system)       | Task 1 — Copilot plugin written in TS with proper `AgentDef` types                                                    |
| Phase 7 (dispatch & council) | Task A in `2026-03-10-dynamic-agent-dispatch.md` — dispatch refactor written in TS                                    |

Phases 1–4 of this plan should complete before the Copilot/dispatch implementation starts.
Phases 5–12 can proceed alongside or after those features.

---

## Strict TypeScript Configuration

### `tsconfig.json` (replaces `jsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": ".tsbuild",

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noPropertyAccessFromIndexSignature": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "allowJs": true,
    "checkJs": true,

    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["lib/**/*.ts", "bin/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist", ".tsbuild", ".build-exe", ".pkg-cache"]
}
```

> **Note:** `allowJs` and `checkJs` are `true` throughout the migration so existing `.mjs` files retain type checking. They flip to `false` only in Phase 12 when all files are converted.

**Why each non-`strict` flag matters:**

| Flag                                 | Why enabled                                                                                                                                                                           | Expected churn                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `noUncheckedIndexedAccess`           | `obj[key]` and `arr[i]` return `T \| undefined` — forces null-check before use                                                                                                        | High — enable after Phase 3 (once Map/Record patterns are typed; not at Phase 0) |
| `noPropertyAccessFromIndexSignature` | Dot notation on index signatures is banned; must use bracket notation                                                                                                                 | Low                                                                              |
| `exactOptionalPropertyTypes`         | `{ foo?: string }` cannot receive `{ foo: undefined }` — eliminates a class of subtle bugs                                                                                            | Medium                                                                           |
| `noImplicitOverride`                 | Methods overriding a base must use `override` keyword                                                                                                                                 | Low (few class hierarchies)                                                      |
| `verbatimModuleSyntax`               | Enforces `import type` for type-only imports — required for `isolatedModules`                                                                                                         | Medium — many JSDoc imports become `import type`                                 |
| `isolatedModules`                    | Each file compiles independently — required for `tsx` (esbuild-based) dev runner                                                                                                      | Low                                                                              |
| `allowUnreachableCode: false`        | Compiler errors on dead code                                                                                                                                                          | Low                                                                              |
| `skipLibCheck: true`                 | `node_modules/string_decoder` has 73 pre-existing TS errors in its type declarations. This is the **only general exception** — all other rules are file-specific inline suppressions. |

> **`noUncheckedIndexedAccess` rollout strategy:** Set to `false` in Phase 0. After Phase 3 converts the Map-heavy config and metrics files, re-enable it as a targeted sub-task and fix the resulting errors file-by-file. This avoids reviewer fatigue across 88 files simultaneously.

**`noUncheckedIndexedAccess` exception policy** (the strictest rule, most suppressed):

```typescript
// ✅ CORRECT — check before use
const val = map.get(key);
if (val === undefined) return;
// val is T here

// ✅ CORRECT — non-null assertion only when checked immediately above
if (!map.has(key)) throw new Error(`Missing key: ${key}`);
const val = map.get(key)!; // justified: has() confirmed existence on the line above

// ❌ WRONG — blind non-null assertion
const val = arr[0]!;

// ✅ CORRECT — with-index pattern
for (const [i, item] of arr.entries()) { ... } // i is number, item is T (not T | undefined)
```

---

## Strict ESLint Configuration

### New dev dependencies

```bash
npm install --save-dev typescript-eslint tsx @types/node@^22
```

> `typescript-eslint` — unified v8+ package (replaces `@typescript-eslint/eslint-plugin` +
> `@typescript-eslint/parser`).  
> `tsx` — dev runner for `.ts` files without a compile step (esbuild-based, honors `isolatedModules`).  
> `@types/node@^22` — bump from `^20.19.0` to get Node 22 type coverage.

### `eslint.config.mjs` additions

Add after the existing rules block, as a new config layer targeting `**/*.ts` files only:

```javascript
import tseslint from 'typescript-eslint';

// Add to the export default array:

// ─── TypeScript files — type-aware strict rules ───────────────────────────
...tseslint.configs.strictTypeChecked,
{
  files: ['**/*.ts'],
  languageOptions: {
    parserOptions: {
      project: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    // ── Replace JS rules with TS-aware equivalents ────────────────────────
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    'no-throw-literal': 'off',
    '@typescript-eslint/only-throw-error': 'error',
    'require-await': 'off',
    '@typescript-eslint/require-await': 'error',

    // ── Type safety (all errors, no warnings) ────────────────────────────
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-unsafe-enum-comparison': 'error',

    // ── Promise / async correctness ───────────────────────────────────────
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],

    // ── Strict boolean expressions ────────────────────────────────────────
    // Phase in as error after Phase 6; hundreds of existing if(value) patterns need updating first
    '@typescript-eslint/strict-boolean-expressions': [
      'warn',
      {
        allowString: false,
        allowNumber: false,
        allowNullableObject: true,       // common pattern: if (obj?.prop)
        allowNullableBoolean: false,
        allowNullableString: false,
        allowNullableNumber: false,
        allowAny: false,
      },
    ],

    // ── Type imports (enforced by verbatimModuleSyntax, lint as backup) ──
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/consistent-type-exports': 'error',

    // ── Explicit return types on public API ───────────────────────────────
    '@typescript-eslint/explicit-module-boundary-types': 'error',
    // explicit-function-return-type omitted — covered by module-boundary-types on exports;
    // internal functions use inference

    // ── Nullish coalescing and optional chaining ──────────────────────────
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',

    // ── Readonly where possible ───────────────────────────────────────────
    '@typescript-eslint/prefer-readonly': 'warn', // warn not error — daemon/event loop code has justified mutable state
    '@typescript-eslint/prefer-readonly-parameter-types': 'off', // too strict for Node APIs

    // ── Other strictness ──────────────────────────────────────────────────
    '@typescript-eslint/no-non-null-assertion': 'warn', // warn not error — justified use exists
    '@typescript-eslint/no-unnecessary-condition': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-redundant-type-constituents': 'error',
    '@typescript-eslint/use-unknown-in-catch-variables': 'error',
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
  },
},

// ─── Test files — relax a few strict TS rules ────────────────────────────
{
  files: ['test/**/*.ts'],
  rules: {
    '@typescript-eslint/no-unsafe-assignment': 'off',     // test assertions often use unknown
    '@typescript-eslint/no-unsafe-member-access': 'off',  // inspecting opaque return values
    '@typescript-eslint/no-floating-promises': 'off',     // node:test handles promise resolution
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/strict-boolean-expressions': 'off',
  },
},
```

### Why `strict-boolean-expressions` is strict

```typescript
// ❌ WRONG — string is truthy/falsy which is the bug vector
if (agent.name) { ... }            // passes if name === ''

// ✅ CORRECT — explicit undefined/null check
if (agent.name !== undefined) { ... }
if (agent.name.length > 0) { ... }
```

This rule catches the most bugs in an event-driven Node.js codebase. The `allowNullableObject`
carve-out prevents it from being unbearable on normal optional access patterns.

### Inline suppression policy

**No file-level or block-level disables.** Every suppression must be inline with a justification:

```typescript
// ✅ Required format
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns unknown by design; narrowed below
const parsed: unknown = JSON.parse(raw);

// ✅ @ts-expect-error with description (preferred over @ts-ignore — fails if suppression becomes stale)
// @ts-expect-error -- Node.js EventEmitter.emit overload typing gap in @types/node <22
emitter.emit('data', chunk);

// ❌ Never
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore
```

---

## Package.json Script Updates

```json
{
  "scripts": {
    "test": "node --import tsx/esm --test 'test/**/*.test.ts'",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "quality": "npm run lint && npm run format:check && npm run typecheck"
  }
}
```

> During migration, both `.mjs` and `.ts` test files coexist. Use a glob that covers both:
> `node --import tsx/esm --test 'test/**/*.test.{ts,mjs}'`

### `lint-staged` update

```json
{
  "lint-staged": {
    "*.{ts,mjs}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"]
  }
}
```

---

## TDD Process (Per File)

Each file conversion follows this checklist — no exceptions:

```
1. BASELINE  — run tests for this module: node --test test/hydra-<module>.test.{ts,mjs}
               Record pass count. This is the regression gate.

2. COVERAGE  — review test for public API coverage. Add type assertions where useful:
               • assert.ok(typeof result.output === 'string')
               • Explicit variable type annotations in tests:
                 const cfg: HydraConfig = await loadHydraConfig();

3. CONVERT   — rename .mjs → .ts
               • Replace JSDoc @param/@returns with inline TS types
               • Import types from lib/types.ts where they exist
               • All imports use .js extension (NodeNext resolution)
               • No `any` — use `unknown` then narrow, or a specific type
               • Add explicit return types on all exported functions

4. TYPECHECK — npx tsc --noEmit --allowJs false 2>&1 | grep <filename>
               Fix every error. No @ts-ignore. Use @ts-expect-error with reason if truly blocked.

5. LINT      — npx eslint lib/<filename>.ts
               Fix every error. Inline disables require justification comment.

6. TEST      — node --import tsx/esm --test test/hydra-<module>.test.{ts,mjs}
               Must match or exceed baseline pass count.

7. COMMIT    — atomic PR per file (or small batch of ≤5 related files)
               PR title: "refactor(<module>): convert to TypeScript"
```

---

## Phase 0 — Tooling Setup

**Status:** Not started  
**Estimated scope:** ~1 day  
**Blocks all other phases**

### Tasks

- [ ] `npm install --save-dev typescript-eslint tsx @types/node@^22`
- [ ] Create `tsconfig.json` (as above), delete `jsconfig.json`
- [ ] Add `typescript-eslint` block to `eslint.config.mjs` (as above)
- [ ] Update `package.json` scripts: `test`, `typecheck`
- [ ] Update `lint-staged` in `package.json` to add `*.ts` to the `*.mjs` glob
- [ ] Update `.github/workflows/quality.yml`:
  - Add `*.ts` to lint/typecheck paths
  - Keep `typecheck` as `continue-on-error: true` until Phase 2 completes (then remove)
  - Add `tsx` install step to CI
- [ ] Update `.husky/pre-commit` lint-staged pattern to `*.{ts,mjs}`
- [ ] Verify `npm run quality` runs without breaking on the still-JS codebase
  - The TS lint block only activates on `*.ts` files — zero `.ts` files exist yet, so no new errors

### Phase gate

`npm run quality` green on the current JS codebase. No `.ts` files exist yet.

---

## Phase 1 — Core Type Definitions

**Status:** Not started  
**File:** `lib/types.ts` (new)  
**Blocks:** Phases 3, 4, 5, 6, 7  
**Errors to fix:** 0 (new file)

Create the canonical shared type definitions. These replace scattered JSDoc typedefs. No logic —
types only.

```typescript
// lib/types.ts

// ── Agent system ────────────────────────────────────────────────────────────

export type AgentName = 'claude' | 'gemini' | 'codex' | 'local' | 'copilot' | string;
export type AgentType = 'physical' | 'virtual';
// Note: API agents (e.g. local) use features.executeMode = 'api'; AgentType distinguishes plugin architecture only
export type ExecuteMode = 'spawn' | 'api';

export interface AgentFeatures {
  executeMode: ExecuteMode;
  jsonOutput: boolean;
  stdinPrompt: boolean;
  reasoningEffort: boolean;
  streaming?: boolean;
  contextWindow?: number;
}

export interface AgentInvoke {
  nonInteractive: ((prompt: string, opts?: HeadlessOpts) => [string, string[]]) | null;
  interactive: ((prompt: string) => [string, string[]]) | null;
  headless: ((prompt: string, opts?: HeadlessOpts) => [string, string[]]) | null;
}

export interface HeadlessOpts {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;
}

export interface AgentResult {
  output: string;
  tokenUsage: TokenUsage | null;
  costUsd: number | null;
  exitCode?: number;
  error?: string;
}

export type PermissionMode = 'plan' | 'auto-edit' | 'full-auto';

export type ErrorPatterns = Partial<
  Record<
    'authRequired' | 'rateLimited' | 'quotaExhausted' | 'networkError' | 'subscriptionRequired',
    RegExp
  >
>;

export interface AgentDef {
  name: AgentName;
  label: string;
  type: AgentType;
  enabled: boolean;
  features: AgentFeatures;
  invoke: AgentInvoke;
  parseOutput: (stdout: string, opts?: ParseOutputOpts) => AgentResult;
  taskAffinity: Record<TaskType, number>;
  errorPatterns: ErrorPatterns;
  modelBelongsTo: (modelId: string) => boolean;
  quotaVerify: () => Promise<QuotaStatus | null>;
  economyModel: () => string | null;
  readInstructions: (() => string) | null;
  taskRules: string[];
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface HydraConfig {
  mode: HydraMode;
  models: Record<AgentName, ModelConfig>;
  routing: RoutingConfig;
  agents: AgentsConfig;
  usage: UsageConfig;
  roles: Record<string, RoleConfig>;
  context: ContextConfig;
  local?: LocalConfig;
}

export type HydraMode = 'auto' | 'smart' | 'council' | 'dispatch' | 'chat';

export interface ModelConfig {
  default: string;
  fast?: string;
  cheap?: string;
  active: 'default' | 'fast' | 'cheap';
}

export interface RoleConfig {
  agent: AgentName;
  model: string | null;
}

export interface RoutingConfig {
  mode: RoutingMode;
  intentGate?: IntentGateConfig;
  worktreeIsolation?: WorktreeIsolationConfig;
}

export type RoutingMode = 'economy' | 'balanced' | 'performance';

export interface IntentGateConfig {
  enabled: boolean;
  confidenceThreshold: number;
}

export interface WorktreeIsolationConfig {
  enabled: boolean;
}

export interface AgentsConfig {
  customAgents: CustomAgentDef[];
}

export interface CustomAgentDef {
  name: string;
  label: string;
  type: 'cli' | 'api';
  command?: string;
  args?: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}

export interface UsageConfig {
  dailyTokenBudget: Record<AgentName, number>;
  weeklyTokenBudget: Record<AgentName, number>;
}

export interface ContextConfig {
  hierarchical: { enabled: boolean };
}

export interface LocalConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  budgetGate?: number;
}

// ── Task & Dispatch ─────────────────────────────────────────────────────────

export type TaskType =
  | 'planning'
  | 'architecture'
  | 'review'
  | 'refactor'
  | 'implementation'
  | 'analysis'
  | 'testing'
  | 'research'
  | 'documentation'
  | 'security';

export type TaskStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'timeout';

export interface TaskState {
  id: string;
  type: TaskType;
  prompt: string;
  status: TaskStatus;
  agent?: AgentName;
  result?: AgentResult;
  claimedAt?: number;
  completedAt?: number;
  createdAt: number;
}

export interface RoutingDecision {
  agent: AgentName;
  model: string;
  reason: string;
  affinity: number;
}

// ── Models ──────────────────────────────────────────────────────────────────

export type ModelTier = 'default' | 'fast' | 'cheap' | 'premium';

export interface ModelProfile {
  name: string;
  agent: AgentName;
  tier: ModelTier;
  contextWindow: number;
  cliModelId?: string; // CLI --model flag value if different from Hydra internal ID
  inputCostPer1k?: number;
  outputCostPer1k?: number;
}

// ── Usage ───────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  premiumRequests?: number; // Copilot: premium API calls consumed
}

export interface QuotaStatus {
  verified: boolean;
  status: string;
  reason?: string;
}

// ── Copilot JSONL event stream ───────────────────────────────────────────────

export type CopilotEventType =
  | 'user.message'
  | 'assistant.turn_start'
  | 'assistant.message'
  | 'assistant.message_delta'
  | 'assistant.reasoning'
  | 'assistant.reasoning_delta'
  | 'tool.execution_start'
  | 'tool.execution_complete'
  | 'assistant.turn_end'
  | 'result';

export interface CopilotJsonlEvent {
  type: CopilotEventType;
  data: CopilotEventData;
}

export interface CopilotEventData {
  content?: string;
  toolRequests?: unknown[];
  usage?: {
    premiumRequests?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

// ── Parse output ────────────────────────────────────────────────────────────

export interface ParseOutputOpts {
  model?: string;
  agent?: AgentName;
  jsonOutput?: boolean;
}
```

### Tests

```typescript
// test/hydra-types.test.ts — type-level compilation tests (no runtime assertions needed)
// These imports will fail to compile if types are broken.
import type {
  AgentDef,
  HydraConfig,
  TaskState,
  ModelProfile,
  CopilotJsonlEvent,
  AgentResult,
} from '../lib/types.js';

// Structural assignment checks — tsc validates these at compile time
// satisfies validates shape at compile time without triggering noUnusedLocals
const _agentResult = { output: 'ok', tokenUsage: null, costUsd: null } satisfies AgentResult;
const _profile = {
  name: 'Test Model',
  agent: 'copilot' as AgentName,
  tier: 'default' as const,
  contextWindow: 128000,
  cliModelId: 'claude-sonnet-4.6',
} satisfies ModelProfile;
```

### Phase gate

`tsc --noEmit` with `include: ["lib/types.ts"]` exits 0.

---

## Phase 2 — Zero / Near-Zero Error Utilities

**Status:** Not started  
**Files:** 15 files, 1–10 errors each  
**Converts:** The lowest-risk files — safe to practice TDD process and tooling

| File                                 | Errors | Notes                           |
| ------------------------------------ | ------ | ------------------------------- |
| `lib/hydra-env.mjs`                  | 1      | Minimal `.env` loader — no deps |
| `lib/hydra-version.mjs`              | 3      | Version string — no deps        |
| `lib/hydra-shared/git-ops.mjs`       | 1      | Git utility helpers             |
| `lib/hydra-shared/codex-helpers.mjs` | 3      | Codex-specific helpers          |
| `lib/hydra-shared/guardrails.mjs`    | 4      | Safety filters                  |
| `lib/hydra-github.mjs`               | 4      | GitHub API calls                |
| `lib/hydra-intent-gate.mjs`          | 4      | Prompt pre-screening            |
| `lib/hydra-sub-agents.mjs`           | 2      | Sub-agent launcher              |
| `lib/hydra-sync-md.mjs`              | 6      | Markdown sync utility           |
| `lib/hydra-worktree.mjs`             | 8      | Git worktree management         |
| `lib/hydra-openai.mjs`               | 8      | OpenAI API client               |
| `lib/hydra-anthropic.mjs`            | 8      | Anthropic API client            |
| `lib/hydra-action-pipeline.mjs`      | 8      | Action pipeline                 |
| `lib/hydra-roster.mjs`               | 8      | Agent roster/status             |
| `lib/hydra-tasks-scanner.mjs`        | 10     | TODO/FIXME scanner              |

### Phase gate

`npm test` still green. `npm run typecheck` error count decreases by ≥15 files' worth of errors.

---

## Phase 3 — Config & Models

**Status:** Not started  
**Files:** 10 files, 16–57 errors each  
**Blocks:** Task D + Task 11 in the Copilot integration plan  
**Hard spots:** `hydra-config.mjs` (`_setTestConfig` deep partial merge), `hydra-rate-limits.mjs` (Map-heavy)

| File                           | Errors | Notes                                                                     |
| ------------------------------ | ------ | ------------------------------------------------------------------------- |
| `lib/hydra-model-profiles.mjs` | 35     | Add `resolveCliModelId()` export here **in TS from the start**            |
| `lib/hydra-config.mjs`         | 29     | `HydraConfig` + `_setTestConfig<T>(partial: DeepPartial<HydraConfig>)`    |
| `lib/hydra-models.mjs`         | 16     | Model ID utilities                                                        |
| `lib/hydra-models-select.mjs`  | 28     | Model selection UI                                                        |
| `lib/hydra-rate-limits.mjs`    | 57     | `Map<string, RateLimitEntry>` — `noUncheckedIndexedAccess` hits hard here |
| `lib/hydra-metrics.mjs`        | 49     | Metrics accumulation — Map-heavy                                          |
| `lib/hydra-telemetry.mjs`      | 47     | OpenTelemetry wrapper                                                     |
| `lib/hydra-cache.mjs`          | 37     | LRU cache — generics needed                                               |
| `lib/hydra-utils.mjs`          | 48     | HTTP `request()` helper                                                   |
| `lib/hydra-local.mjs`          | 6      | Local API agent                                                           |
| `lib/hydra-setup.mjs`          | 45     | CLI detection, MCP config registration                                    |

### Notable: `_setTestConfig` typing

```typescript
// Deep partial utility type
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

export function _setTestConfig(override: DeepPartial<HydraConfig>): void { ... }
```

### Notable: `hydra-cache.mjs` generic cache

```typescript
export class Cache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  get(key: K): V | undefined { ... }
  set(key: K, value: V, ttlMs?: number): void { ... }
}
```

### Notable: `resolveCliModelId` (new export, written in TS from day one)

This is Task D from the dynamic dispatch plan. Write it here in Phase 3 rather than in JS:

```typescript
// lib/hydra-model-profiles.ts
import type { ModelProfile } from './types.js';

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = { ... };

export function getModelProfile(modelId: string): ModelProfile | undefined {
  return MODEL_PROFILES[modelId];
}

export function resolveCliModelId(modelId: string): string {
  return MODEL_PROFILES[modelId]?.cliModelId ?? modelId;
}
```

### Phase gate

`npm test` green. Task D and Task 11 from the Copilot plan can now be implemented in TypeScript.

---

## Phase 4 — Agent System

**Status:** Not started  
**Files:** 8 files, 4–165 errors each  
**Blocks:** Task 1 (Copilot plugin) in the integration plan  
**Hard spots:** `hydra-agents.mjs` (plugin registry generics), `agent-executor.mjs` (stdio streaming types)

| File                                  | Errors | Notes                                            |
| ------------------------------------- | ------ | ------------------------------------------------ |
| `lib/hydra-shared/budget-tracker.mjs` | 4      | Budget accounting                                |
| `lib/hydra-shared/review-common.mjs`  | 6      | Shared review helpers                            |
| `lib/hydra-shared/constants.mjs`      | 0      | Constants — trivial                              |
| `lib/hydra-shared/index.mjs`          | 0      | Re-export barrel                                 |
| `lib/hydra-agents-wizard.mjs`         | 43     | Agent setup wizard                               |
| `lib/hydra-agent-forge.mjs`           | 85     | Dynamic agent creation                           |
| `lib/hydra-agents.mjs`                | 124    | Plugin registry — **hardest file in this phase** |
| `lib/hydra-shared/agent-executor.mjs` | 165    | Subprocess runner — **most errors**              |

### Notable: `hydra-agents.mjs` plugin registry

The `_registry` is `Map<AgentName, AgentDef>`. The tricky part is `registerAgent()` which merges
defaults — use `Partial<AgentDef>` input and `Required<AgentDef>` output:

```typescript
type AgentDefInput = Omit<AgentDef, 'enabled' | 'errorPatterns' | 'taskRules'> &
  Partial<Pick<AgentDef, 'enabled' | 'errorPatterns' | 'taskRules'>>;

export function registerAgent(def: AgentDefInput): AgentDef {
  const full: AgentDef = {
    enabled: true,
    errorPatterns: [],
    taskRules: [],
    ...def,
  };
  _registry.set(full.name, full);
  return full;
}
```

### Notable: `agent-executor.mjs` subprocess stdio

`spawn()` returns chunks typed as `Buffer | string`. Use explicit narrowing:

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-spawn child process event typing
child.stdout?.on('data', (chunk: Buffer | string) => {
  const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  // ...
});
```

### Phase gate

`npm test` green. Copilot plugin (Task 1) can now be implemented in TypeScript.

---

## Phase 5 — UI Layer

**Status:** Not started  
**Files:** 5 files, 1–129 errors each

| File                                 | Errors | Notes                         |
| ------------------------------------ | ------ | ----------------------------- |
| `lib/hydra-output-history.mjs`       | 19     | Output ring buffer            |
| `lib/hydra-prompt-choice.mjs`        | 39     | readline cooperative lock     |
| `lib/hydra-statusbar.mjs`            | 54     | Terminal status bar           |
| `lib/hydra-streaming-middleware.mjs` | 37     | Stream transform              |
| `lib/hydra-ui.mjs`                   | 129    | Terminal colors, boxes, icons |

### Notable: `hydra-prompt-choice.mjs` readline `resolve` typing

Current JSDoc needs a hint:

```typescript
// @ts-expect-error -- readline Promise resolve stored in closure; TS cannot infer without explicit typing
let pendingResolve: ((value: string) => void) | null = null;
```

Better: use explicit type:

```typescript
let pendingResolve: ((value: string) => void) | null = null;
// No suppression needed with explicit type annotation
```

### Phase gate

`npm test` green. Total TS errors < 2,500 (down from 4,346).

---

## Phase 6 — Daemon & Routes

**Status:** Not started  
**Files:** 8 files, 8–145 errors each

| File                          | Errors | Notes                             |
| ----------------------------- | ------ | --------------------------------- |
| `lib/hydra-proc.mjs`          | 15     | Process management                |
| `lib/hydra-verification.mjs`  | 13     | Verification plan runner          |
| `lib/hydra-worker.mjs`        | ~20    | Worker heartbeat loop             |
| `lib/orchestrator-client.mjs` | 35     | HTTP client for daemon            |
| `lib/daemon/read-routes.mjs`  | 44     | GET route handlers                |
| `lib/daemon/write-routes.mjs` | 47     | POST/PUT route handlers           |
| `lib/orchestrator-daemon.mjs` | 145    | Main daemon — event-sourced state |

### Notable: `orchestrator-daemon.mjs` event-sourced state

`SessionState` and `TaskState` from `lib/types.ts` apply directly here. The event store is typed as:

```typescript
type DaemonEvent =
  | { type: 'task.added'; payload: TaskState }
  | { type: 'task.claimed'; payload: { id: string; agent: AgentName; claimedAt: number } }
  | { type: 'task.completed'; payload: { id: string; result: AgentResult; completedAt: number } }
  | { type: 'session.started'; payload: { sessionId: string; startedAt: number } };

// Discriminated union — exhaustive switch guaranteed by @typescript-eslint/switch-exhaustiveness-check
```

### Phase gate

`npm test` green, including integration tests (`*.integration.test.mjs`).

---

## Phase 7 — Dispatch & Council

**Status:** Not started  
**Files:** 7 files, 4–216 errors each  
**Blocks:** Task A (dynamic dispatch refactor) in `2026-03-10-dynamic-agent-dispatch.md`

| File                             | Errors | Notes                                                         |
| -------------------------------- | ------ | ------------------------------------------------------------- |
| `lib/hydra-context.mjs`          | 37     | Hierarchical HYDRA.md injection                               |
| `lib/hydra-actualize-review.mjs` | 29     | Actualize review logic                                        |
| `lib/hydra-actualize.mjs`        | 56     | Actualize dispatch                                            |
| `lib/hydra-intent-gate.mjs`      | 4      | Already converted in Phase 2                                  |
| `lib/hydra-dispatch.mjs`         | 66     | Smart dispatch — hardcoded agents (see dynamic dispatch plan) |
| `lib/hydra-council.mjs`          | 216    | Multi-round deliberation                                      |

### Notable: `hydra-dispatch.mjs` report object

The `report` object has dynamic keys. Use a typed interface:

```typescript
interface DispatchReport {
  coordinator: DispatchSlotResult;
  critic: DispatchSlotResult;
  synthesizer: DispatchSlotResult;
  // Backward compat aliases (populated by Task A)
  claude?: DispatchSlotResult;
  gemini?: DispatchSlotResult;
  codex?: DispatchSlotResult;
}
```

### Notable: `hydra-council.mjs` deliberation accumulation

Multi-round results use a `Map<number, RoundResult[]>`. Generic types apply cleanly:

```typescript
interface RoundResult {
  agent: AgentName;
  round: number;
  output: string;
  parsed: unknown; // Agent-specific parsed output; narrowed per agent
}
```

### Phase gate

`npm test` green. Task A (dynamic dispatch) can now be implemented in TypeScript.

---

## Phase 8 — Evolve & Nightly

**Status:** Not started  
**Files:** 10 files, 16–342 errors each  
**Note:** These are self-improvement system files — complex but isolated from user-facing features

| File                                   | Errors | Notes                                             |
| -------------------------------------- | ------ | ------------------------------------------------- |
| `lib/hydra-evolve-guardrails.mjs`      | 16     | Safety checks                                     |
| `lib/hydra-nightly-discovery.mjs`      | 22     | Nightly discovery                                 |
| `lib/hydra-nightly-review.mjs`         | 28     | Nightly review                                    |
| `lib/hydra-evolve-knowledge.mjs`       | 33     | Knowledge base                                    |
| `lib/hydra-evolve-suggestions-cli.mjs` | 35     | Suggestions CLI                                   |
| `lib/hydra-evolve-review.mjs`          | 56     | Evolution review                                  |
| `lib/hydra-nightly.mjs`                | 112    | Nightly orchestrator                              |
| `lib/hydra-evolve-suggestions.mjs`     | 89     | Suggestions backlog                               |
| `lib/hydra-evolve-investigator.mjs`    | ~30    | Issue investigator                                |
| `lib/hydra-evolve.mjs`                 | 342    | Main evolve loop — **most errors after operator** |

### Phase gate

`npm test` green. Total TS errors < 1,000.

---

## Phase 9 — Remaining lib/

**Status:** Not started  
**Files:** ~20 files, 6–135 errors each

| File                                 | Errors |
| ------------------------------------ | ------ |
| `lib/sync.mjs`                       | 57     |
| `lib/hydra-tasks.mjs`                | 135    |
| `lib/hydra-audit.mjs`                | 70     |
| `lib/hydra-activity.mjs`             | 72     |
| `lib/hydra-usage.mjs`                | 87     |
| `lib/hydra-doctor.mjs`               | 77     |
| `lib/hydra-cleanup.mjs`              | 56     |
| `lib/hydra-concierge.mjs`            | 64     |
| `lib/hydra-concierge-providers.mjs`  | 16     |
| `lib/hydra-eval.mjs`                 | 42     |
| `lib/hydra-tasks-review.mjs`         | 24     |
| `lib/hydra-codebase-context.mjs`     | 28     |
| `lib/hydra-mcp.mjs`                  | 21     |
| `lib/hydra-mcp-server.mjs`           | 29     |
| `lib/hydra-streaming-middleware.mjs` | 37     |
| `lib/hydra-persona.mjs`              | 17     |
| `lib/hydra-provider-usage.mjs`       | 17     |
| `lib/hydra-self.mjs`                 | 27     |
| `lib/hydra-model-recovery.mjs`       | 53     |
| `lib/hydra-hub.mjs`                  | 11     |
| `lib/hydra-exec.mjs`                 | 11     |
| `lib/hydra-google.mjs`               | 13     |
| `lib/hydra-resume-scanner.mjs`       | 9      |
| `lib/hydra-updater.mjs`              | 4      |

### Phase gate

`npm test` green. Total TS errors < 100.

---

## Phase 10 — Operator Console

**Status:** Not started  
**File:** `lib/hydra-operator.mjs` — 6,392 lines, 504 errors  
**This file deserves its own phase.**

The operator is a large command-dispatch REPL. The 504 errors are dominated by TS2339
(command handler return types not inferred through the dispatch map). Strategy:

1. Extract the command dispatch map type:
   ```typescript
   type CommandHandler = (args: string[], rl: readline.Interface) => Promise<void> | void;
   const commands: Map<string, CommandHandler> = new Map();
   ```
2. The switch statement on command names gains exhaustiveness checking via
   `@typescript-eslint/switch-exhaustiveness-check` — a big win for correctness.
3. Inline state objects (readline state, UI state) get proper interfaces.
4. This phase alone clears ~500 errors.

### Phase gate

`npm test` green. `npm run typecheck` exits 0 (or with only test-file errors if tests not yet converted).

---

## Phase 11 — bin/ and scripts/

**Status:** Not started  
**Files:** Entry points and dev utilities

Convert `bin/*.mjs` and `scripts/*.mjs` to `.ts`. These have fewer errors and are tested
indirectly. `eslint.config.mjs` stays as `.mjs` (ESLint flat config requires it).

### Phase gate

`npm run quality` passes. No suppressed errors without justification.

---

## Phase 12 — Tests

**Status:** Not started  
**Files:** 44 test files  
**Convert last** — tests are the regression net during the migration

Strategy:

1. Rename `.test.mjs` → `.test.ts`
2. Add explicit type imports for values under test
3. Remove workarounds that existed only because the source was untyped
4. `@typescript-eslint` is relaxed in test files (see ESLint config) — fewer hoops to jump through

### Phase gate — Final success criteria

- [ ] `npm run typecheck` exits 0, **no `continue-on-error`** in CI (remove from `quality.yml`)
- [ ] `npm test` passes (all tests green)
- [ ] `npm run quality` passes (lint + format + typecheck — all blocking)
- [ ] `grep -r '@ts-ignore' lib/ bin/ scripts/ test/` returns **zero results**
- [ ] `grep -rn 'eslint-disable ' lib/ bin/ scripts/` — every result has an inline justification comment
- [ ] No `any` in exported APIs: `grep -rn ': any' lib/` limited to generated/external interfaces only
- [ ] CI `quality.yml` typecheck step: `continue-on-error: false`

---

## Known Exception Categories

These patterns will appear across many files. Pre-approved inline forms:

### 1. `JSON.parse` results

```typescript
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse; narrowed below
const raw: unknown = JSON.parse(text) as unknown;
// Then use a type guard or zod schema to narrow
```

### 2. `noUncheckedIndexedAccess` with Map.get() + Map.has()

```typescript
// Non-null assertion justified: has() confirmed key on previous line
if (!map.has(key)) return undefined;
return map.get(key)!;
```

### 3. subprocess stdio chunk type

```typescript
child.stdout?.on('data', (chunk: Buffer | string) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Buffer.toString() is always valid
  const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
});
```

### 4. Dynamic import for optional peer dependencies

```typescript
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- optional peer dep; guarded by try/catch
const { trace } = await import('@opentelemetry/api').catch(() => ({ trace: null }));
```

### 5. `_setTestConfig` deep partial in tests

```typescript
// Tests only — safe to cast in test context
_setTestConfig({ routing: { mode: 'economy' } } as DeepPartial<HydraConfig>);
```

---

## Files That Stay as `.mjs`

| File                                           | Reason                             |
| ---------------------------------------------- | ---------------------------------- |
| `eslint.config.mjs`                            | ESLint flat config requires `.mjs` |
| `.husky/pre-commit`, `.husky/pre-push`         | Shell scripts                      |
| Any file in `test/fixtures/` or `test/golden/` | Test data                          |

### Mixed .mjs / .ts State Risk

During Phases 2–11, the codebase contains both `.mjs` and `.ts` files importing each other.
Key rules:

- All imports use `.js` extension regardless of source extension (NodeNext resolution)
- `tsconfig.json` `include` covers both `**/*.ts` and `**/*.mjs` while `allowJs: true`
- After each phase, run: `node --import tsx/esm --test 'test/**/*.test.{ts,mjs}'`
  to catch cross-extension import failures before they accumulate
- Never rename a file without updating all its import sites in the same commit

---

## Related Plans

- [`2026-03-07-github-copilot-cli-integration.md`](./2026-03-07-github-copilot-cli-integration.md) — **Depends on Phases 1–4** of this plan; Task 11 (`resolveCliModelId`) should be written in TS during Phase 3
- [`2026-03-10-dynamic-agent-dispatch.md`](./2026-03-10-dynamic-agent-dispatch.md) — **Depends on Phase 7** of this plan; Task A (dispatch refactor) should be written in TS after Phase 7

---

_Document created: 2026-03-10_
_Status: Draft — pending Phase 0 start_
