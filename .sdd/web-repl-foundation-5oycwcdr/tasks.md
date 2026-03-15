# Tasks: Web REPL Foundation Slice

**Generated**: 2026-03-15 (revised)
**Feature**: `.sdd/web-repl-foundation-5oycwcdr/`
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Legend

| Symbol        | Meaning                                   |
| ------------- | ----------------------------------------- |
| `T###`        | Task ID (sequential across all stories)   |
| `P1`/`P2`     | Priority from spec                        |
| `US#`         | User story reference                      |
| `🔴 RED`      | TDD: write failing test first             |
| `🟢 GREEN`    | TDD: write minimal implementation to pass |
| `🔵 REFACTOR` | TDD: clean up while green                 |
| `📄 DOC`      | Documentation-only task (no TDD gate)     |
| `⚙️ CONFIG`   | Configuration/tooling task (no TDD gate)  |

---

## Phase 1 — Workspace Setup

### US1: Maintainer Identifies Web Boundary (P1)

- [ ] T001 ⚙️ [P1] [US1] Register npm workspaces in root `package.json`
  - Add `"workspaces": ["apps/*", "packages/*"]` to root `package.json`.
  - Do NOT modify any existing fields. This is an additive change.
  - **Verify**: `node -e "console.log(require('./package.json').workspaces)"` prints the array.

- [ ] T002 ⚙️ [P1] [US1] Create `apps/web/` workspace placeholder
  - Create `apps/web/package.json`:
    ```json
    { "name": "@hydra/web", "version": "0.0.0", "private": true, "type": "module" }
    ```
  - Create `apps/web/tsconfig.json` extending the root: `{ "extends": "../../tsconfig.json", "include": ["src"] }`.
  - Create `apps/web/README.md`: brief placeholder stating the React + Vite frontend starts in a later phase; links to `docs/web-interface/07-boundaries-and-governance.md`.
  - **Verify**: `ls apps/web/package.json apps/web/tsconfig.json apps/web/README.md` succeeds.

- [ ] T003 ⚙️ [P1] [US1] Create `apps/web-gateway/` workspace placeholder
  - Create `apps/web-gateway/package.json`:
    ```json
    { "name": "@hydra/web-gateway", "version": "0.0.0", "private": true, "type": "module" }
    ```
  - Create `apps/web-gateway/tsconfig.json` extending the root: `{ "extends": "../../tsconfig.json", "include": ["src"] }`.
  - Create `apps/web-gateway/README.md`: brief placeholder stating the Hono gateway starts in a later phase; links to `docs/web-interface/07-boundaries-and-governance.md`.
  - **Verify**: `ls apps/web-gateway/package.json apps/web-gateway/tsconfig.json apps/web-gateway/README.md` succeeds.

- [ ] T004 ⚙️ [P1] [US1] Create `packages/web-contracts/` workspace package scaffold
  - Create `packages/web-contracts/package.json`:
    ```json
    {
      "name": "@hydra/web-contracts",
      "version": "0.0.0",
      "private": true,
      "type": "module",
      "exports": { ".": "./src/index.ts" },
      "dependencies": { "zod": "*" }
    }
    ```
    The `"zod": "*"` defers to the root workspace version already installed.
  - Create `packages/web-contracts/tsconfig.json` extending the root: `{ "extends": "../../tsconfig.json", "include": ["src"] }`.
  - Create `packages/web-contracts/src/index.ts`: barrel export with a comment indicating contracts and vocabulary will be re-exported here.
  - Create `packages/web-contracts/src/vocabulary.ts`: placeholder file with a comment indicating vocabulary stubs will be implemented in Phase 3.
  - **Verify**: `ls packages/web-contracts/package.json packages/web-contracts/tsconfig.json packages/web-contracts/src/index.ts packages/web-contracts/src/vocabulary.ts` succeeds.

