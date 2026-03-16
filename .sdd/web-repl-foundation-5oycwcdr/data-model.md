# Data Model: Web REPL Foundation Slice

**Date**: 2026-03-15
**Feature**: `.sdd/web-repl-foundation-5oycwcdr/`

## Overview

The foundation slice does not introduce runtime data storage or a persistent data layer. Its "data model" consists of schema definitions (shared contracts), documentation artifacts (boundary docs, quality gate), and configuration entries (ESLint boundary rules). This document describes the structure and relationships of these entities.

## Entity: Shared Contract

A versioned, schema-based definition that serves as the single source of truth for data shapes and behavioral expectations crossing surface boundaries. Lives in `packages/web-contracts/src/`.

| Attribute   | Type              | Description                                                            |
| ----------- | ----------------- | ---------------------------------------------------------------------- |
| `name`      | string            | Human-readable contract name (e.g., "Conversation Turn")               |
| `version`   | integer           | Monotonically increasing version number                                |
| `status`    | enum              | One of: `draft`, `stable`, `deprecated`, `removed`                     |
| `consumers` | list of strings   | Surfaces that depend on this contract (e.g., `["browser", "gateway"]`) |
| `schema`    | Zod schema object | Runtime validator that defines the contract's data shape               |
| `type`      | TypeScript type   | Compile-time type inferred from the Zod schema via `z.infer`           |

**Foundation scope**: The foundation slice creates the contract package scaffold and test infrastructure but does NOT define domain-specific contracts. The first domain contracts (session, conversation, events) are introduced by later specs.

### Lifecycle States

```
draft → stable → deprecated → removed
```

- **draft**: Under active development. May change without notice. Not suitable for production consumers.
- **stable**: Locked. Changes require a new version. Consumers may depend on it safely.
- **deprecated**: Superseded by a newer version. Consumers should migrate. Will be removed after all consumers have migrated.
- **removed**: Deleted from the codebase. No consumers remain.

### Validation Rules

- Contract name must be unique within a version (e.g., only one `{name}-contract-v1`).
- Version numbers are positive integers, starting at 1.
- A contract cannot move backward in the lifecycle (e.g., `stable` → `draft` is forbidden).
- A `deprecated` contract must reference its successor version.
- A `removed` contract must have zero remaining consumers.

## Entity: Workspace Boundary

The documented separation between the web initiative workspace packages and Hydra core. Lives in `docs/web-interface/07-boundaries-and-governance.md` (subordinate to `docs/WEB_INTERFACE.md`).

| Attribute           | Type          | Description                                                                                          |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `roots`             | list of paths | Filesystem roots of the web initiative (`apps/web/`, `apps/web-gateway/`, `packages/web-contracts/`) |
| `ownership_scope`   | text          | Description of what each workspace package owns and does not own                                     |
| `import_rules`      | list          | Allowed import directions (e.g., `apps/web → packages/web-contracts`, not `apps/web → lib/`)         |
| `governance`        | text          | Rules for cross-boundary changes and ambiguous ownership resolution                                  |
| `exception_process` | text          | Documented process for emergency exceptions to boundary rules                                        |
| `phases`            | list          | Known future phases with expected workspace packages                                                 |

### Validation Rules

- The boundary roots must be workspace packages registered in the root `package.json` workspaces array.
- Import rules must be machine-enforced (ESLint boundaries plugin). Initial rules set `web-gateway → web-contracts`; extended to include daemon public APIs when those are formalized (per `docs/web-interface/02-stack-and-monorepo.md`).
- The governance section must include a resolution process for ambiguous ownership.
- The phases list is informational and append-only.

## Entity: Vocabulary

The initial shared terminology for the web REPL. Lives in `packages/web-contracts/src/vocabulary.ts`. Establishes the names and minimal structural identity of the core protocol objects and daemon contract families per `docs/web-interface/06-phases-and-sdd.md` Phase 0 and `docs/web-interface/04-protocol.md`.

