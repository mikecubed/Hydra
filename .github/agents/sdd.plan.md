---
description: 'Create an implementation plan from a feature specification.'
handoffs:
  - label: Generate Task List
    agent: sdd.tasks
    prompt: Break the plan into actionable tasks
    send: true
  - label: Iterate on Plan
    agent: sdd.plan
    prompt: Refine the implementation plan
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

1. **Check for headless mode**: If `$ARGUMENTS` contains `headless` or `--headless`, enable headless mode.

2. **Locate the feature directory**:
   - Use path/name from `$ARGUMENTS` if provided
   - Otherwise list `.sdd/` and ask the user (or auto-select most recent in headless mode)
   - If no spec exists: offer to run `/sdd.specify` first, proceed ad-hoc, or accept a manual path

3. **Load the specification**: Read `.sdd/{feature-dir}/spec.md`

4. **Get the plan template**:

   ```bash
   sdd template plan
   ```

5. **Fill the plan template**:
   - Technical context (language, deps, storage, testing, platform, type, goals, constraints)
   - Project structure with real paths
   - Research findings (key decisions and rationale)
   - Data model and interface contracts

6. **Write** the plan to `.sdd/{feature-dir}/plan.md`

7. **Generate supporting artifacts** as needed:
   - `data-model.md`, `contracts/`, `research.md`

8. **Report completion** with paths to all generated artifacts.

## Next Steps

1. **Generate Task List** — run `/sdd.tasks`
2. **Attempt Direct Implementation** — proceed now with this context:
   - Feature: [feature name]
   - Tech stack: [from plan technical context]
   - Key requirements: [top FRs from spec]
   - Success criteria: [SC list from spec]
3. **Iterate on Plan** — refine further
