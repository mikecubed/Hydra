---
description: "Escalate complex or explicitly multi-model SDD requests into the sdd-review-loop workflow."
---

## Purpose

Use this skill to decide when normal SDD generation is enough and when the request should be
escalated into the full multi-model `sdd-review-loop`.

This skill should stay lightweight:

- keep simple features on the normal `/sdd.specify` → `/sdd.plan` → `/sdd.tasks` path;
- route high-risk or explicitly multi-model requests into `sdd-review-loop`.

## Activation Triggers

Activate when the user asks for things like:

- "use subagents to spec/plan/tasks this"
- "have Opus draft it and GPT review it"
- "use multi-model review for the SDD"
- "iterate on the spec/plan/tasks until solid"
- "review and revise the SDD package"

Also activate when the request appears to be:

- foundational;
- cross-cutting;
- security-sensitive;
- architecture-shaping;
- multi-phase;
- likely to touch several existing docs or SDD packages.

## Decision Rule

### Use normal SDD flow when:

- the slice is small and local;
- there is little ambiguity;
- there are no major cross-boundary implications;
- the user did not ask for multi-model or subagent review.

### Escalate to `sdd-review-loop` when:

- the user explicitly asks for multiple models, subagents, review/revise loops, or cross-checking;
- the feature changes roadmap ordering, ownership boundaries, or package/module responsibilities;
- the feature depends on careful scope control or deferral handling;
- the feature is likely to create `spec.md`, `plan.md`, and `tasks.md` drift if generated in one pass;
- the feature sits between already-existing slices and must be grounded in current repo reality.

## Behavior

When triggered:

1. Quickly classify the request as **simple** or **high-risk**.
2. If it is **simple**, continue with the standard SDD workflow.
3. If it is **high-risk** or the user explicitly asked for multi-model review:
   - recommend or invoke `sdd-review-loop`;
   - preserve the user's requested model roles if they specified them;
   - otherwise default to:
     - Opus 4.6 for generation/revision
     - GPT-5.4 for review
4. Keep the escalation reason explicit:
   - "foundational slice"
   - "cross-cutting boundary risk"
   - "explicit multi-model request"
   - "needs repo-grounded review loop"

## Guidance

Prefer escalation when the cost of a bad spec or plan is high.

Do **not** escalate just because the feature is interesting. Escalate when the request has a real
risk of:

- false assumptions about current code;
- hidden dependencies;
- architecture drift;
- reopening deferred scope;
- weak task ordering.

## Examples

### Escalate

- "Use Opus and GPT to spec, plan, and task the next web transport slice."
- "Review the plan with subagents and revise it until it's ready."
- "This changes the boundary between gateway and daemon; use multi-model SDD."

### Do not escalate

- "Create a small spec for a new CLI flag."
- "Generate tasks for a local refactor that only touches one module."

## Relationship to Other Skills

- `sdd-feature-workflow` is the lightweight entrypoint that recommends starting with `/sdd.specify`.
- `sdd-review-trigger` decides whether the request should stay lightweight or be escalated.
- `sdd-review-loop` contains the heavy multi-model generate-review-revise workflow.
