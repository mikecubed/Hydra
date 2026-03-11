# Tasks: Agent Plugin Interface

**Input**: `.sdd/agent-plugin-refactor-01qmp6rq/` — spec.md + plan.md
**Tech stack**: Node.js ESM, `node:test` + `node:assert/strict`, no build step

---

## Format key

- `[P]` = parallelizable (independent file / non-overlapping section)
- `[US1]`–`[US4]` = user story ownership
- Tasks within the same file are sequential unless noted otherwise

---

## Phase 1 — PR #1: Extend agent definitions + `registerAgent()` defaults

**File**: `lib/hydra-agents.mjs` only
**Risk**: Low — additive, no behavior changes
**Constraint**: All of Phase 1 must pass the full test suite before PR #2 begins

### Agent definition fields (T001–T004 are parallelizable — non-overlapping sections of the same file)

- [ ] T001 [P] [US1] [US2] Add plugin fields to `claude` entry in `PHYSICAL_AGENTS` in `lib/hydra-agents.mjs`: `features`, `parseOutput` (JSON extraction + cache token fields), `errorPatterns`, `modelBelongsTo`, `quotaVerify` (Anthropic endpoint, 402/529 → quota), `economyModel`, `readInstructions`, `taskRules` — per plan §Phase 1a
- [ ] T002 [P] [US1] [US2] Add plugin fields to `gemini` entry in `PHYSICAL_AGENTS` in `lib/hydra-agents.mjs`: `features` (stdinPrompt:false), `parseOutput` (response/text field), `errorPatterns`, `modelBelongsTo`, `quotaVerify` (Google endpoint, 429 + QUOTA_EXHAUSTED), `economyModel`, `readInstructions`, `taskRules` — per plan §Phase 1a
- [ ] T003 [P] [US1] [US2] Add plugin fields to `codex` entry in `PHYSICAL_AGENTS` in `lib/hydra-agents.mjs`: `features` (jsonOutput:true, stdinPrompt:true, reasoningEffort:true), `parseOutput` (JSONL accumulation across lines), `errorPatterns`, `modelBelongsTo` (gpt-/o1/o3/o4/o5/codex prefixes), `quotaVerify` (OpenAI endpoint + ChatGPT hintText guard), `economyModel` (handoffModel fallback), `readInstructions`, `taskRules` — per plan §Phase 1a
- [ ] T004 [P] [US1] [US4] Add plugin fields to `local` entry in `PHYSICAL_AGENTS` in `lib/hydra-agents.mjs`: `features` (executeMode:'api', all others false), `parseOutput` (passthrough), `errorPatterns` (networkError only), `modelBelongsTo` (always true), `quotaVerify` (null), `economyModel` (null), `readInstructions`, `taskRules:[]` — per plan §Phase 1a

### Registry default application (depends on T001–T004 being defined)

- [ ] T005 [US1] [US4] Update `registerAgent()` in `lib/hydra-agents.mjs` to apply plugin interface defaults before `_registry.set()`: spread `def.features` over base defaults; apply `??` fallbacks for all 7 method/field fields; derive `executeMode` default from `def.customType === 'api'` — per plan §Phase 1b

### Phase 1 verification

- [ ] T006 [US3] Run `npm test` — verify all existing tests pass unchanged; no behavior regressions from additive changes in `lib/hydra-agents.mjs`

**✅ Phase 1 checkpoint — PR #1 ready to merge**

---

## Phase 2+3+4 — PR #2: Executor + call-sites + tests (atomic, must ship together)

**Constraint**: T007–T019 must all land in a single PR. Splitting Phase 2 and Phase 3 breaks Claude token tracking (see plan §Phase 2+3 atomicity).

### Phase 2 — Executor refactor (`lib/hydra-shared/agent-executor.mjs`)

_T007 → T008 → T009 are sequential — all edits to the same file_

- [ ] T007 [US1] [US3] Add module-scope Gemini sentinel patch in `lib/hydra-shared/agent-executor.mjs`: after imports, overwrite `getAgent('gemini').invoke.headless` to return `['__gemini_direct__', {prompt, opts}]`; add sentinel check after `invoke.headless()` call to dispatch to `executeGeminiDirect()` — per plan §2a. Removes last hardcoded `'gemini'` name check from routing block.
- [ ] T008 [US1] [US3] Replace `if (agent === 'codex') / else claude` arg-building block in `lib/hydra-shared/agent-executor.mjs` with `agentDef.invoke.headless(prompt, { model: getCopilotCliModelId?(effectiveCliModelId), permissionMode, jsonOutput: agentDef.features.jsonOutput, reasoningEffort: agentDef.features.reasoningEffort ? ... : undefined, cwd })` — per plan §2b
- [ ] T009 [US1] [US3] Replace `if (agent === 'codex') { extractCodexText/extractCodexUsage }` output parsing block in `lib/hydra-shared/agent-executor.mjs` with `agentDef.parseOutput(rawOutput, { jsonOutput: agentDef.features.jsonOutput })` — embed `output`, `tokenUsage`, `costUsd` into result — per plan §2c

### Phase 3 — Call-site cleanup (T010–T017 are parallelizable — all different files, all depend on T007–T009 landing in the same PR)

