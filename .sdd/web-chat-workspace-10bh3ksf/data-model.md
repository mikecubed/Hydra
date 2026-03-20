# Data Model: Web Chat Workspace

**Date**: 2026-03-20 | **Plan**: [plan.md](./plan.md)

## Browser Workspace Entities

These entities are browser-side state and view models. They do not replace gateway or daemon authority. Their purpose is to let the browser render the authoritative conversation state coherently and safely.

### WorkspaceState

Top-level browser-owned state for the active workspace session.

| Attribute              | Type                                 | Description                                    |
| ---------------------- | ------------------------------------ | ---------------------------------------------- |
| `activeConversationId` | `string \| null`                     | Currently selected conversation                |
| `conversationOrder`    | `string[]`                           | Visible ordering of known conversations        |
| `conversations`        | `Map<string, ConversationViewState>` | Browser projection of each loaded conversation |
| `drafts`               | `Map<string, ComposerDraftState>`    | Per-conversation composer draft ownership      |
| `connection`           | `WorkspaceConnectionState`           | Current transport/session/sync visibility      |
| `visibleArtifact`      | `ArtifactViewState \| null`          | Currently opened artifact view                 |

**Invariants**:

- At most one `activeConversationId` is selected at a time.
- `drafts` are keyed by conversation and must never be applied to a different conversation.
- Browser state is replaceable by authoritative refresh/reconnect reconciliation.

---

### ConversationViewState

Browser projection of one conversation’s visible transcript and operator controls.

| Attribute        | Type                                        | Description                                      |
| ---------------- | ------------------------------------------- | ------------------------------------------------ |
| `conversationId` | `string`                                    | Conversation identity                            |
| `title`          | `string`                                    | Visible conversation label                       |
| `lineageSummary` | `ConversationLineageState \| null`          | Retry/branch/follow-up lineage context           |
| `entries`        | `TranscriptEntryState[]`                    | Ordered transcript entries shown to the operator |
| `hasMoreHistory` | `boolean`                                   | Whether more history can be loaded               |
| `loadState`      | `'idle' \| 'loading' \| 'ready' \| 'error'` | Browser loading state for this conversation      |
| `controlState`   | `ConversationControlState`                  | Eligibility and stale-control visibility         |

**Validation Rules**:

- `entries` remain in authoritative order.
- A conversation cannot display controls that are known to be stale after reconciliation.
- History loading must append or prepend deterministically without scrambling visible order.

---

### TranscriptEntryState

Visible unit rendered in the conversation transcript.

| Attribute       | Type                                                        | Description                       |
| --------------- | ----------------------------------------------------------- | --------------------------------- |
| `entryId`       | `string`                                                    | Stable browser key                |
| `kind`          | `'turn' \| 'prompt' \| 'activity-group' \| 'system-status'` | Visible transcript entry type     |
| `turnId`        | `string \| null`                                            | Owning turn when applicable       |
| `status`        | `string`                                                    | Operator-visible state label      |
| `timestamp`     | `string \| null`                                            | Displayable time anchor           |
| `contentBlocks` | `ContentBlockState[]`                                       | Safe render blocks for this entry |
| `artifacts`     | `ArtifactReferenceState[]`                                  | Associated artifacts              |
| `controls`      | `EntryControlState[]`                                       | Eligible actions for this entry   |

**Invariants**:

- `contentBlocks` are safe-to-render representations, never raw executable content.
- A `prompt` entry may expose response controls only while still actionable.
- A `turn` entry may contain streaming blocks that evolve over time but preserve ordering.

---

### ComposerDraftState

Browser-owned draft input for one conversation.

| Attribute           | Type                                | Description                             |
| ------------------- | ----------------------------------- | --------------------------------------- |
| `conversationId`    | `string`                            | Owning conversation                     |
| `draftText`         | `string`                            | Current draft content                   |
| `submitState`       | `'idle' \| 'submitting' \| 'error'` | Submission lifecycle                    |
| `validationMessage` | `string \| null`                    | Operator-visible draft validation issue |

**Validation Rules**:

- Draft state belongs to exactly one conversation.
- A draft in `submitting` state cannot silently move to another conversation.
- Submission failure must remain visible until corrected or dismissed.

---

### PromptViewState

Browser representation of an approval or follow-up request.

| Attribute             | Type                                                                             | Description                            |
| --------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| `promptId`            | `string`                                                                         | Prompt identity                        |
| `parentTurnId`        | `string`                                                                         | Owning turn                            |
| `status`              | `'pending' \| 'responding' \| 'resolved' \| 'stale' \| 'unavailable' \| 'error'` | Prompt lifecycle                       |
| `allowedResponses`    | `string[]`                                                                       | Browser-safe response options or modes |
| `contextBlocks`       | `ContentBlockState[]`                                                            | Safe explanatory context               |
| `lastResponseSummary` | `string \| null`                                                                 | Visible summary of submitted response  |

**Invariants**:

- Only `pending` prompts expose actionable controls.
- A prompt that becomes stale must stop offering live controls immediately after reconciliation.
- Prompt context renders safely using the same content-safety rules as transcript content.

---

