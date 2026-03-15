# Contract Catalog: Web REPL Foundation Slice

**Date**: 2026-03-15
**Feature**: `.sdd/web-repl-foundation-5oycwcdr/`

## Overview

This document catalogs the interface contracts that the foundation slice exposes. These are the public surfaces that other phases, contributors, and automated agents will depend on.

## Contract 1: Shared Schema Definitions (programmatic)

**Location**: `packages/web-contracts/src/`
**Type**: Programmatic (TypeScript/Zod)
**Consumers**: All Hydra web surfaces (browser, gateway), contract conformance tests

### What It Exposes

Each contract file in `packages/web-contracts/src/` exports:

1. **Schema object** — A Zod schema that defines the valid shape of cross-surface data. Can be used to validate any data at runtime.
2. **TypeScript type** — Inferred from the schema via `z.infer<typeof schema>`. Provides compile-time safety for consumers.
3. **Parse function** — Accepts unknown data, returns either validated data (typed) or a structured error describing exactly which fields failed and why.

### Foundation Scope

The foundation slice creates the contract package scaffold — `package.json`, `tsconfig.json`, barrel export (`src/index.ts`), contract index (`CONTRACTS.md`), and test helpers — and establishes the **initial shared vocabulary**: definitional stubs naming the six core protocol objects (Conversation, Turn, StreamEvent, ApprovalRequest, Artifact, SessionSnapshot) and the five first daemon contract families, per `docs/web-interface/06-phases-and-sdd.md` Phase 0 scope. The sixth family from `04-protocol.md` (operational intelligence) is deferred to a later phase. Full field-level schemas for these objects are the responsibility of later specs (`web-session-and-auth`, `web-conversation-protocol`).

This approach establishes shared terminology at the right abstraction level without drifting into auth or conversation implementation.

### Versioning Rules

- Each contract lives in its own file, named `{name}-contract-v{N}.ts`.
- Version numbers are positive integers, starting at 1.
- Breaking changes require a new version file. The old file remains.
- The `CONTRACTS.md` index in `packages/web-contracts/` tracks lifecycle state.

---

## Contract 2: Boundary Documentation

**Location**: `docs/web-interface/07-boundaries-and-governance.md`
**Authority**: Subordinate to `docs/WEB_INTERFACE.md` (the index and authority root for the entire web doc set)
**Type**: Documentation (Markdown with YAML front matter)
**Consumers**: Human maintainers, automated agents, reviewers

### What It Exposes

1. **YAML front matter** — Structured metadata including:
   - `workspace_roots`: Filesystem paths of the web initiative packages
   - `ownership`: Which surfaces each workspace package owns
   - `phases`: List of known future phases
   - `governance`: Cross-boundary change policy name

2. **Ownership table** — Maps top-level directories to responsible surfaces:
   - `lib/` → Hydra core
   - `apps/web/` → Browser surface
   - `apps/web-gateway/` → Gateway surface
   - `packages/web-contracts/` → Shared (all web surfaces)
   - `test/` → All

3. **Governance rules** — Describes how to handle:
   - Changes that touch both web workspaces and core
   - Ambiguous ownership disputes
   - Emergency exceptions to boundary rules

4. **Phase roadmap** — Lists known future phases and their expected workspace areas, so contributors can plan ahead.

### Machine Readability

The YAML front matter is parseable by any YAML library. Agents can extract `workspace_roots`, `ownership`, and `phases` without natural language processing. The ESLint boundary configuration (`eslint.config.mjs`) is the machine-enforced companion to this document.

---

## Contract 3: Quality Gate Specification

**Location**: `packages/web-contracts/QUALITY.md`
**Type**: Documentation (Markdown)
**Consumers**: Contributors, reviewers, CI pipeline

### What It Exposes

1. **Enumerated expectations** — Each quality expectation is listed with:
   - A unique identifier (e.g., `QG-001`)
   - A binary (pass/fail) criterion
   - The enforcement mechanism (which tool checks it)