- [ ] T005 ⚙️ [P1] [US1] Run `npm install` to link workspaces and verify resolution
  - Run `npm install` from the repo root.
  - Verify workspaces are linked: `npm ls --workspaces` lists `@hydra/web`, `@hydra/web-gateway`, `@hydra/web-contracts`.
  - Verify `npm run typecheck` passes (no new errors).
  - Verify `npm run lint` passes (no regressions).
  - Verify `npm test` passes (no regressions).
  - **Verify**: all three commands exit 0.

---

## Phase 2 — Boundary Documentation and Quality Gate

### US1 continued + US3: Quality Gate (P1/P2)

- [ ] T006 📄 [P1] [US1] Create the boundary and governance document — `docs/web-interface/07-boundaries-and-governance.md`
  - This document is **subordinate to `docs/WEB_INTERFACE.md`** — it is the 7th doc in the existing numbered web-interface set, not a competing top-level authority.
  - Add an entry for it in `docs/WEB_INTERFACE.md`'s Document Map section (item 7).
  - YAML front matter with structured metadata:
    ```yaml
    workspace_roots: [apps/web, apps/web-gateway, packages/web-contracts]
    ownership:
      apps/web: browser
      apps/web-gateway: gateway
      packages/web-contracts: shared
      lib/: hydra-core
    phases:
      [
        foundation,
        session-auth,
        conversation-protocol,
        chat-workspace,
        operations,
        mutations,
        hardening,
      ]
    governance: cross-boundary-review-required
    ```
  - Ownership table mapping directories to responsible surfaces.
  - Cross-boundary governance rules: any change touching both `apps/`/`packages/` and `lib/` requires explicit justification in the PR description and review by a core maintainer.
  - Ambiguous ownership resolution process: if a change cannot be cleanly classified, the default is "Hydra core."
  - Exception process for emergency boundary violations.
  - Phase roadmap listing known future phases and expected workspace packages.
  - **Verify**: front matter is valid YAML; document renders correctly in Markdown preview; `docs/WEB_INTERFACE.md` links to it.

- [ ] T007 📄 [P1] [US1] Update `docs/ARCHITECTURE.md` to reference the web initiative boundary
  - Add a new section titled "Web Initiative Boundary" that:
    - States `apps/web/`, `apps/web-gateway/`, and `packages/web-contracts/` are the workspace roots for web initiative work.
    - Links to `docs/web-interface/07-boundaries-and-governance.md` as the boundary reference.
    - Notes that ESLint boundary rules enforce import directions between packages.
  - Do NOT reorganize existing content — append only.
  - **Verify**: `docs/ARCHITECTURE.md` still renders; new section is present.

- [ ] T008 📄 [P1] [US1] Update agent instruction files with web boundary references — `CLAUDE.md`, `AGENTS.md`, `COPILOT.md`
  - Each file gets a "Web Initiative" section that:
    - Lists the three workspace roots.
    - States `packages/web-contracts/` holds shared cross-surface contracts.
    - Links to `docs/web-interface/07-boundaries-and-governance.md`.
    - Notes ESLint boundary constraints.
  - **Verify**: each file has the new section; no existing content is removed.