### ArtifactViewState

Browser representation of an artifact list item or opened artifact.

| Attribute       | Type                                                           | Description                  |
| --------------- | -------------------------------------------------------------- | ---------------------------- |
| `artifactId`    | `string`                                                       | Artifact identity            |
| `turnId`        | `string`                                                       | Owning turn                  |
| `kind`          | `string`                                                       | Artifact category            |
| `label`         | `string`                                                       | Operator-visible label       |
| `availability`  | `'listed' \| 'loading' \| 'ready' \| 'unavailable' \| 'error'` | Artifact availability state  |
| `previewBlocks` | `ContentBlockState[]`                                          | Safe rendered preview blocks |

**Validation Rules**:

- Artifact visibility remains associated with the owning turn.
- Unavailable artifacts must remain explainable instead of disappearing silently.
- Rendered preview content must follow safe rendering rules.

---

### WorkspaceConnectionState

Operator-visible transport and synchronization status for the browser workspace.

| Attribute                 | Type                                                         | Description                                |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| `transportStatus`         | `'connecting' \| 'live' \| 'reconnecting' \| 'disconnected'` | WebSocket/session transport visibility     |
| `syncStatus`              | `'idle' \| 'syncing' \| 'recovered' \| 'error'`              | Transcript/state reconciliation visibility |
| `sessionStatus`           | `'active' \| 'expiring-soon' \| 'expired' \| 'invalidated'`  | Session lifecycle visibility               |
| `daemonStatus`            | `'healthy' \| 'unavailable' \| 'recovering'`                 | Gateway/daemon reachability visibility     |
| `lastAuthoritativeUpdate` | `string \| null`                                             | Last successful authoritative sync marker  |

**Invariants**:

- Operators must be able to distinguish connection loss from session loss and daemon loss.
- `reconnecting` and `syncing` are visible operational states, not silent internal transitions.

---

## Supporting Value Objects

### ContentBlockState

Safe render-ready content segment used by transcript, prompt, and artifact views.

| Attribute  | Type                                           | Description                              |
| ---------- | ---------------------------------------------- | ---------------------------------------- |
| `blockId`  | `string`                                       | Stable render key                        |
| `kind`     | `'text' \| 'code' \| 'status' \| 'structured'` | Safe display type                        |
| `text`     | `string \| null`                               | Plain text payload                       |
| `metadata` | `Record<string, string> \| null`               | Browser-safe structured display metadata |

### ConversationLineageState

Visible lineage summary for retry, branch, and follow-up relationships.

| Attribute              | Type                                         | Description                            |
| ---------------------- | -------------------------------------------- | -------------------------------------- |
| `sourceConversationId` | `string \| null`                             | Source conversation for a branch       |
| `sourceTurnId`         | `string \| null`                             | Source turn for retry/branch/follow-up |
| `relationshipKind`     | `'follow-up' \| 'retry' \| 'branch' \| null` | Lineage relationship type              |

### ConversationControlState

Conversation-scoped operator control availability.

| Attribute               | Type             | Description                                            |
| ----------------------- | ---------------- | ------------------------------------------------------ |
| `canSubmit`             | `boolean`        | Whether the composer is currently actionable           |
| `submissionPolicyLabel` | `string`         | Visible explanation of active-turn submission behavior |
| `staleReason`           | `string \| null` | Why a control is no longer actionable                  |

### ArtifactReferenceState

Turn-scoped reference to an artifact shown inside the transcript.

| Attribute      | Type                                                           | Description              |
| -------------- | -------------------------------------------------------------- | ------------------------ |
| `artifactId`   | `string`                                                       | Artifact identity        |
| `kind`         | `string`                                                       | Artifact category        |
| `label`        | `string`                                                       | Operator-visible label   |
| `availability` | `'listed' \| 'loading' \| 'ready' \| 'unavailable' \| 'error'` | Current visibility state |

### EntryControlState

Operator action affordance attached to a visible transcript entry.

| Attribute        | Type                                                                 | Description                                      |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| `controlId`      | `string`                                                             | Stable action identity                           |
| `kind`           | `'submit-follow-up' \| 'cancel' \| 'retry' \| 'branch' \| 'respond'` | Control action type                              |
| `enabled`        | `boolean`                                                            | Whether the control is currently actionable      |
| `reasonDisabled` | `string \| null`                                                     | Operator-visible explanation when not actionable |

## Relationship Summary

```text
WorkspaceState
├── ConversationViewState (many)
│   ├── TranscriptEntryState (many, ordered)
│   │   ├── PromptViewState (optional, nested by owning turn)
│   │   └── ArtifactReferenceState (many)
│   └── ConversationControlState
├── ComposerDraftState (many, keyed by conversation)
├── ArtifactViewState (optional active selection)
└── WorkspaceConnectionState
```

## Entities Consumed but Not Defined Here

- **Conversation**, **Turn**, **StreamEvent**, **ApprovalRequest**, **Artifact** — owned by `packages/web-contracts/`
- **GatewayErrorResponse** and browser-facing transport behavior — owned by `apps/web-gateway/`
- **Session auth lifecycle** — owned by `web-session-auth`
