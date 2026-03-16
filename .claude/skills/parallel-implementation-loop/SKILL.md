---
description: "Run parallel subagent implementation tracks with Opus 4.6 for coding and GPT-5.4 for review."
---

## Purpose

Use this skill when the developer wants to implement a reviewed plan or task list using multiple
parallel subagent tracks.

This skill captures the implementation workflow that works best for larger Hydra slices:

1. choose only dependency-ready tasks;
2. split them into independent tracks;
3. use **Opus 4.6** to implement each track;
4. use **GPT-5.4** to review each track;
5. fix issues before merging the tracks back together;
6. run repo quality gates before calling the batch complete.

This is an execution skill, not a planning skill. Use it after the feature already has an accepted
`spec.md`, `plan.md`, or `tasks.md`.

## Activation Triggers

Activate when the user asks for things like:

- "implement these tasks in parallel"
- "use subagents to work multiple tracks"
- "have Opus implement and GPT review each track"
- "parallelize the implementation"
- "work through the task list with review on every track"

Also activate when:

- the task list already has clear dependencies;
- several tasks are marked parallelizable or clearly touch different files/modules;
- the implementation is large enough that one serial track would be slow or noisy.

## Model Roles

Default roles:

- **Opus 4.6** — implementation/refactor/test-writing on each track
- **GPT-5.4** — review/bug-finding on each completed track

Keep reviewer and implementer as different models.

## Core Rules

### 1. Only parallelize truly independent work

Before starting parallel tracks:

1. read the current task list and dependency notes;
2. identify **ready** tasks only;
3. group tasks by file/module ownership and dependency boundaries;
4. do **not** split tasks that:
   - edit the same tight code region;
   - depend on the output of another unfinished track;
   - require shared schema/contract decisions still in motion.

If in doubt, serialize.

### 2. TDD is mandatory on every track

Every track must follow:

1. write or update failing tests first;
2. implement until green;
3. refactor while keeping tests green.

Do not allow implementation-first work unless the task is truly non-code or purely mechanical.

### 3. Enforce design quality during implementation

Every track must preserve:

- **SOLID**
  - single responsibility;
  - explicit boundaries;
  - no hidden coupling;
- **DRY**
  - reuse existing helpers/contracts/primitives;
  - do not duplicate validation, transport, or error-shaping logic;
- **small composable modules**
  - prefer extracting helpers over growing a god-file;
- **type safety**
  - no unsafe escape hatches just to get green.

## Workflow

### 1. Establish implementation baseline

Before launching tracks:

1. read the relevant:
   - `tasks.md`
   - `plan.md`
   - `spec.md`
   - adjacent repo code
2. identify the next ready tasks;
3. define track boundaries explicitly:
   - track name
   - owned tasks
   - owned files
   - dependencies
   - expected validation

Good example:

- Track A: daemon event bridge
- Track B: gateway REST mediation foundation
- Track C: WebSocket protocol schemas

Bad example:

- Track A and Track B both editing the same route module and shared contracts simultaneously

### 2. Launch implementation tracks

For each track:

1. ask **Opus 4.6** to implement the track itself;
2. give it:
   - exact tasks;
   - exact files;
   - TDD requirement;
   - repo conventions;
   - reuse constraints;
   - validation commands for the owned area.

Each track should:

- start from failing tests;
- make focused code changes only within its scope;
- report:
  - files changed;
  - tests added/updated;
  - local validation performed;
  - any uncertainty or unresolved edge case.

### 3. Review each completed track

After an implementation track finishes:

1. send its diff to **GPT-5.4** for review;
2. instruct review to report only substantive issues:
   - correctness bugs;
   - contract drift;
   - concurrency/order bugs;
   - missing tests;
   - boundary violations;
   - SOLID/DRY regressions that materially matter.

Do **not** spend review budget on style nits.

### 4. Revise the track if needed

If GPT-5.4 finds real issues:

1. send those issues back to **Opus 4.6**;
2. revise the track;
3. re-run targeted validation;
4. optionally re-review if the fix is substantial.

Stop when the reviewer no longer finds meaningful issues.

### 5. Merge tracks carefully

When multiple tracks are ready:

1. integrate them one at a time into the shared branch;
2. resolve any cross-track conflicts explicitly;
3. run targeted integration tests after each merge if needed;
4. do **not** assume independently good tracks compose cleanly.

If two tracks drift on a shared interface, stop and reconcile before proceeding.

## Required Gates

### Track gate

A track is not complete until all are true:

- tests were written or updated first where appropriate;
- track-local tests pass;
- changed files remain within the track boundary;
- reviewer found no unresolved substantive issues;
- lint/type/format state for touched files is clean.

### Batch gate

A batch of tracks is not complete until all are true:

- merged diff is coherent;
- integration behavior still works;
- repo-level quality commands pass;
- no duplicated helpers or parallel-track drift remains.

## Quality Gates

At minimum, enforce the repo’s real gates after merging the batch:

- formatting compliance;
- lint compliance;
- type-check compliance;
- relevant targeted tests during track work;
- full quality/test commands before handoff when the repo expects them.

For Hydra, prefer:

- targeted `node --test ...` while a track is in progress;
- then repo-level validation such as `npm run quality` and `npm test` before declaring success.

## Parallelization Heuristics

Safe to parallelize:

- tests in different modules;
- daemon and gateway modules with a stable agreed interface;
- separate route families after shared client/validator plumbing lands;
- documentation updates after the code shape is stable.

Usually not safe to parallelize:

- shared schema/contract changes and all consumers at the same time;
- multiple tracks editing the same public API without a locked interface;
- foundational refactors and feature work mixed together;
- tasks with hidden ordering dependencies.

## Common Failure Modes

Watch for these repeatedly:

1. **Fake parallelism**
   - tasks look separate but edit the same abstraction boundary.

2. **Implementation-first drift**
   - Opus writes code before failing tests exist.

3. **Track-local success, batch-level failure**
   - each track is green alone, but merged behavior breaks.

4. **Reviewer misses repo reality**
   - review must be grounded in actual code, not generic best practices.

5. **Duplicate helper growth**
   - parallel tracks each create their own version of the same helper.

6. **Unowned integration work**
   - no track owns the final glue, validation, or docs updates.

## Stop Conditions

- maximum **2 meaningful review/fix cycles per track** unless the user asks for more;
- if a track still churns, reduce scope or serialize it;
- if track conflicts become frequent, stop parallelization and continue serially.

## Prompt Guidance

When prompting **Opus 4.6** for implementation, include:

- track name;
- exact task IDs;
- exact files/modules;
- TDD requirement;
- SOLID/DRY constraints;
- validation commands;
- instruction to stay within track boundaries.

When prompting **GPT-5.4** for review, include:

- track purpose;
- intended task IDs;
- diff or changed files;
- instruction to report only substantive issues;
- request to check:
  - correctness;
  - missing tests;
  - contract/boundary drift;
  - unnecessary duplication.

## Deliverable Expectations

A successful run of this skill should leave behind:

- completed ready tasks;
- tests added before implementation where appropriate;
- reviewed per-track diffs;
- merged and validated code;
- repo quality gates passing;
- a short synthesis of:
  - what each track implemented;
  - what review issues were found;
  - what was changed in response;
  - what remains next.

## Final Guidance

Parallel execution is a force multiplier only when the boundaries are real.

Use this skill to speed up implementation **without** relaxing:

- TDD,
- SOLID,
- DRY,
- lint/format/type safety,
- or repo-level quality gates.

If those standards start slipping, reduce concurrency and restore control.
