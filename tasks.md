# Hydra quality tasks

## Web Interface — Login Page (Complete)

- [x] T1: `auth-client.ts` — login(), getSessionInfo(), logout() with CSRF double-submit
- [x] T2: `login-form.tsx` — controlled form with ACCOUNT_DISABLED/INVALID_CREDENTIALS/RATE_LIMITED mapping
- [x] T3: `login.tsx` — LoginRoute with session-check on mount and same-origin redirectTo guard
- [x] T4: `router.tsx` — loginRoute + beforeLoad session guard redirecting unauthenticated to /login
- [x] T5: `auth-client.test.ts` — 8 node:test unit tests
- [x] T6: `login-form.browser.spec.tsx` — 9 Vitest browser specs
- [x] T7: README updates replacing browser-console fetch workaround with /login instructions
- PR #210: `feat/web-session-auth-login` → main

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
