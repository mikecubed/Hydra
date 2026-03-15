# Quality Gate — Hydra Web Initiative

> **Authority:** [`docs/web-interface/05-security-and-quality.md`](../../docs/web-interface/05-security-and-quality.md)
> **Scope:** All changes within `apps/` and `packages/` workspace directories.

## Gate Classification

Each gate is classified by its enforcement status:

- ⚡ **Immediately enforced** — tooling blocks merging; binary pass/fail.
- 📋 **Required standard** — documented mandatory expectation; verified by reviewer attestation
  until automated enforcement is wired.

## Quality Expectations

### QG-001 📋 TDD Methodology

All new contracts and modules must follow **Red-Green-Refactor**. A failing test must be written and
committed before the implementation that makes it pass.

- **Criterion:** Test file exists and was committed before or with the implementation.
- **Enforcement:** PR review, task ordering, and reviewer attestation.
- **Local check:** Verify test files exist for all new source files; confirm commit history shows
  test-first ordering.
- **Path to automation:** Deferred until test-ordering tooling is added.

### QG-002 ⚡/📋 Test Coverage

All web initiative source files must meet the project-wide **80% line coverage** threshold.

- **Criterion:** `c8 check-coverage` passes for web initiative packages.
- **Enforcement:** ⚡ Immediately enforced by c8 once packages contain measurable source files;
  📋 vacuously satisfied in foundation (no runtime code yet).
- **Local check:** `npm run test:coverage:check`.

### QG-003 📋 Test Presence

Every `.ts` source file in web initiative packages must have a corresponding `.test.ts` file.

- **Criterion:** 1:1 correspondence between source and test files.
- **Enforcement:** Reviewer attestation.
- **Local check:** Manual inspection or `find packages/*/src -name '*.ts' | ...` comparison.
- **Path to automation:** Add test-presence linter.

### QG-004 📋 Contract Conformance

Any cross-surface data must be validated against a published shared contract schema. No ad-hoc type
assertions at surface boundaries.

- **Criterion:** Conformance tests exist using `assertContractValid`/`assertContractInvalid` helpers.
- **Enforcement:** Reviewer attestation and conformance test presence.
- **Local check:** Run `node --test test/web-contracts/*.test.ts`.

### QG-005 ⚡ Lint Compliance

All web initiative code must pass `npm run lint` with zero errors and zero warnings.

- **Criterion:** ESLint exits 0 on web initiative files.
- **Enforcement:** Immediately enforced once packages are wired into ESLint boundary config.
- **Local check:** `npm run lint`.

### QG-006 ⚡ Type Safety

All web initiative code must pass `npm run typecheck` with zero errors.

- **Criterion:** `tsc --noEmit` exits 0 covering web initiative packages.
- **Enforcement:** Immediately enforced once `tsconfig.json` includes `packages/**/*.ts` and
  `apps/**/*.ts`.
- **Local check:** `npm run typecheck`.

### QG-007 📋 Documentation

New modules must include a top-of-file JSDoc summary. New contracts must be registered in
`packages/web-contracts/CONTRACTS.md`.

- **Criterion:** JSDoc present; CONTRACTS.md updated.
- **Enforcement:** Reviewer attestation.
- **Local check:** Manual inspection.

### QG-008 ⚡ Audit Trail

All changes must arrive via PR (never direct push to `main`). Conventional commit messages required.

- **Criterion:** PR exists; commit messages follow conventional format.
- **Enforcement:** Branch protection rules.
- **Local check:** N/A (enforced at repository level).

### QG-009 ⚡ Architectural Boundary

- `apps/web` and `apps/web-gateway` may import from `packages/web-contracts` but not from `lib/`
  directly.
- `apps/web` may not import from `apps/web-gateway` or vice versa.

See [`docs/web-interface/07-boundaries-and-governance.md`](../../docs/web-interface/07-boundaries-and-governance.md)
for the full import direction rules.

- **Criterion:** ESLint boundary rules pass.
- **Enforcement:** Immediately enforced by ESLint boundary plugin.
- **Local check:** `npm run lint`.

**Note:** Per `docs/web-interface/02-stack-and-monorepo.md`, the gateway boundary will be extended
to allow daemon-facing public API imports when that API surface is formalized. `apps/web` will be
extended to allow future `packages/*` siblings (e.g., `packages/web-ui`).
