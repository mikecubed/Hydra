---
description: "Run a multi-model SDD generate-review-revise loop for spec, plan, and tasks."
---

## Purpose

Use this skill when a developer wants higher-confidence SDD output than a single pass from
`/sdd.specify`, `/sdd.plan`, or `/sdd.tasks`.

This skill captures the workflow that has worked well in Hydra:

1. generate with one strong model;
2. review with a different strong model against the actual repo/docs/code;
3. revise using only concrete findings;
4. repeat until the artifact is internally consistent and ready to advance.

The default pairing is:

- **Opus 4.6** for generation/revision
- **GPT-5.4** for review/critique

You may swap roles if the user asks, but the key rule is: **generator and reviewer should be
different models**.

## Invocation Model

- `sdd-review-trigger` is the normal entrypoint for this workflow.
- This skill should usually run only when:
  - `sdd-review-trigger` explicitly escalates into it; or
  - the developer invokes `sdd-review-loop` directly on purpose.
- Do **not** compete with `sdd-review-trigger` for the same natural-language activation phrases.

If this skill is invoked directly, treat that as an explicit request for the heavy review loop.

## Workflow

### 1. Establish the slice and baseline

Before generating anything:

1. Read the relevant roadmap docs, existing `.sdd/` packages, and current code surfaces.
2. Identify the exact slice boundary:
   - what this artifact owns;
   - what it explicitly does **not** own;
   - what existing modules/contracts/docs it must reuse.
3. Record the baseline constraints in your working context before invoking subagents.

Do **not** ask a model to generate in a vacuum if the repo already contains adjacent work.

### 2. Spec loop

When creating or revising a spec:

1. Run `/sdd.specify` (typically with Opus 4.6).
2. Review the resulting `spec.md` with GPT-5.4 against:
   - current codebase reality;
   - roadmap docs;
   - adjacent SDD packages;
   - scope boundaries and deferred work.
3. Classify findings before revising:
   - **blocking inconsistency**
   - **scope drift**
   - **missing requirement**
   - **unsafe assumption**
   - **wording only**
4. Send only substantive findings back for revision.
5. Repeat until the spec is:
   - internally consistent;
   - grounded in current repo reality;
   - free of accidental implementation details that belong in the plan.

### 3. Plan loop

When creating or revising a plan:

1. Run `/sdd.plan` using the reviewed spec.
2. Review the resulting `plan.md` (plus `research.md`, `data-model.md`, `contracts/` if present)
   with GPT-5.4 against:
   - the reviewed spec;
   - real repository structure;
   - existing modules and boundaries;
   - feasibility of the proposed phases/files/contracts.
3. Focus review on:
   - ownership boundaries;
   - mismatch between data model and actual APIs;
   - hidden prerequisites;
   - replay/state/lifecycle correctness;
   - accidental duplication of existing primitives/helpers.
4. Send precise corrections back for revision.
5. Repeat until the plan is implementation-ready.

### 4. Tasks loop

When creating or revising tasks:

1. Run `/sdd.tasks` using the reviewed plan.
2. Review `tasks.md` with GPT-5.4 against:
   - `spec.md`
   - `plan.md`
   - `research.md`
   - `data-model.md`
   - repo conventions and validation commands
3. Focus review on:
   - dependency order;
   - missing quality gates;
   - task ownership ambiguity;
   - tasks that smuggle in deferred scope;
   - phases that can pass without actually delivering the promised user story.
4. Revise until task order and scope are tight.

## Required Review Gates

Do **not** advance from one stage to the next unless the current stage passes these gates.

### Spec gate

- scope is explicit;
- deferred items are explicit;
- no repo-breaking assumptions are treated as already-existing facts;
- user stories and FR/SC sections are coherent;
- artifact aligns with current roadmap docs.

### Plan gate

- file/module paths match the repo;
- dependencies and prerequisites are explicit;
- no hidden architectural contradiction with current code;
- data model and API assumptions match the actual system;
- ownership boundaries are clear.

### Tasks gate

- tasks are dependency-ordered;
- every major requirement has an owner task;
- validation tasks exist at sensible cut points;
- no task reopens deferred scope without saying so;
- wording is specific enough to implement without guesswork.

## Stop Conditions

Use explicit stop conditions to avoid infinite loops.

- Maximum **3 meaningful review/revision rounds per artifact**.
- If later rounds produce only wording nits, stop and accept.
- If models disagree on architecture, prefer:
  1. repo reality,
  2. current docs/SDD baseline,
  3. narrower scope.
- If unresolved disagreement remains, summarize it clearly instead of looping forever.

## Terminal Outcomes

Every artifact must end in one of these explicit states:

1. **accepted**
   - the gate passed and the workflow can advance;
2. **accepted with noted follow-ups**
   - the gate passed, but low-priority follow-ups or future clarifications were recorded;
3. **blocked and handed back**
   - the review/revision cap was reached and the artifact still fails its gate;
4. **stopped by user**
   - the developer chose to stop after seeing the remaining issues.

If an artifact is **blocked and handed back**, do all of the following before stopping:

- state which gate still fails;
- list the substantive unresolved issues only;
- say whether the best next move is:
  - continue another loop,
  - narrow scope,
  - revise the baseline assumptions,
  - or split the slice;
- do **not** silently continue into the next SDD stage.

## Common Failure Modes

Watch for these repeatedly:

1. **Spec assumes missing infrastructure**
   - Example: assumes push transport, replay, or shared error contracts already exist.

2. **Plan silently widens scope**
   - Example: adds browser UI, degraded transport, multi-operator ownership, or shared contract work
     that the spec deferred.

3. **Tasks depend on future phases**
   - Example: a P1 path blocked by P2 work-control or optional later wiring.

4. **Cross-file drift**
   - Example: `spec.md`, `plan.md`, and `tasks.md` describe different ownership or payload shapes.

5. **Model invents APIs**
   - Example: references endpoints, helpers, or state surfaces that do not exist in the repo.

6. **Review devolves into style commentary**
   - Ignore wording-only churn unless it affects scope, correctness, or implementability.

## Review Prompt Guidance

When asking the reviewer model, always provide:

- repo path;
- artifact path(s);
- current roadmap docs;
- adjacent code/modules;
- the exact question you want answered;
- instruction to report only substantive issues.

Good review questions:

- "What assumptions in this spec are not true in the current repo?"
- "Which parts of this plan violate current module boundaries?"
- "Can this tasks list pass Phase N without actually delivering USX?"

Bad review questions:

- "Any thoughts?"
- "Is this good?"

## Suggested Modes

### Strict mode

Use when the feature is high-risk, foundational, or cross-cutting.

- always use multi-model review for spec, plan, and tasks;
- require repo-grounded citations in review feedback;
- require a final consistency sweep across all generated files.

### Fast mode

Use when the slice is small and local.

- still use two models;
- limit to one review/revision round per artifact unless a blocker appears.

## Deliverable Expectations

A successful run of this skill should leave behind:

- a reviewed `spec.md`;
- a reviewed `plan.md` plus any supporting artifacts;
- a reviewed, dependency-ordered `tasks.md`;
- updated roadmap docs if the reviewed result changes the intended sequence or boundaries.
- a short final synthesis that states:
  - which artifacts were accepted;
  - which issues were resolved during review;
  - which issues remain, if any;
  - whether the package is ready to implement or needs another directed pass.

## Final Guidance

This skill is about **confidence and convergence**, not maximal iteration.

Use multiple models to catch:

- false assumptions,
- scope mistakes,
- dependency gaps,
- cross-file inconsistencies.

Do not use the loop to chase polish forever. Advance when the artifact is correct, bounded, and
implementable.
