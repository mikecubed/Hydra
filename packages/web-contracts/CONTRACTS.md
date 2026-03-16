# Contract Index — @hydra/web-contracts

> **Purpose:** Single source of truth for cross-surface contract lifecycle.

## Versioning Rules

- New version = new file (e.g., `session-contract-v1.ts` → `session-contract-v2.ts`).
- Old files remain until all consumers have migrated.
- Breaking changes **require** a new version file.

## Lifecycle States

| State        | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `draft`      | Under active development; may change without notice      |
| `stable`     | Production-ready; breaking changes require a new version |
| `deprecated` | Superseded; consumers should migrate to the replacement  |
| `removed`    | Deleted from the package; no longer available            |

**Transitions:** `draft` → `stable` → `deprecated` → `removed`

## Contract Registry

| Name             | Version | Status | Consumers    | File                |
| ---------------- | ------- | ------ | ------------ | ------------------- |
| Vocabulary stubs | v0      | draft  | all surfaces | `src/vocabulary.ts` |

<!-- Example row: | SessionContract | v1 | stable | gateway, browser | `src/session-contract-v1.ts` | -->
