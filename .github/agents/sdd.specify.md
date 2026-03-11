---
description: 'Create a feature specification from a natural language description.'
handoffs:
  - label: Create Implementation Plan
    agent: sdd.plan
    prompt: Create a plan for this spec
    send: true
  - label: Iterate on Spec
    agent: sdd.specify
    prompt: Refine the specification
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

Given the feature description in `$ARGUMENTS`, do this:

1. **Check for headless mode**: If `$ARGUMENTS` contains `headless` or `--headless`, enable headless mode — auto-accept all recommended defaults and complete without pausing for user input.

2. **Generate a feature directory name**:
   - Derive a short 2-4 word slug from the feature description (e.g., "user-auth", "analytics-dashboard")
   - Append an 8-character random alphanumeric suffix (e.g., `user-auth-a3f9b2c1`)
   - Full path: `.sdd/{slug}-{suffix}/`

3. **Create the feature directory** and all required parent directories.

4. **Get the specification template**:

   ```bash
   sdd template specification
   ```

5. **Generate the specification** by filling the template:
   - Replace `[FEATURE NAME]` with a human-readable feature name
   - Replace `[DATE]` with today's date
   - Fill in user stories (at least 2), functional requirements, and success criteria
   - Mark genuinely unclear decisions as `[NEEDS CLARIFICATION: specific question]` — maximum 3 markers

6. **Write** the filled specification to `.sdd/{feature-dir}/spec.md`.

7. **Quality validation** — validate the spec:
   - No implementation details (no languages, frameworks, APIs)
   - All mandatory sections completed
   - Requirements are testable and success criteria are measurable

8. **Handle clarifications** (skip in headless mode — auto-resolve with defaults):
   - Present at most 3 questions, wait for answers, update spec, re-validate

9. **Write quality checklist** to `.sdd/{feature-dir}/checklists/requirements.md`:

   ```bash
   sdd template specification-checklist
   ```

10. **Report completion** with feature directory path, spec file path, and checklist summary.

## Next Steps

Present these options (auto-select "Create Implementation Plan" in headless mode):

1. **Create Implementation Plan** — run `/sdd.plan`
2. **Attempt Direct Implementation** — proceed with this context:
   - Feature: [feature name]
   - Key requirements: [top 3 FRs from spec]
   - Success criteria: [SC list from spec]
3. **Iterate on Spec** — refine further

## Guidelines

- Focus on **WHAT** and **WHY** — no HOW (no tech stack, APIs, code structure)
- Every requirement must be independently testable
- Limit clarifications to decisions that genuinely impact scope or security