- [ ] T009 📄 [P2] [US3] Write the quality gate specification — `packages/web-contracts/QUALITY.md`
  - Enumerated expectations with unique IDs. Each is classified as **immediately enforced** (⚡) or **required standard** (📋):
    - `QG-001` 📋: **TDD methodology** — all new contracts and modules must follow Red-Green-Refactor. Failing test written and committed before implementation. Enforced by PR review, task ordering, and reviewer attestation. Automated enforcement deferred until test-ordering tooling is added.
    - `QG-002` ⚡/📋: **Test coverage** — all web initiative source files must meet the project-wide 80% line coverage threshold. ⚡ Immediately enforced by c8 once packages contain measurable source files; 📋 vacuously satisfied in foundation (no runtime code yet).
    - `QG-003` 📋: **Test presence** — every `.ts` source file in web initiative packages must have a corresponding `.test.ts` file. Verified by reviewer attestation; automated enforcement added when a test-presence linter is wired.
    - `QG-004` 📋: **Contract conformance** — any cross-surface data must be validated against a published shared contract schema. No ad-hoc type assertions at surface boundaries. Enforced by reviewer attestation and conformance test presence.
    - `QG-005` ⚡: **Lint compliance** — all web initiative code must pass `npm run lint` with zero errors and zero warnings. Immediately enforced once T011 wires packages into ESLint.
    - `QG-006` ⚡: **Type safety** — all web initiative code must pass `npm run typecheck` with zero errors. Immediately enforced once T012 confirms typecheck coverage.
    - `QG-007` 📋: **Documentation** — new modules must include a top-of-file JSDoc summary; new contracts must be registered in `packages/web-contracts/CONTRACTS.md`. Verified by reviewer attestation.
    - `QG-008` ⚡: **Audit trail** — all changes must arrive via PR (never direct push to `main`); conventional commit messages required. Enforced by branch protection rules.
    - `QG-009` ⚡: **Architectural boundary** — `apps/web` and `apps/web-gateway` may import from `packages/web-contracts` but not from `lib/` directly. `apps/web` may not import from `apps/web-gateway` or vice versa. Immediately enforced by ESLint once T011 is applied. **Note**: per `docs/web-interface/02-stack-and-monorepo.md`, the gateway boundary will be extended to allow daemon-facing public API imports when that API surface is formalized; `web-app` will be extended to allow future `packages/*` siblings (e.g., `packages/web-ui`).
  - Each expectation includes: binary criterion, enforcement mechanism, enforcement classification (⚡ or 📋), and how to check locally.
  - Reference `docs/web-interface/05-security-and-quality.md` as the authoritative quality standards source.
  - **Verify**: document renders correctly; all expectations are binary and measurable; enforcement classification is explicit.

- [ ] T010 📄 [P1] [US2] Create the contract index document — `packages/web-contracts/CONTRACTS.md`
  - Write `CONTRACTS.md` with:
    - Purpose statement: single source of truth for cross-surface contract lifecycle.
    - Table columns: Name, Version, Status (draft/stable/deprecated/removed), Consumers, File.
    - Initial state: table is empty — no domain contracts in foundation. Include a commented example row.
    - Versioning rules: new version = new file; old file remains until all consumers migrate.
    - Lifecycle state transitions: `draft → stable → deprecated → removed`.
    - Governance: breaking changes require a new version file.
  - **Verify**: file exists and renders correctly.

- [ ] T011a 🔴 RED [P1] [US1] Write failing test for ESLint boundary enforcement — `test/web-contracts/eslint-boundary.test.ts`
  - Write a test (using `node:test`) that programmatically verifies the ESLint config structure:
    - Assert that boundary elements for `web-app`, `web-gateway`, and `web-contracts` exist.
    - Assert that `from: 'web-app'` only allows `['web-contracts']`.
    - Assert that `from: 'web-gateway'` only allows `['web-contracts']`.
    - Assert that `from: 'web-contracts'` allows `[]` (no deps on other elements).
  - **Verify**: `node --test test/web-contracts/eslint-boundary.test.ts` fails (boundary elements not yet in ESLint config). Expected RED state.

- [ ] T011b 🟢 GREEN [P1] [US1] Add web-initiative boundary elements to ESLint configuration — `eslint.config.mjs`
  - Add boundary elements for:
    - `{ type: 'web-app', pattern: 'apps/web/**' }`
    - `{ type: 'web-gateway', pattern: 'apps/web-gateway/**' }`
    - `{ type: 'web-contracts', pattern: 'packages/web-contracts/**' }`
  - Add import direction rules:
    - `{ from: 'web-app', allow: ['web-contracts'] }` — browser may import from shared contracts (will be extended to allow `packages/web-ui` when that package is created)
    - `{ from: 'web-gateway', allow: ['web-contracts'] }` — gateway may import from shared contracts (will be extended to allow daemon public API imports per `docs/web-interface/02-stack-and-monorepo.md` when that API surface is formalized)
    - `{ from: 'web-contracts', allow: [] }` — contracts package has no internal dependencies (only Zod)
  - Update `test` rule to include the new element types in its allow list.
  - **Verify**: `node --test test/web-contracts/eslint-boundary.test.ts` passes (GREEN); `npm run lint` passes (no regressions); `npm run quality` passes.
  - Additionally: create a temporary file in `apps/web/src/test-boundary.ts` that tries to import from `../../lib/hydra-config.ts` and confirm `npm run lint` catches it. Clean up the temporary file.