- [ ] T010 [P] [US1] [US3] Delete the `if (!realTokens && meta.agent === 'claude') { ... }` and `if (!realTokens && meta.agent === 'codex') { ... }` per-agent stdout parsing blocks from `lib/hydra-metrics.mjs` (~lines 144–184); the `if (result?.tokenUsage)` caller-supplied path is now sufficient — per plan §3a
- [ ] T011 [P] [US1] [US2] Replace `modelBelongsToAgent()` body in `lib/hydra-usage.mjs` with `return getAgent(agent)?.modelBelongsTo(modelId) ?? false` — per plan §3b
- [ ] T012 [P] [US1] [US2] Replace 3-way economy model ternary at `lib/hydra-actualize.mjs` lines 384–392 with `getAgent(agent)?.economyModel(budgetCfg) ?? undefined` — per plan §3c
- [ ] T013 [P] [US1] [US2] Replace `readInstructions` ternary (lines 374–378) and per-agent taskRules string literals (lines 392–394) in `lib/orchestrator-daemon.mjs` with `getAgent(agent)?.readInstructions(instructionFile)` and `...(getAgent(agent)?.taskRules ?? [])` — per plan §3d
- [ ] T014 [P] [US1] [US2] Replace the three `if (agent === 'codex')` / `if (agent === 'claude')` / `if (agent === 'gemini')` quota verification blocks in `lib/hydra-model-recovery.mjs` (lines 365–428) with a single `agentDef?.quotaVerify(apiKey, { hintText })` call; resolve `apiKey` from env before the call — per plan §3e
- [ ] T015 [P] [US1] [US2] Replace per-agent prompt addenda ternaries in `lib/hydra-operator.mjs::buildAgentMessage()` (lines 541–544) with `...(getAgent(agent)?.taskRules ?? [])` — **⚠ wording changes for codex**: "You will receive precise task specs..." → "- Do not redesign..." — per plan §3f
- [ ] T016 [P] [US1] [US2] Replace `if (agent === 'codex') { detectCodexError... }` guard in `lib/hydra-evolve.mjs` (lines 469–494) with `if (agentDef?.features?.jsonOutput) { ... }` — generalizes startup-failure detection to all JSONL-output agents — per plan §3g
- [ ] T017 [P] [US1] [US2] Replace `getAgentCommand()` switch in `lib/hydra-audit.mjs` (lines 443–459): use `agentDef.invoke.nonInteractive(prompt, {})` for base command; use `agentDef.economyModel()` for economy model; keep `--model` vs `-m` flag-format conditional (documented as CLI formatting only, not agent logic) — per plan §3h

### Phase 4 — Tests (parallelizable with T010–T017)

- [ ] T018 [P] [US1] [US3] [US4] Create `test/hydra-agents-plugin.test.mjs` with full suite from plan §Phase 4: plugin interface shape for all 4 physical agents; `registerAgent()` default-filling for minimal definition; `claude.parseOutput()` JSON extraction + cache token fields + fallback to raw; `codex.parseOutput()` JSONL accumulation + mixed lines + non-JSON fallback; executor routing guard (local: executeMode=api, invoke.headless=null); custom api-type agent gets executeMode=api default — use fixtures verbatim from `docs/plans/2026-03-08-agent-plugin-refactor.md` lines 551–663

### Phase 2+3+4 verification

- [ ] T019 [US3] Run `npm test` — verify all existing tests pass; verify `test/hydra-agents-plugin.test.mjs` passes; confirm zero hardcoded agent-name string checks remain in the 8 refactored files (SC-001: grep for `agent === 'claude'`, `agent === 'codex'`, `agent === 'gemini'` in each file)

**✅ Phase 2+3+4 checkpoint — PR #2 ready to merge**

---

## Dependencies & Execution Order

```
T001 ─┐
T002 ─┤
T003 ─┤→ T005 → T006 ══════════════════════════════════════════╗
T004 ─┘                                                         ║
                                                         (PR #1 merged)
                                                                ║
                                              ╔═════════════════╝
                                              ║
T007 → T008 → T009 ─────────────────────┐    ║
                    T010 ─┐              │    ║
                    T011 ─┤              │    ║
                    T012 ─┤              ├→ T019
                    T013 ─┤              │
                    T014 ─┤              │
                    T015 ─┤              │
                    T016 ─┤              │
                    T017 ─┤              │
                    T018 ─┘              │
```

### Parallel execution examples

**PR #1 — can run T001–T004 simultaneously:**

```
Worker A: T001 (claude fields)
Worker B: T002 (gemini fields)
Worker C: T003 (codex fields)
Worker D: T004 (local fields)
All done → T005 (registerAgent defaults) → T006 (test run)
```

**PR #2 — T007–T009 are sequential, then T010–T018 all parallel:**

```
T007 → T008 → T009 complete
Then simultaneously:
Worker A: T010 (metrics)      Worker E: T014 (model-recovery)
Worker B: T011 (usage)        Worker F: T015 (operator)
Worker C: T012 (actualize)    Worker G: T016 (evolve)
Worker D: T013 (orchestrator) Worker H: T017 (audit)
Worker I: T018 (test file)
All done → T019 (full test run + grep verification)
```

---

## Summary

| Phase                       | Tasks        | PR        | Parallelizable        | User Stories       |
| --------------------------- | ------------ | --------- | --------------------- | ------------------ |
| Phase 1 — Agent definitions | T001–T006    | PR #1     | T001–T004             | US1, US2, US3, US4 |
| Phase 2 — Executor          | T007–T009    | PR #2     | None (same file)      | US1, US3           |
| Phase 3 — Call-sites        | T010–T017    | PR #2     | All 8 [P]             | US1, US2           |
| Phase 4 — Tests             | T018–T019    | PR #2     | T018 [P]              | US1, US3, US4      |
| **Total**                   | **19 tasks** | **2 PRs** | **12 parallelizable** |                    |

**Suggested MVP scope**: US1 (new agent requires no executor changes) is delivered by completing **all phases** — there is no partial MVP since the executor + call-sites must ship atomically. PR #1 is a safe, testable intermediate state. PR #2 completes the feature.
