# Quality + Node 24 Agent Workstreams — 2026-03-12

**Parent docs:**

- `docs/quality-task-list-2026-03-12.md`
- `docs/plans/2026-03-12-quality-node24-remediation-roadmap.md`

## Purpose

This document describes how to split the remediation into the maximum safe amount of parallel work while still coordinating through tests, dependencies, and review gates.

## Coordination principles

- Parallelize by **subsystem** so each worker keeps architectural context.
- Keep **test integrity** centralized first; do not let subsystem workers mutate tests opportunistically without the Phase 0 rules.
- Require every workstream PR to state:
  - what rules it is addressing
  - what files it owns
  - what tests were added or strengthened
  - what validation commands were run
- No worker may disable a rule or test unless the reason is documented in the PR and the touched file when needed.

## Recommended worker topology

## Coordinator

**Role:** central planner / integrator

### Responsibilities

- keep the baseline and task docs current
- assign workstreams and maintain dependencies
- reject overlapping file ownership where possible
- merge lanes only after validation and conflict review

## Lane A — Test integrity

**Best fit:** analyst + implementer pair

### Scope

- enumerate and remove test `todo`s by implementing real coverage
- identify fake-path coverage
- document stale/low-value tests for rewrite or removal review

### Why first

All later work depends on the suite being trustworthy.

### Outputs

- updated tests
- documentation of questionable tests
- no unresolved `todo` tests

## Lane B — Node 24 foundation

**Best fit:** implementer with reviewer support

### Scope

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- runtime script choices such as `--strip-types`

### Risks

- accidental script breakage
- incomplete runtime migration

### Required checks

- `npm run typecheck`
- `node --test 'test/**/*.test.{ts,mjs}'`
- targeted script smoke tests

## Lane C — CI and documentation alignment

**Best fit:** architect/reviewer + implementer

### Scope

- GitHub Actions runtime updates
- README / CLAUDE / HYDRA runtime docs
- follow-up plan docs with version references

### Risks

- docs and CI drifting apart
- undocumented temporary compatibility choices

### Required checks

- docs formatting
- mermaid lint if applicable
- confirm workflow versions match runtime policy

## Lane D — Operator/UI cleanup

**Owned files**

- `lib/hydra-operator.ts`
- `lib/hydra-ui.ts`
- `lib/hydra-statusbar.ts`
- `lib/hydra-prompt-choice.ts`

### Rule focus

- nullish/defaulting cleanup
- template-expression cleanup
- explicit API boundaries

### Required tests

- operator behavior tests
- UI/status formatting tests
- any new regression tests around optional inputs

## Lane E — Pipeline cleanup

**Owned files**

- `lib/hydra-evolve.ts`
- `lib/hydra-nightly.ts`
- `lib/hydra-actualize.ts`
- related review/status modules

### Rule focus

- string normalization
- branch/task conditional cleanup
- exported boundary typing

### Required tests

- pipeline/unit tests for touched modules
- ordering tests if async flow changes

## Lane F — Daemon/route cleanup

**Owned files**

- `lib/orchestrator-daemon.ts`
- `lib/daemon/write-routes.ts`
- `lib/orchestrator-client.ts`

### Rule focus

- exit-path cleanup
- route/input narrowing
- async race and promise-executor fixes

### Required tests

- daemon integration tests
- route lifecycle tests
- client error-path tests

## Lane G — Shared runtime cleanup

**Owned files**

- `lib/hydra-shared/agent-executor.ts`
- `lib/hydra-agents.ts`
- `lib/hydra-model-recovery.ts`
- `lib/hydra-mcp-server.ts`
- `lib/hydra-mcp.ts`

### Rule focus

- boundary typing
- safe stringification
- unsafe access reduction

### Required tests

- shared helper tests
- MCP/agent executor tests

## Merge cadence

## Wave 0

- Lane A only

## Wave 1

- Lane B

## Wave 2

- Lane C in parallel with the shared test-hardening work that emerges from Lane A

## Wave 3

- Lanes D, E, F, and G in parallel

## Wave 4

- warning-reduction follow-up passes owned by the same lane owners to minimize handoff cost

## Wave 5

- coordinator runs CI-tightening pass after all subsystem lanes are merged

## Conflict minimization rules

- If a helper is shared across subsystem boundaries, extract that helper in its own preparatory PR before parallel lanes start.
- Prefer additive tests and local helper functions over broad cross-repo refactors.
- Avoid touching `lib/hydra-operator.ts` from non-operator lanes unless the coordinator explicitly assigns it.
- When a lane must touch a shared file, document it in advance in the PR description.

## Review policy

Every lane should receive review against these questions:

1. Does this use real code paths where practical?
2. Did any test get weakened, skipped, or replaced with a mock-only assertion?
3. Did any lint or type check get disabled, and if so, is the reason documented and justified?
4. Are the validation commands sufficient for the touched surface?
5. Does this create cross-lane conflict risk that should be split into a helper PR?

## Completion standard for each lane

A lane is not complete until:

- touched files are formatted
- touched code passes lint and type-check
- targeted tests pass
- full repo validation has been run before merge
- any residual deferrals are documented with rationale
