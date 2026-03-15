# Feature Specification: Web REPL Foundation Slice

**Created**: 2026-03-15
**Status**: Draft
**Input**: Establish the minimum shared groundwork for all later Hydra web initiative phases — clear boundaries, shared contracts, and baseline quality expectations.

## User Scenarios & Testing _(mandatory)_

### User Story 1 – Maintainer Identifies Web Boundary (Priority: P1)

A project maintainer needs to understand, at a glance, which parts of the Hydra repository belong to the new web initiative and which belong to the existing Hydra core. The boundary must be obvious from the workspace structure and documented in a single, authoritative location so that ownership questions are resolved without spelunking through code.

**Why this priority**: Every later web phase depends on a clear boundary. Without it, contributors will accidentally couple web-specific work to the core, creating merge conflicts, unclear ownership, and integration risk that compounds with every subsequent slice.

**Independent Test**: A new contributor who has never seen the repository can read the boundary documentation and correctly classify five example changes as "web initiative" or "Hydra core" within five minutes.

**Acceptance Scenarios**:

1. **Given** the Hydra repository with the foundation slice applied, **When** a maintainer reads the boundary documentation, **Then** they can identify the web initiative's workspace root, its stated responsibilities, and the surfaces it does not own.
2. **Given** a proposed change that touches both the web initiative workspace and the Hydra core, **When** a reviewer evaluates it, **Then** the boundary documentation provides enough information to determine whether the cross-boundary coupling is intentional or accidental.
3. **Given** an automated agent operating on the repository, **When** it is asked to make a web-related change, **Then** it can determine the correct workspace scope from the boundary documentation without human guidance.

---

### User Story 2 – Contributor Uses Shared Contracts (Priority: P1)

A contributor working on any Hydra surface (browser, gateway, or daemon) needs a single source of truth that defines the contracts between surfaces. These contracts describe the shapes of data and the behavioral expectations that must hold across boundaries, so that each surface can be developed, tested, and deployed without duplicating assumptions about the others.

**Why this priority**: Without shared contracts, every surface team independently invents its own understanding of cross-boundary data and behavior. Discrepancies surface only at integration time, producing hard-to-diagnose bugs and costly rework. This is tied for P1 because it is the other prerequisite that gates every later phase.

**Independent Test**: Two contributors independently build conformance tests against the published contracts. Both sets of tests agree on what constitutes valid and invalid data without any out-of-band coordination.

**Acceptance Scenarios**:

1. **Given** the shared contract definitions exist, **When** a contributor adds a new field to a cross-surface message, **Then** the contract source of truth must be updated first, and downstream surfaces can detect the change through their validation tooling.
2. **Given** a contract definition for a specific cross-surface interaction, **When** a contributor writes a conformance test against it, **Then** the test can validate real data without depending on any other surface being running or available.
3. **Given** a contract has been published, **When** a surface produces data that violates the contract, **Then** validation fails with a clear, actionable error message identifying the specific violation.

---

### User Story 3 – New Web Work Meets Quality Gate (Priority: P2)

A contributor submitting new work under the web initiative needs to know, before they start, what quality expectations apply. These expectations cover TDD methodology, testing coverage, validation strictness, documentation requirements, and change auditability. The expectations must be explicit, enforceable, and documented — not tribal knowledge.

**Why this priority**: Quality expectations set late are never retroactively met. Establishing them in the foundation slice means every later phase inherits them automatically, avoiding the "tech debt amnesty" problem where early code is permanently below standard.

**Independent Test**: A contributor submits a change to the web initiative workspace that is missing required test coverage. For immediately enforced gates (lint, typecheck, format), the tooling rejects the change with a specific, actionable explanation. For required-standard gates (coverage, test presence), the documented criteria enable reviewers and future CI steps to identify the gap.

**Acceptance Scenarios**:

1. **Given** the web initiative quality expectations are documented, **When** a new contributor reads them, **Then** they can enumerate the minimum TDD, testing, validation, documentation, and audit requirements for any web initiative change.
2. **Given** a change to the web initiative workspace, **When** it is evaluated against the quality gate, **Then** immediately enforced gates (lint, typecheck, format) produce a machine-readable pass/fail result; required-standard gates (coverage, test presence, TDD methodology) are verified by documented criteria and reviewer attestation until their CI enforcement is wired.
3. **Given** the quality expectations document, **When** a reviewer evaluates a pull request, **Then** they can verify compliance using only the documented criteria — immediately enforced gates are binary and automated; required-standard gates are binary and measurable by inspection.

---

### User Story 4 – Later Phase Builds Safely on Foundation (Priority: P2)

A future contributor beginning work on a later web phase (such as authentication, session management, protocol handling, or UI rendering) needs confidence that the foundation provides stable extension points. They should be able to add new contracts, new workspace areas, and new quality rules without modifying or destabilizing the foundation itself.

**Why this priority**: If the foundation cannot be extended without modification, every later phase becomes a breaking change to the foundation. This creates serialization bottlenecks and merge conflicts that defeat the purpose of an incremental design.