2. **Expectation categories** (each classified as immediately enforced ⚡ or required standard 📋):
   - **TDD methodology** 📋: Red-Green-Refactor cycle required for all new contracts and modules. Enforced by task ordering and reviewer attestation; automated enforcement deferred until test-ordering tooling is added.
   - **Testing** ⚡/📋: Minimum coverage threshold (immediately enforced by c8 once packages contain measurable source files); test file presence requirement (📋 required standard, reviewer-verified).
   - **Validation**: Contract conformance, schema validation for all cross-surface data
   - **Documentation**: Required documentation for new modules and contracts
   - **Audit trail**: PR-based changes, conventional commit messages, required review

3. **Enforcement links** — Each expectation references the specific tool or CI step that enforces it, so contributors can run the same checks locally before submitting.

---

## Contract 4: Contract Test Helpers (programmatic)

**Location**: `test/web-contracts/contract-helpers.ts`
**Type**: Programmatic (TypeScript)
**Consumers**: All contract conformance test files

### What It Exposes

1. **`assertContractValid(schema, data)`** — Asserts `.parse(data)` succeeds and returns the parsed value. Wraps Zod errors in AssertionErrors for clear test output.
2. **`assertContractInvalid(schema, data, expectedField?)`** — Asserts `.parse(data)` throws, and optionally checks that the error references the named field.

These helpers are schema-agnostic — they work with any Zod schema, ensuring later phases can write conformance tests without duplicating validation boilerplate.

---

## Contract 5: Vocabulary Type Stubs (programmatic)

**Location**: `packages/web-contracts/src/vocabulary.ts`
**Type**: Programmatic (TypeScript/Zod)
**Consumers**: All later-phase contract authors, protocol spec implementers, documentation

### What It Exposes

1. **Core protocol object stubs** — Zod schemas naming the six core protocol objects per `docs/web-interface/04-protocol.md`:
   - `Conversation` — top-level workspace thread
   - `Turn` — one user input and resulting agent activity
   - `StreamEvent` — incremental text, lifecycle, or structured event
   - `ApprovalRequest` — typed request for confirmation or input
   - `Artifact` — file, patch, plan, diff, log, or result object
   - `SessionSnapshot` — resumable browser state

   Each stub has a `kind` discriminator and minimal structural identity (enough to distinguish and route, not enough to implement features).

2. **Contract family registry** — A typed constant naming the five first daemon contract families per `docs/web-interface/06-phases-and-sdd.md` Phase 0 (full names from `04-protocol.md`):
   - conversation messaging
   - command catalog and execution
   - council and multi-agent eventing
   - task live output
   - config and controlled mutations

   Each entry has a `name`, short `purpose`, and `status` (all `planned` in foundation). The sixth family (operational intelligence) is deferred to a later phase.

### Scope Boundary

Vocabulary stubs define **names and identity** only. They do not define full field-level schemas, behavior, or validation logic for auth, sessions, or conversation flows. Later specs own the full schema elaboration and reference the vocabulary stubs by re-exporting and extending them.

---

## Contract Dependencies

```
Session/Auth Phase     ──depends on──▶ Contract Package Scaffold
                       ──depends on──▶ Vocabulary Type Stubs
                       ──depends on──▶ Contract Test Helpers
                       ──depends on──▶ Boundary Documentation
                       ──depends on──▶ Quality Gate Specification
                       ──will add──▶   session/auth contracts to packages/web-contracts/src/

Protocol Phase         ──depends on──▶ Contract Package Scaffold
                       ──depends on──▶ Vocabulary Type Stubs
                       ──depends on──▶ Boundary Documentation
                       ──will add──▶   conversation/event contracts to packages/web-contracts/src/

UI Phase               ──depends on──▶ Boundary Documentation
                       ──depends on──▶ Quality Gate Specification
                       ──will add──▶   packages/web-ui/ workspace package
```
