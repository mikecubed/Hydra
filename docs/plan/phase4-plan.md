# Phase 4: Shared Abstractions & Architectural Boundaries

> **Goal**: Reduce duplication and lock in layering after the high-risk Phase 3 splits have landed.

## Tracks

### Track A — IAgentExecutor Interface

- Define `IAgentExecutor` in `lib/hydra-shared/agent-executor.ts`
- Migrate consumers to depend on the interface
- Write contract tests against the interface

### Track B — IBudgetGate Interface

- Identify all duplicated budget-check paths across the codebase
- Extract into `lib/hydra-shared/budget-gate.ts`
- Migrate consumers

### Track C — Context Consolidation

- Audit all files building agent context strings outside `hydra-context.ts`
- Route them through `hydra-context.ts`

### Track D — Architecture Boundary Enforcement

- Install `eslint-plugin-boundaries`
- Define layer rules: `core` → `shared` → `lib` → `bin`
- Enforce with CI

### Track E — Coverage Gaps

- Identify Phase 3 modules with no or minimal test coverage
- Write focused unit tests (TDD where possible)

## Exit Gate

- Shared APIs are narrow, consumers depend on interfaces where practical
- Layer rules are enforced (not aspirational)
- All quality gates green
