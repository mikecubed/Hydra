# Hydra quality tasks

## Phase 2 — Coverage push (Complete)

- [x] Convert mid-size `.mjs` test files and `test/helpers/mock-agent.mjs` to `.ts`
- [x] Replace the worktree isolation todo stubs with real assertions
- [x] Add shared infrastructure tests for council, dispatch seam, review-common, and gemini executor
- [x] Add provider request/stream parsing tests for Anthropic, OpenAI, and Google
- [x] Verify blocking coverage gate at `63%` (coverage reached 64%, gate kept at 63%)

## Phase 3 — Complete TS migration + coverage push (Complete)

- [x] Convert the 19 remaining `.mjs` test files to `.ts` (8,200+ LOC)
- [x] Add deeper coverage for operator, status bar, prompt, worker, and evolve modules (185+ tests)
- [x] Raise the blocking coverage gate to 65%
- [x] Clean up all stale `.mjs` references in docs, config, and package.json

## Phase 4 — Hardening (Next)

- [ ] Push coverage toward the 80% target (requires deep I/O mocking of large modules)
- [ ] Enable mutation testing as blocking for `lib/daemon/`
- [ ] Add per-file coverage minimums for critical modules
- [ ] Enforce new-file test requirement in CI