**Independent Test**: A simulated "phase 2" contributor adds a new contract definition and a new workspace area. The addition requires no changes to foundation structural artifacts (boundary docs, quality gate definition, workspace configuration) and only designed-for-append updates to extension-point registries (barrel exports, contract index). All existing quality gates pass.

**Acceptance Scenarios**:

1. **Given** the foundation slice is complete, **When** a contributor adds a new contract definition for a not-yet-built surface interaction, **Then** the new contract coexists with existing contracts without modifying them.
2. **Given** the foundation workspace structure, **When** a contributor introduces a new workspace area for a later phase, **Then** the new area inherits the documented quality expectations automatically.
3. **Given** the existing quality gate, **When** a contributor adds a new quality rule for a later phase, **Then** the new rule augments the existing gate without weakening or replacing any existing checks.

---

### Edge Cases

- What happens when a change cannot be cleanly classified as "web initiative" or "Hydra core"? The boundary documentation must provide a resolution process for ambiguous ownership.
- How does the system handle a contract that is depended upon by multiple surfaces and needs a breaking change? The contract governance rules must define a versioning or deprecation expectation.
- What happens when a contributor bypasses the quality gate? Immediately enforced gates (lint, typecheck, format) are mandatory and block merging. Required-standard gates are documented as mandatory expectations; enforcement tooling for these is wired incrementally as web packages gain code. A defined exception process must exist for emergencies.
- What happens when an automated agent generates code that spans the web/core boundary? The boundary documentation must be machine-readable enough for agent tooling to respect it.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The repository MUST contain a clearly demarcated workspace boundary that separates web initiative artifacts from Hydra core artifacts, without requiring a reorganization of existing core files.
- **FR-002**: A single, authoritative boundary document MUST exist that describes which responsibilities belong to the web initiative, which belong to the Hydra core, and how cross-boundary changes are governed.
- **FR-003**: Shared contract definitions MUST exist as a single source of truth for all cross-surface data shapes and behavioral expectations (browser, gateway, daemon). The foundation MUST establish the initial shared vocabulary by naming the core protocol objects (conversation, turn, stream event, approval request, artifact, session snapshot) and the first daemon contract families (conversation messaging, command catalog and execution, council and multi-agent eventing, task live output, config and controlled mutations) at a definitional level — sufficient for later phases to reference by name without re-inventing terminology.
- **FR-004**: Contract definitions MUST be expressed in a machine-validated format so that any surface can programmatically verify conformance without manual inspection.
- **FR-005**: A documented quality gate MUST define minimum expectations for testing, validation, documentation, and audit trail for all web initiative changes.
- **FR-006**: The quality gate MUST produce machine-readable pass/fail results so that enforcement can be automated in continuous integration. Gates backed by existing root tooling (lint, typecheck, format) are immediately enforced once new packages are wired into the root pipeline. Gates whose enforcement depends on code volume (coverage thresholds, test-presence checks) become actively enforced as web packages gain source files; until then they are documented required standards verified by reviewer attestation.
- **FR-007**: The workspace structure MUST support incremental addition of new workspace areas, contract definitions, and quality rules. Foundation structural artifacts (boundary docs, quality gate definition, workspace configuration) MUST NOT require modification. Extension-point registries (barrel exports, contract index) MAY be appended to as part of extending.
- **FR-008**: The boundary documentation and contract definitions MUST be interpretable by automated agents (structured, predictable location, machine-readable format) to support agent-friendly workflows.

### Key Entities

- **Workspace Boundary**: The logical and physical separation between web initiative work and existing Hydra core. Defines ownership, responsibility scope, and cross-boundary governance rules.
- **Shared Contract**: A versioned definition of data shapes and behavioral expectations that must hold across surface boundaries (browser ↔ gateway ↔ daemon). Serves as the single source of truth for cross-surface integration.
- **Quality Gate**: A set of explicit, measurable, enforceable expectations covering testing, validation, documentation, and auditability that all web initiative changes must satisfy before acceptance.
- **Surface**: A distinct execution context within Hydra (browser, gateway, daemon) that communicates with other surfaces through shared contracts. Each surface owns its internal behavior but must conform to shared contracts at its boundaries.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A new contributor can correctly identify the web initiative boundary and classify five example changes as "web" or "core" within 5 minutes of reading the boundary documentation.
- **SC-002**: Two independent contributors can write conformance tests against the same shared contract and reach identical pass/fail conclusions on the same test data, with zero out-of-band coordination.
- **SC-003**: 100% of changes submitted to the web initiative workspace are evaluated against the documented quality expectations before acceptance. Immediately enforced gates (lint, typecheck, format) block merging; required-standard gates (coverage, test presence) are verified by reviewer attestation until their CI enforcement is wired.
- **SC-004**: A simulated later-phase addition (new contract + new workspace area) can be completed with no modifications to foundation structural artifacts (boundary docs, quality gate, workspace config) and only append-only updates to extension-point registries (barrel exports, contract index).
- **SC-005**: All shared contract definitions support automated validation — a conformance check runs without human intervention and produces a clear pass/fail result with actionable error details on failure.
- **SC-006**: The quality gate documentation is complete enough that a reviewer can verify compliance using only the documented criteria, with no subjective judgment required. Each gate item is classified as immediately enforced or required-standard with an explicit path to automated enforcement.