| Attribute          | Type | Description                                                                                                                                                                                                                          |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocolObjects`  | list | Named core protocol objects: Conversation, Turn, StreamEvent, ApprovalRequest, Artifact, SessionSnapshot — each with a `kind` discriminator and minimal structural identity                                                          |
| `contractFamilies` | list | Named first daemon contract families per Phase 0: conversation messaging, command catalog and execution, council and multi-agent eventing, task live output, config and controlled mutations — each with a short purpose description |

### Validation Rules

- Each protocol object has a unique `kind` string discriminator.
- Each contract family has a unique name and a one-line purpose.
- Vocabulary stubs define structure only at the identity level (name, kind, minimal fields). Full field-level schemas are the responsibility of later specs.
- Vocabulary type stubs are Zod schemas so they participate in the same runtime validation system as domain contracts.

## Entity: Quality Gate

The set of enforceable quality expectations for all web initiative changes.

| Attribute                   | Type       | Description                                                                                                                                                 |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tdd_methodology`           | text       | TDD ordering requirement: failing test before implementation (Red-Green-Refactor)                                                                           |
| `testing_threshold`         | percentage | Minimum code coverage required (inherits 80% from core)                                                                                                     |
| `test_presence`             | boolean    | Whether every source file must have a corresponding test file                                                                                               |
| `validation_requirement`    | text       | Contract conformance and schema validation expectations                                                                                                     |
| `documentation_requirement` | text       | Minimum documentation for new modules and contracts                                                                                                         |
| `audit_trail`               | text       | Change auditability expectations (PR-based, conventional commits)                                                                                           |
| `enforcement_mechanism`     | list       | Tools that enforce each expectation (ESLint, c8, CI workflow). Each gate classified as **immediately enforced** or **required standard** (see spec FR-006). |

### Validation Rules

- Every expectation must be binary (pass/fail), not subjective.
- Every expectation must reference its enforcement mechanism.
- The quality gate must never weaken existing Hydra core expectations — it may only match or exceed them.

## Entity: Contract Conformance Test

A test that validates real data against a published contract schema.

| Attribute          | Type    | Description                                                           |
| ------------------ | ------- | --------------------------------------------------------------------- |
| `target_contract`  | string  | Name of the contract being tested                                     |
| `target_version`   | integer | Version of the contract being tested                                  |
| `valid_fixtures`   | list    | Data samples that should pass validation                              |
| `invalid_fixtures` | list    | Data samples that should fail validation, with expected error details |

### Validation Rules

- Every stable contract must have at least one conformance test.
- Conformance tests must include both valid and invalid fixtures.
- Invalid fixtures must assert specific error messages, not just "fails."

## Relationship Diagram

```
┌─────────────────────┐       ┌──────────────────────┐
│  Workspace Boundary  │       │     Quality Gate      │
│  (docs/web-interface/│       │ (packages/web-        │
│  07-boundaries-and-  │       │  contracts/QUALITY.md) │
│  governance.md)      │       │                      │
│  Defines scope for  │───────│  Applies to all      │
│  all web work       │       │  work within boundary │
└─────────┬───────────┘       └──────────┬───────────┘
          │                              │
          │ governs                      │ enforces
          ▼                              ▼
┌─────────────────────┐       ┌──────────────────────┐
│  Shared Contract     │       │ Contract Conformance │
│  (packages/          │◄──────│ Test                 │
│   web-contracts/src/)│       │ (test/web-contracts/) │
│                     │       │                      │
│  Consumed by:       │       │  Validates against   │
│  browser, gateway,  │       │  specific contract   │
│  daemon             │       │  + version           │
└─────────┬───────────┘       └──────────────────────┘
          │
          │ includes
          ▼
┌─────────────────────┐
│  Vocabulary          │
│  (packages/          │
│   web-contracts/src/ │
│   vocabulary.ts)     │
│                     │
│  Names: 6 protocol  │
│  objects + 5 first  │
│  contract families   │
└─────────────────────┘
```
