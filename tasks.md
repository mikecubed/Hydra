# Hydra quality tasks

## Phase 2 — Coverage push (Complete)

- [x] Convert mid-size `.mjs` test files and `test/helpers/mock-agent.mjs` to `.ts`
- [x] Replace the worktree isolation todo stubs with real assertions
- [x] Add shared infrastructure tests for council, dispatch seam, review-common, and gemini executor
- [x] Add provider request/stream parsing tests for Anthropic, OpenAI, and Google
- [x] Verify blocking coverage gate at `63%` (coverage reached 64%, gate kept at 63%)

## Phase 3 — Next up

- [ ] Convert the large remaining `.mjs` test files to `.ts`
- [ ] Add deeper coverage for operator, status bar, prompt, worker, and evolve modules
- [ ] Raise the blocking coverage gate toward the final `80%` target
