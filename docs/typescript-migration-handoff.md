# Hydra — TypeScript Migration Handoff

## Summary

Convert Hydra from plain JavaScript (`.mjs`) to TypeScript (`.ts`). The project already runs `tsc --checkJs` with strict mode and has 991+ JSDoc annotations, so this is largely a mechanical conversion with a few hard design decisions upfront.

**Who does the work:** Coding agents (Claude, Codex, Gemini via Hydra itself)  
**Current version:** 1.2.0  
**Node.js runtime:** v22.18.0 (supports `--experimental-strip-types`)  
**Codebase size:** 138 `.mjs` files, ~51K source lines + 44 test files (~11K lines)

---

## Key Decision (Make This First)

**How to handle the build step?**

| Option                               | Dev experience              | CI                  | Recommendation                     |
| ------------------------------------ | --------------------------- | ------------------- | ---------------------------------- |
| `tsx` for dev, `tsc` for CI/dist     | No build step in dev        | Compile before test | ✅ Best balance                    |
| Node 22 `--experimental-strip-types` | No build step anywhere      | Same                | ✅ Also good, flag is experimental |
| Pure `tsc` compile step              | Must compile before running | Standard            | Works, loses "runs directly" feel  |

The project's `no-build-step` philosophy is a stated design principle. Recommend **`tsx` + `tsc` for CI** to preserve it.

---

## Pre-Migration Setup (Do Once, by Hand or Agent)

1. `npm install --save-dev tsx` — for running `.ts` directly in dev
2. Create `tsconfig.json` (replace `jsconfig.json`):
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "strict": true,
       "noEmit": true,
       "allowImportingTsExtensions": true,
       "checkJs": false
     },
     "include": ["lib/**/*", "bin/**/*", "scripts/**/*", "test/**/*"]
   }
   ```
3. Update `package.json` scripts:
   - `"typecheck": "tsc --noEmit"` (already exists, just targets tsconfig.json now)
   - `"test": "node --import tsx/esm --test 'test/**/*.test.ts'"` (or keep `.mjs` for tests initially)
4. Update `eslint.config.mjs` to handle `.ts` files (add `@typescript-eslint` parser)
5. Update CI (`quality.yml`) to run `tsc` compile check

---

## Migration Strategy

**Do NOT convert everything at once.** File-by-file, PR-by-PR. Run `npm test` + `npm run quality` after each batch.

### Phase 1 — Shared Types (Start Here)

Create `lib/types.ts` with core interfaces. No logic, just types.
These are the highest-value types to define first:

```typescript
// Key types to define
interface AgentDef { ... }         // from hydra-agents.mjs
interface HydraConfig { ... }      // from hydra-config.mjs
interface TaskState { ... }        // from orchestrator-daemon.mjs
interface SessionState { ... }     // from orchestrator-daemon.mjs
interface RoutingDecision { ... }  // from hydra-dispatch.mjs
interface AgentResult { ... }      // from agent-executor.mjs
```

### Phase 2 — Pure Utilities (Mechanical, Low Risk)

Convert in any order — no circular deps, simple types:

- `lib/hydra-env.mjs`
- `lib/hydra-cache.mjs`
- `lib/hydra-utils.mjs`
- `lib/hydra-rate-limits.mjs`
- `lib/hydra-metrics.mjs`
- `lib/hydra-telemetry.mjs`

### Phase 3 — Config & Models (Medium)

- `lib/hydra-config.mjs` — expose `HydraConfig` type properly
- `lib/hydra-models.mjs`
- `lib/hydra-model-profiles.mjs`

### Phase 4 — Agent System (Hard — needs care)

- `lib/hydra-agents.mjs` — plugin registry has dynamic fields, needs careful generics
- `lib/hydra-shared/agent-executor.mjs` — subprocess piping, streaming
- `lib/hydra-agents-wizard.mjs`
- `lib/hydra-agent-forge.mjs`

### Phase 5 — Daemon & Routes (Medium-Hard)

- `lib/orchestrator-daemon.mjs`
- `lib/daemon/read-routes.mjs`
- `lib/daemon/write-routes.mjs`
- `lib/orchestrator-client.mjs`

### Phase 6 — Operator & Council (Large files)

- `lib/hydra-dispatch.mjs`
- `lib/hydra-council.mjs`
- `lib/hydra-operator.mjs` (6,400 lines — save for last)

### Phase 7 — Everything Else

- Remaining `lib/` files
- `bin/` entry points
- `scripts/`

### Phase 8 — Tests

Convert test files last. They serve as a regression net during the migration.

---

## Known Hard Spots (Flag for Human Review)

| File                                  | Why It's Hard                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `lib/hydra-agents.mjs`                | Dynamic plugin registry — `registerAgent()` applies defaults; typing `AgentDef` generics correctly without overusing `unknown` |
| `lib/hydra-config.mjs`                | Config merging with deep partial overrides — `_setTestConfig()` and `invalidateConfigCache()` are tricky                       |
| `lib/hydra-shared/agent-executor.mjs` | Subprocess stdio types, streaming chunks, per-agent parse callbacks                                                            |
| `lib/hydra-operator.mjs`              | 6,400 lines of mixed concerns — type narrowing on the command dispatch switch will be verbose                                  |
| `lib/hydra-council.mjs`               | Multi-round deliberation with dynamic agent results accumulation                                                               |

---

## Import Path Convention

TypeScript with `NodeNext` module resolution requires explicit extensions on imports. When converting a file, all imports must use `.js` extension (not `.ts`) per NodeNext rules:

```typescript
// CORRECT
import { loadHydraConfig } from './hydra-config.js';

// WRONG
import { loadHydraConfig } from './hydra-config.ts';
import { loadHydraConfig } from './hydra-config';
```

Agents doing the conversion need this instruction explicitly.

---

## Agent Instructions for Each File Conversion

When tasking an agent to convert a file, use this prompt template:

```
Convert lib/[filename].mjs to TypeScript.

Rules:
1. Rename to lib/[filename].ts
2. Convert JSDoc @param/@returns to inline TypeScript types
3. Import types from lib/types.ts where they exist
4. All imports must use .js extension (NodeNext resolution)
5. No `any` types — use `unknown` if truly unknown, then narrow
6. Prefer explicit return types on all exported functions
7. Run `npm run typecheck` and `npm test` after — fix all errors before finishing
8. Do NOT change any logic — type annotations only
```

---

## Files That Stay as `.mjs`

- `.husky/` hooks — shell scripts, not JS
- `eslint.config.mjs` — ESLint requires `.mjs` for flat config
- Any file that is explicitly excluded from TS compilation

---

## Success Criteria

- [ ] `npm run typecheck` passes with zero errors (currently `continue-on-error`)
- [ ] `npm test` passes (all 395 test cases green)
- [ ] `npm run quality` passes (lint + format + typecheck)
- [ ] No `any` types in exported APIs (internal `any` allowed temporarily)
- [ ] CI `quality.yml` typecheck step changed from `continue-on-error: true` to blocking

---

## Notes

- The project already has `typescript` and `@types/node` in devDependencies — no new deps needed except `tsx`
- `zod` (already a prod dep) can replace many manual type guards if desired
- MCP SDK (`@modelcontextprotocol/sdk`) ships full TypeScript types — direct win
- `picocolors` and `cross-spawn` both have `@types` available if needed
- Windows PowerShell launchers in `bin/*.ps1` are unaffected
