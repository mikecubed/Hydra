# Research: Web REPL Foundation Slice

**Date**: 2026-03-15
**Feature**: `.sdd/web-repl-foundation-5oycwcdr/`

## Decision 1: Workspace Boundary Placement

**Question**: Where does the web initiative workspace live in the repository so that it is clearly separated from the Hydra core without reorganizing existing files?

**Chosen**: npm workspaces with `apps/web/`, `apps/web-gateway/`, and `packages/web-contracts/` added incrementally alongside the existing root layout.

**Rationale**:

- The authoritative docs (`docs/web-interface/02-stack-and-monorepo.md`) prescribe this exact layout: `apps/web` (React + Vite frontend), `apps/web-gateway` (Hono gateway), and `packages/web-contracts` (shared schemas/DTOs).
- The existing `lib/`, `test/`, `bin/`, `scripts/` structure remains untouched. The new directories are additive workspace members registered in the root `package.json`.
- npm workspaces are the prescribed starting point because Hydra already uses npm. The docs explicitly state `turbo` can be added later if justified by growth, not as a prerequisite.
- The boundary is immediately visible — `apps/` and `packages/` at repo root are obviously separate from `lib/`.
- ESLint boundary rules can treat `apps/web`, `apps/web-gateway`, and `packages/web-contracts` as distinct elements with enforced import directions.
- Agent instruction files (CLAUDE.md, AGENTS.md, COPILOT.md) can reference the workspace roots for automated agent discovery (FR-008).

**Alternatives considered**:

- Top-level `web/` directory — Simpler but does not match the workspace strategy described in the docs. Misses the gateway and contracts separation. Would require a second restructure when gateway and contract packages are added.
- `lib/web/` — Blurs the boundary between core and web. The docs explicitly state `lib/` remains the Hydra core runtime.
- Separate Git repository — Defeats the single-repo incremental strategy. Cross-surface contract changes would require coordinated multi-repo PRs.
- Deferred workspaces (directory only, no npm workspace config) — Loses the ability to give each package its own dependencies, scripts, and tsconfig. The docs recommend npm workspaces from the start.

---

## Decision 2: Shared Contract Location and Format

**Question**: Where do cross-surface contract definitions live, and what format do they use so that any surface can validate conformance programmatically?

**Chosen**: A dedicated `packages/web-contracts/` workspace package using Zod v4 (already a project dependency). Each contract is a named export that provides both a TypeScript type (via `z.infer`) and a runtime validator.

**Rationale**:

- The authoritative docs (`docs/web-interface/02-stack-and-monorepo.md`) place shared contracts in `packages/web-contracts/` — a dedicated workspace package that both `apps/web` and `apps/web-gateway` depend on.
- Keeping contracts in their own package enforces the boundary architecturally: consumers depend on the package explicitly, not via a transitive import from the core runtime.
- Zod v4 is already a production dependency used for MCP tool schema validation throughout Hydra. Reusing it avoids a new dependency and matches existing contributor muscle memory.
- Zod provides both compile-time types and runtime validation from a single definition, directly satisfying FR-004 (automated validation) and SC-005 (conformance checks without human intervention).
- The foundation slice creates the package scaffold (package.json, tsconfig, barrel export, contract index) but does NOT seed domain-specific schemas (e.g., session handshake). Domain contracts are the responsibility of later specs (`web-session-and-auth`, `web-conversation-protocol`).

**Alternatives considered**:

- `lib/hydra-shared/contracts/` — Would couple web contracts to the existing core shared layer. The docs explicitly separate `packages/web-contracts` from `lib/` to keep the core runtime lean.
- JSON Schema files — Language-agnostic, but would require a new validation library and would not produce TypeScript types without a code-generation step. Adds build complexity to a no-build project.
- TypeScript interfaces only — Provide compile-time safety but zero runtime validation. A surface could produce invalid data that passes the type checker but fails at runtime.
- Protocol Buffers / Protobuf — Powerful cross-language support, but overkill for a single-repo TypeScript project. Requires a compilation step that contradicts the project's no-build philosophy.

---

## Decision 3: Quality Gate Mechanism

**Question**: How are quality expectations enforced for web initiative changes so that enforcement is automated and produces machine-readable results?

**Chosen**: Extend the existing quality pipeline (`npm run quality` + Husky hooks + CI coverage check) with workspace-specific rules:

1. ESLint boundary rules: `apps/web` and `apps/web-gateway` can import from `packages/web-contracts` but not from `lib/` directly. `apps/web` cannot import from `apps/web-gateway` or vice versa.
2. Each workspace package gets its own `tsconfig.json` extending the root config, so type-checking scopes are explicit.
3. Existing coverage threshold (80%) applies to web initiative code via c8 inclusion patterns.
4. A documented quality expectations file (`packages/web-contracts/QUALITY.md` or equivalent) enumerates all requirements so contributors can self-check before submitting.
5. TDD ordering is documented as mandatory: write failing tests before implementation for all new contracts and modules.
6. ESLint boundary rules are forward-compatible: the foundation sets `web-gateway → web-contracts` as the initial allowed import direction; when daemon public APIs are formalized (per `docs/web-interface/02-stack-and-monorepo.md`: "gateway depends on shared contracts and daemon-facing public APIs"), the boundary is extended to include that surface. Similarly, `web-app` is extended to allow future `packages/*` siblings (e.g., `packages/web-ui`) when those packages are created.

**Rationale**:

- The project already has a mature quality pipeline (ESLint strict + Prettier + TypeScript strict + Husky + CI). Extending it is far cheaper and more reliable than building a separate gate.
- ESLint boundary enforcement is machine-readable (lint output is JSON-parseable) and already understood by all contributors and agents, satisfying FR-006 for immediately enforced gates.
- The 80% coverage threshold is already enforced by `npm run test:coverage:check` in CI. Including workspace packages in the coverage scope means new web code is held to the same bar once it contains measurable source files; until then, coverage is a documented required standard.
- TDD expectations align with the web docs (`docs/web-interface/05-security-and-quality.md`): "TDD by default" is a required principle. TDD methodology is enforced by task ordering and reviewer attestation, not by automated tooling.

**Alternatives considered**:

- Custom quality gate script — Would need its own maintenance, testing, and documentation. Higher cost for the same outcome the existing tools already provide.
- CODEOWNERS-only enforcement — GitHub CODEOWNERS can require review from web initiative owners, but it is advisory (can be overridden by admins) and does not enforce testing or validation quality.
- Separate CI workflow — Would duplicate pipeline logic and risk divergence from core quality standards over time.

---

## Decision 4: Boundary Documentation Format

**Question**: What format should the boundary documentation take so that it serves both human readers and automated agents?

**Chosen**: A structured Markdown document (`docs/web-interface/07-boundaries-and-governance.md`) positioned as a subordinate document within the existing web-interface doc set (authority flows from `docs/WEB_INTERFACE.md`), with machine-parseable front matter and a canonical ownership table. The same boundaries are encoded in `eslint.config.mjs` (machine-enforced) and referenced from `CLAUDE.md`, `AGENTS.md`, and `COPILOT.md` (agent-discoverable).

**Rationale**:

- Markdown is the project's universal documentation format — every agent instruction file, architecture doc, and contributor guide uses it.
- Placing the doc at `docs/web-interface/07-boundaries-and-governance.md` keeps it within the established numbered web-interface doc set, avoiding a competing top-level authority alongside `docs/WEB_INTERFACE.md`.
- Front matter (YAML) provides structured metadata that agents can parse without natural language understanding.
- The ESLint boundaries config is the machine-enforced source of truth for import rules. The Markdown document provides the human-readable "why" behind those rules.
- Updating the existing agent instruction files (CLAUDE.md, AGENTS.md, COPILOT.md) ensures agents discover the boundary during their standard context-loading step, satisfying FR-008.
- The ownership table maps `apps/`, `packages/`, and `lib/` to responsible surfaces, reflecting the workspace layout.

**Alternatives considered**:

- JSON/YAML config file — Machine-readable but poor for human narrative. Would require a separate human-readable document anyway, creating two sources of truth.
- README.md only — Buries the boundary documentation in a general-purpose file. Does not create a citable, linkable, standalone reference.

---

## Decision 5: Contract Versioning and Breaking Change Governance

**Question**: How are shared contracts versioned, and what happens when a contract needs a breaking change?

**Chosen**: Contracts use explicit version numbers in their module names (e.g., `session-contract-v1.ts`). Breaking changes require a new version file; the old version remains until all consumers have migrated. A `CONTRACTS.md` index in `packages/web-contracts/` documents the lifecycle state of each contract (draft, stable, deprecated, removed).

**Rationale**:

- File-level versioning is the simplest scheme that avoids breaking existing consumers. A new contract version is a new file — no existing imports change.
- The `CONTRACTS.md` index provides a single place to check contract status, supporting the edge case identified in the spec (breaking changes to contracts depended upon by multiple surfaces).
- This approach requires zero tooling — it relies on file naming conventions and a manually maintained index. Tooling can be added later if contract volume grows.

**Alternatives considered**:

- Semantic versioning with a registry — Overengineered for the current scale. Hydra is a single-repo project with a small contributor base.
- Date-based versioning — Less informative than explicit version numbers. A contributor cannot tell from the filename whether two contracts are compatible.
- No versioning (edit in place) — Directly contradicts FR-007 (incremental addition without modifying existing artifacts). Breaking changes would require coordinated updates across all consumers.

---

## Decision 6: Extensibility for Later Phases

**Question**: How does the foundation ensure later phases (auth, protocol, UI) can build on it without modifying foundation artifacts?

**Chosen**: Convention-based extension points with a clear distinction between **structural artifacts** (never modified) and **extension-point registries** (designed for append):

1. New contracts are added as new files in `packages/web-contracts/src/`. The barrel export (`index.ts`) and contract index (`CONTRACTS.md`) are append-only registries — adding a line to re-export a new contract counts as "extending," not "modifying."
2. New workspace packages are added under `packages/` (e.g., `packages/web-ui/`) or new apps under `apps/`. The root `package.json` workspaces array is updated to include them.
3. New quality rules are added as new ESLint rule entries — existing rules are never weakened.
4. Foundation structural artifacts — boundary documentation, quality gate definition, workspace configuration shape — do not need changes when later phases extend the system.

**Rationale**:

- Distinguishing "structural" from "registry" artifacts resolves the contradiction where SC-004 demands zero modifications but barrel exports inherently grow. Barrel exports and contract indexes are designed to be appended to; this is their purpose, not a violation.
- npm workspaces make adding new packages a well-defined operation (create directory, add package.json, register in root workspaces array).
- Later phases inherit quality expectations from the documented gate and repo-wide CI configuration automatically.
- This directly satisfies SC-004 as revised: no structural artifact changes, only append-only registry updates.

**Alternatives considered**:

- Plugin/extension registry — Adds runtime complexity for a compile-time problem. Later phases do not need to register with the foundation; they just need to follow its conventions.
- Monorepo workspace per phase — Would work but fragmenting packages by phase rather than by responsibility creates confusion. Packages should be organized by what they contain (contracts, UI, test helpers), not by when they were built.
- Strict zero-touch policy (no barrel export updates) — Unrealistic. Every contract package needs a barrel export, and adding a re-export line is the standard TypeScript pattern. Pretending this is avoidable sets an untestable success criterion.
