---
description: 'Generate an actionable, dependency-ordered task list from the feature plan.'
handoffs:
  - label: Iterate on Tasks
    agent: sdd.tasks
    prompt: Refine the task list
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
   - If no plan exists: offer to run `/sdd.plan` first, proceed without it, or accept a manual path

3. **Load design documents** from `.sdd/{feature-dir}/`:
   - **Required**: `plan.md`, `spec.md`
   - **Optional**: `data-model.md`, `contracts/`, `research.md`

4. **Get the tasks template**:

   ```bash
   sdd template tasks
   ```

5. **Generate the task list** organized by user story. Every task must follow:

   ```
   - [ ] T### [P?] [US?] Description with exact/file/path.ext
   ```

6. **Write** tasks to `.sdd/{feature-dir}/tasks.md`

7. **Report** total task count, per-story breakdown, and suggested MVP scope.

## Next Steps

1. **Implement** — work through tasks.md in order
2. **Attempt Direct Implementation** — skip formal tasks and implement with this context:
   - Feature: [feature name]
   - Tech stack: [from plan]
   - Key requirements: [top FRs from spec]
   - Success criteria: [SC list from spec]
3. **Iterate on Tasks** — refine the task list