- [ ] T012 ⚙️ [P1] [US1] Verify TypeScript compilation covers web workspace packages
  - Verify or update root `tsconfig.json` so `apps/**/*.ts` and `packages/**/*.ts` are included in type-check scope, OR confirm that each workspace's own `tsconfig.json` is picked up by `npm run typecheck`.
  - If the root `npm run typecheck` only checks the root tsconfig, add workspace-aware type-check scripts.
  - **Note**: until this task is confirmed green, T023 cannot claim root typecheck coverage of web packages.
  - **Verify**: `npm run typecheck` passes; creating a deliberate type error in `packages/web-contracts/src/index.ts` is caught by `npm run typecheck` (not just by the workspace's own tsconfig).

---

## Phase 3 — Contract Infrastructure and Vocabulary (TDD)

### US2: Contributor Uses Shared Contracts (P1)

- [ ] T013 🔴 RED [P1] [US2] Write failing tests for contract validation helpers — `test/web-contracts/contract-helpers.test.ts`
  - Create `test/web-contracts/` directory.
  - Write tests using `node:test` + `node:assert/strict` that import `assertContractValid` and `assertContractInvalid` from `./contract-helpers.ts` (this file does not exist yet — tests MUST fail).
  - Test cases (minimum):
    - `assertContractValid` with good data returns parsed result.
    - `assertContractValid` with bad data throws an AssertionError (not a Zod error — it should wrap).
    - `assertContractInvalid` with bad data passes (assertion holds).
    - `assertContractInvalid` with good data throws an AssertionError.
    - `assertContractInvalid` with `expectedField` checks that the Zod error path includes that field name.
  - Use a trivial inline Zod schema within the test file (e.g., `z.object({ name: z.string() })`) — NOT a domain-specific contract.
  - **Verify**: `node --test test/web-contracts/contract-helpers.test.ts` fails (import not found). Expected RED state.

- [ ] T014 🟢 GREEN [P1] [US2] Implement contract validation helpers — `test/web-contracts/contract-helpers.ts`
  - Implement `assertContractValid(schema, data)` and `assertContractInvalid(schema, data, expectedField?)`.
  - Use Zod's `.safeParse()` internally to produce structured error details.
  - These helpers are schema-agnostic — they work with ANY Zod schema, not just web contracts.
  - Export both functions for use by all contract conformance test files.
  - **Verify**: `node --test test/web-contracts/contract-helpers.test.ts` passes (GREEN).

- [ ] T015 🔵 REFACTOR [P1] [US2] Review and refine contract helpers
  - Ensure all test descriptions are clear and follow existing test naming patterns in the repo.
  - Ensure JSDoc comments on exported helper functions match the project's documentation standards.
  - Verify that the helpers are truly schema-agnostic — no domain-specific logic.
  - Run full quality gate: `npm run quality && npm test`.
  - **Verify**: all checks green; code is clean.

### US2 continued: Shared Vocabulary (P1)

- [ ] T015a 🔴 RED [P1] [US2] Write failing tests for vocabulary type stubs — `test/web-contracts/vocabulary.test.ts`
  - Write tests using `node:test` + `node:assert/strict` that import vocabulary stubs from `@hydra/web-contracts` or directly from `packages/web-contracts/src/vocabulary.ts`.
  - Test cases (minimum):
    - Each of the six core protocol object schemas (`Conversation`, `Turn`, `StreamEvent`, `ApprovalRequest`, `Artifact`, `SessionSnapshot`) can parse a minimal object with the correct `kind` discriminator.
    - Each rejects an object with a wrong or missing `kind`.
    - The contract families registry exports an array of five entries, each with `name`, `purpose`, and `status`.
    - All contract family statuses are `'planned'`.
  - Use `assertContractValid`/`assertContractInvalid` helpers from T014 where applicable.
  - **Verify**: `node --test test/web-contracts/vocabulary.test.ts` fails (vocabulary stubs not yet implemented). Expected RED state.

- [ ] T015b 🟢 GREEN [P1] [US2] Implement vocabulary type stubs — `packages/web-contracts/src/vocabulary.ts`
  - Define Zod schemas for the six core protocol objects per `docs/web-interface/04-protocol.md`:
    - `ConversationStub` — `{ kind: 'conversation' }` (minimal identity only)
    - `TurnStub` — `{ kind: 'turn' }`
    - `StreamEventStub` — `{ kind: 'stream-event' }`
    - `ApprovalRequestStub` — `{ kind: 'approval-request' }`
    - `ArtifactStub` — `{ kind: 'artifact' }`
    - `SessionSnapshotStub` — `{ kind: 'session-snapshot' }`
  - Each stub uses a `kind` literal discriminator and exports both the Zod schema and inferred TypeScript type.
  - Define a `CONTRACT_FAMILIES` constant array naming the five first daemon contract families per `docs/web-interface/06-phases-and-sdd.md` Phase 0 (full names from `04-protocol.md`):
    - `{ name: 'conversation-messaging', purpose: 'Create, open, resume conversations; submit turns; stream events', status: 'planned' }`
    - `{ name: 'command-catalog-and-execution', purpose: 'Discover and execute Hydra commands through typed contracts', status: 'planned' }`
    - `{ name: 'council-and-multi-agent-eventing', purpose: 'Structured events for multi-agent phase transitions, votes, reasoning', status: 'planned' }`
    - `{ name: 'task-live-output', purpose: 'Stream task progress, checkpoints, and live output', status: 'planned' }`
    - `{ name: 'config-and-controlled-mutations', purpose: 'Read masked config; write allowlisted settings through audited endpoints', status: 'planned' }`
  - **Scope boundary**: stubs define names and minimal identity only. Full field-level schemas are deferred to later specs.
  - **Verify**: `node --test test/web-contracts/vocabulary.test.ts` passes (GREEN).

- [ ] T015c 🔵 REFACTOR [P1] [US2] Wire vocabulary into barrel export and contract index
  - Update `packages/web-contracts/src/index.ts` to re-export all vocabulary stubs and the `CONTRACT_FAMILIES` constant.
  - Update `packages/web-contracts/CONTRACTS.md` to list vocabulary as a `draft` entry.
  - Verify imports resolve from `@hydra/web-contracts`.
  - Run full quality gate: `npm run quality && npm test`.
  - **Verify**: all checks green; vocabulary is importable from the package entry point.

---

## Phase 4 — Extensibility Validation

### US4: Later Phase Builds Safely on Foundation (P2)

- [ ] T016 🔴 RED [P2] [US4] Write failing extensibility test — simulated contract addition — `test/web-contracts/extensibility-add-contract.test.ts`
  - Write a test that:
    - Creates an inline mock contract schema (e.g., `z.object({ type: z.literal('notification'), payload: z.string() })`).
    - Validates it through the `assertContractValid`/`assertContractInvalid` helpers from T014.
    - Asserts that the barrel export in `packages/web-contracts/src/index.ts` can accept new re-export lines without modifying existing lines (verify by parsing the file or importing from it).
  - The test proves the mechanism works: a later phase can add a contract file, append a re-export line, and write conformance tests using existing helpers — with zero changes to foundation structural artifacts.
  - **Verify**: test fails initially if helpers are not yet available. Expected RED state if run before T014.

- [ ] T017 🟢 GREEN [P2] [US4] Make extensibility test pass — verify zero-structural-modification extension
  - Ensure T016's test passes by confirming:
    - The `contract-helpers.ts` utilities work with any Zod schema (not just the helpers' own test schema).
    - Adding a new contract schema + re-exporting it is purely additive (append-only to barrel and index).
  - Do NOT actually commit a domain contract — this is a simulation test only.
  - **Verify**: `node --test test/web-contracts/extensibility-add-contract.test.ts` passes (GREEN).

- [ ] T018 🔴 RED [P2] [US4] Write failing extensibility test — simulated workspace package addition — `test/web-contracts/extensibility-add-workspace.test.ts`
  - Write a test that:
    - Verifies the root `package.json` workspaces glob (`apps/*`, `packages/*`) would cover a new package (e.g., `packages/web-ui/`) without modifying the glob pattern.
    - Verifies that ESLint boundary element patterns for `packages/web-contracts/**` do not interfere with a sibling package at `packages/web-ui/**`.
    - Verifies that a new workspace package's `tsconfig.json` can extend the root without root tsconfig modification.
  - Implementation: parse `package.json`, ESLint config, and root tsconfig programmatically to assert the patterns.
  - **Verify**: test fails initially if workspace config is not yet in place. Expected RED if T001/T005 not yet done.

- [ ] T019 🟢 GREEN [P2] [US4] Make workspace extensibility test pass
  - Ensure T001 (workspaces array) and T005 (npm install) are complete.
  - Run T018's test — it should pass, confirming that new packages under `apps/` or `packages/` are automatically covered by workspaces globs and do not require foundation structural modifications.
  - **Verify**: `node --test test/web-contracts/extensibility-add-workspace.test.ts` passes (GREEN).

- [ ] T020 📄 [P2] [US4] Document the extension process in `docs/web-interface/07-boundaries-and-governance.md`
  - Add a section titled "Extending the Foundation" to `docs/web-interface/07-boundaries-and-governance.md` that describes:
    - How to add a new shared contract (create file in `packages/web-contracts/src/`, update `CONTRACTS.md`, add barrel re-export, write conformance tests using helpers from `test/web-contracts/`).
    - How to add a new workspace package (create directory under `apps/` or `packages/`, add `package.json` + `tsconfig.json`, run `npm install`; the workspaces glob covers it automatically).
    - How to add a new quality rule (add ESLint rule entry — existing rules never weakened).
    - How to extend a boundary rule (e.g., adding `packages/web-ui` to `web-app`'s allow list, or adding daemon public API access to `web-gateway`'s allow list).
  - Clarify which artifacts are append-only registries (barrel exports, contract index) vs structural artifacts (boundary doc, quality gate, workspace config) that should not need changes.
  - Reference the extensibility tests (T016–T019) as proof that these processes work.
  - **Verify**: document section is complete and actionable.

---

## Phase 5 — Final Validation & Cleanup

- [ ] T023 ⚙️ [P1] [US1,US2,US3,US4] Run full regression suite — verify zero disruption to existing Hydra core
  - Run the complete quality and test pipeline:
    ```bash
    npm run quality   # lint + format:check + typecheck + cycle detection
    npm test          # all tests (existing + new contract/extensibility/vocabulary tests)
    ```
  - Confirm zero new lint errors, zero new type errors, zero test regressions.
  - Confirm all new tests pass (contract helpers, vocabulary, extensibility, ESLint boundary).
  - Confirm no existing files in `lib/`, `bin/`, `scripts/` were modified.
  - **Coverage note**: `npm run test:coverage:check` is expected to pass because the foundation adds minimal source code (vocabulary stubs + test helpers). If coverage thresholds are affected by new packages with low file counts, verify the c8 inclusion patterns are correctly scoped. Do NOT claim coverage gate enforcement on web packages until verified.
  - **Verify**: all three commands exit 0; `git diff --stat` shows only expected changes.

- [ ] T024 📄 [P1] [US1,US2] Final review of all new documentation for consistency
  - Cross-check that:
    - `docs/web-interface/07-boundaries-and-governance.md` lists all three workspace roots and links to `packages/web-contracts/CONTRACTS.md`.
    - `docs/WEB_INTERFACE.md` document map includes item 7 linking to `07-boundaries-and-governance.md`.
    - `packages/web-contracts/CONTRACTS.md` reflects vocabulary stubs and contract family registry.
    - `packages/web-contracts/QUALITY.md` expectations match actual enforcement mechanisms; each gate is correctly classified as ⚡ or 📋.
    - `CLAUDE.md`, `AGENTS.md`, `COPILOT.md` all reference the same workspace roots and contract package.
    - `docs/ARCHITECTURE.md` references the web initiative boundary consistently.
    - All README.md files in `apps/web/`, `apps/web-gateway/` link to `docs/web-interface/07-boundaries-and-governance.md`.
    - ESLint boundary rules are forward-compatible with documented future extensions (gateway→daemon APIs, `web-app`→`packages/web-ui`).
  - **Verify**: all cross-references are accurate; no broken links; no contradictions with the authoritative web doc set.

---

## Summary

| Metric                       | Count                                       |
| ---------------------------- | ------------------------------------------- |
| **Total tasks**              | 28                                          |
| **P1 tasks**                 | 20                                          |
| **P2 tasks**                 | 8                                           |
| **US1 tasks**                | 11 (T001–T008, T011a–T012, T023–T024)       |
| **US2 tasks**                | 8 (T010, T013–T015, T015a–T015c, T023–T024) |
| **US3 tasks**                | 2 (T009, T023)                              |
| **US4 tasks**                | 5 (T016–T020)                               |
| **TDD tasks (🔴🟢🔵)**       | 13                                          |
| **Doc tasks (📄)**           | 7                                           |
| **Config tasks (⚙️)**        | 6                                           |
| **Estimated files created**  | ~21                                         |
| **Estimated files modified** | ~8                                          |

### Dependency Graph

```
T001 ──┐
T002 ──┤
T003 ──┼── Phase 1 (Workspace Setup) ── T002–T004 independent, T001 before T005
T004 ──┤
       ▼
T005 ──── (npm install + verify) ── depends on T001–T004
       │
       ▼
T006 ──┐
T007 ──┤
T008 ──┤
T009 ──┼── Phase 2 (Boundary Docs + Quality Gate) ── mostly independent of each other
T010 ──┤
T011a ─┤── 🔴 RED: ESLint boundary test (depends on T005)
T011b ─┤── 🟢 GREEN: ESLint boundary config (depends on T011a)
T012 ──┘
       │
       ▼
T013 ──── Phase 3a (RED: contract helper tests) ── depends on T005
       │
       ▼
T014 ──── Phase 3b (GREEN: contract helpers)
       │
       ▼
T015 ──── Phase 3c (REFACTOR)
       │
       ▼
T015a ─── Phase 3d (RED: vocabulary tests) ── depends on T014
       │
       ▼
T015b ─── Phase 3e (GREEN: vocabulary stubs)
       │
       ▼
T015c ─── Phase 3f (REFACTOR: wire vocabulary into barrel + index)
       │
       ▼
T016 ──┬── Phase 4a (RED: contract extensibility) ── depends on T014
T017 ──┘
       │
T018 ──┬── Phase 4b (RED: workspace extensibility) ── depends on T001, T005
T019 ──┘
       │
T020 ──── Phase 4c (extension docs) ── depends on T017, T019
       │
       ▼
T023 ──── Phase 5a (full regression)
T024 ──── Phase 5b (doc review)
```

### Suggested MVP Scope

**MVP = Phase 1 + Phase 2 + Phase 3 (T001–T015c)**: 19 tasks delivering the workspace scaffold, boundary documentation, quality gate, contract test infrastructure, and shared vocabulary stubs. This satisfies both P1 user stories (US1 + US2) and the P2 quality gate story (US3), all P1 functional requirements (FR-001 through FR-006, FR-008), and 5 of 6 success criteria (SC-001, SC-002, SC-003, SC-005, SC-006). ESLint boundary tests (T011a-T011b) now lead config in proper RED→GREEN order. Phase 4–5 (extensibility validation + final cleanup) can follow immediately or in a subsequent PR.
