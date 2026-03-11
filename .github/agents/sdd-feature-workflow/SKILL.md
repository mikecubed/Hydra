---
description: 'Auto-activate the sdd specification workflow when a developer requests a new feature.'
---

## Activation Triggers

Activate this skill when the user's message matches patterns like:

- "build a [X] feature"
- "implement [X]"
- "create a [X]"
- "I need to add [X]"
- "add [X] to the project"

## Behavior

When triggered:

1. Recognize the user wants to build something new
2. Ask: "Would you like to start with a feature specification? Running `/sdd.specify` will create a structured spec with user stories and requirements. Or I can proceed directly."
3. If the user agrees: run `/sdd.specify` with their feature description
4. If the user declines: proceed with the original request without blocking
