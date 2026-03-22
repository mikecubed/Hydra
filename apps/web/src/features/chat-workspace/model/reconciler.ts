/**
 * Stream reconciler — deterministic, duplicate-safe merge of stream events into
 * transcript entry state.
 *
 * Pure model logic with no side effects. Designed for both live streaming and
 * replay scenarios. Seq-based high-water marks provide per-turn duplicate
 * suppression so replayed or re-delivered events are safely ignored.
 *
 * @module reconciler
 */

import type { StreamEvent } from '@hydra/web-contracts';

import type {
  ArtifactReferenceState,
  ContentBlockState,
  PromptViewState,
  TranscriptEntryState,
} from './workspace-types.ts';

// ─── Reconciler state ───────────────────────────────────────────────────────

/** Per-turn high-water mark tracking for duplicate suppression. */
export interface ReconcilerState {
  readonly highWaterSeq: ReadonlyMap<string, number>;
}

/** Result of a reconciliation pass. */
export interface ReconcileResult {
  readonly entries: readonly TranscriptEntryState[];
  readonly state: ReconcilerState;
  /**
   * Seq numbers of events that were actually consumed (mutated entries or
   * are explicit protocol no-ops like `checkpoint`). Ignored conditional
   * events (e.g. mismatched approval-response) are excluded so callers
   * can avoid advancing ack watermarks past unconsumed events.
   */
  readonly consumedSeqs: ReadonlySet<number>;
}

export function createReconcilerState(): ReconcilerState {
  return { highWaterSeq: new Map() };
}

// ─── Duplicate detection ────────────────────────────────────────────────────

/**
 * Returns `true` when the event's seq is at or below the high-water mark for
 * its turn — meaning it has already been processed and should be skipped.
 */
export function isStaleEvent(event: StreamEvent, state: ReconcilerState): boolean {
  const hw = state.highWaterSeq.get(event.turnId);
  return hw !== undefined && event.seq <= hw;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Find the first canonical `kind: 'turn'` entry matching a turnId. */
export function findEntryByTurnId(
  entries: readonly TranscriptEntryState[],
  turnId: string,
): TranscriptEntryState | undefined {
  return entries.find((e) => e.kind === 'turn' && e.turnId === turnId);
}

/**
 * Append a text delta to an entry's content block.
 *
 * When `blockId` is provided the matching block is updated (or a new one
 * appended). When omitted a default `${turnId}-streaming` block is used.
 */
export function appendTextDelta(
  entry: TranscriptEntryState,
  text: string,
  blockId?: string,
): TranscriptEntryState {
  const resolvedBlockId = blockId ?? `${String(entry.turnId)}-streaming`;
  const existingIdx = entry.contentBlocks.findIndex((b) => b.blockId === resolvedBlockId);

  if (existingIdx >= 0) {
    const block = entry.contentBlocks[existingIdx];
    const updated: ContentBlockState = {
      ...block,
      text: (block.text ?? '') + text,
    };
    const blocks = [...entry.contentBlocks];
    blocks[existingIdx] = updated;
    return { ...entry, contentBlocks: blocks };
  }

  const newBlock: ContentBlockState = {
    blockId: resolvedBlockId,
    kind: 'text',
    text,
    metadata: null,
  };
  return { ...entry, contentBlocks: [...entry.contentBlocks, newBlock] };
}

// ─── Internal entry helpers ─────────────────────────────────────────────────

function createStreamingEntry(
  turnId: string,
  timestamp: string,
  attribution?: string,
): TranscriptEntryState {
  return {
    entryId: turnId,
    kind: 'turn',
    turnId,
    attributionLabel: attribution ?? null,
    status: 'streaming',
    timestamp,
    contentBlocks: [],
    artifacts: [],
    controls: [],
    prompt: null,
  };
}

/**
 * Replace the canonical `kind: 'turn'` entry for the given turnId.
 * Non-turn entries (e.g. activity-group) sharing the same turnId are untouched.
 */
function replaceTurnEntry(
  entries: readonly TranscriptEntryState[],
  turnId: string,
  updater: (entry: TranscriptEntryState) => TranscriptEntryState,
): readonly TranscriptEntryState[] {
  return entries.map((e) => (e.kind === 'turn' && e.turnId === turnId ? updater(e) : e));
}

function ensureTurnEntry(
  entries: readonly TranscriptEntryState[],
  turnId: string,
  timestamp: string,
): readonly TranscriptEntryState[] {
  if (findEntryByTurnId(entries, turnId)) return entries;
  return [...entries, createStreamingEntry(turnId, timestamp)];
}

// ─── Per-kind event applicators ─────────────────────────────────────────────

function applyStreamStarted(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  if (findEntryByTurnId(entries, event.turnId)) {
    return replaceTurnEntry(entries, event.turnId, (e) => ({ ...e, status: 'streaming' }));
  }
  const attribution =
    typeof event.payload['attribution'] === 'string' ? event.payload['attribution'] : undefined;
  return [...entries, createStreamingEntry(event.turnId, event.timestamp, attribution)];
}

function applyTextDelta(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const text = typeof event.payload['text'] === 'string' ? event.payload['text'] : '';
  const blockId =
    typeof event.payload['blockId'] === 'string' ? event.payload['blockId'] : undefined;
  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => appendTextDelta(e, text, blockId));
}

function applyStatusChange(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const status = typeof event.payload['status'] === 'string' ? event.payload['status'] : 'unknown';
  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => ({ ...e, status }));
}

function applyStreamCompleted(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const status =
    typeof event.payload['status'] === 'string' ? event.payload['status'] : 'completed';
  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => ({
    ...e,
    status,
    prompt: markPromptStale(e.prompt),
  }));
}

function applyStreamFailed(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => {
    const reason =
      (typeof event.payload['reason'] === 'string' ? event.payload['reason'] : null) ??
      (typeof event.payload['error'] === 'string' ? event.payload['error'] : null) ??
      (typeof event.payload['message'] === 'string' ? event.payload['message'] : null);
    const blocks: ContentBlockState[] = [...e.contentBlocks];
    if (reason !== null) {
      blocks.push({
        blockId: `${event.turnId}-error`,
        kind: 'status',
        text: reason,
        metadata: null,
      });
    }
    return {
      ...e,
      status: 'failed',
      contentBlocks: blocks,
      prompt: markPromptStale(e.prompt),
    };
  });
}

function filterStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseContextBlocks(value: unknown): readonly ContentBlockState[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const blocks: ContentBlockState[] = [];
  for (const block of value) {
    if (
      !isRecord(block) ||
      typeof block['blockId'] !== 'string' ||
      typeof block['kind'] !== 'string'
    ) {
      continue;
    }

    blocks.push({
      blockId: block['blockId'],
      kind:
        block['kind'] === 'code' || block['kind'] === 'status' || block['kind'] === 'structured'
          ? block['kind']
          : 'text',
      text: typeof block['text'] === 'string' ? block['text'] : null,
      metadata: isRecord(block['metadata'])
        ? Object.fromEntries(
            Object.entries(block['metadata']).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : null,
    });
  }
  return blocks;
}

function createPromptState(event: StreamEvent): PromptViewState | null {
  const raw = event.payload['approvalId'];
  if (typeof raw !== 'string' || raw === '') {
    return null;
  }
  return {
    promptId: raw,
    parentTurnId: event.turnId,
    status: 'pending',
    allowedResponses: filterStringArray(event.payload['allowedResponses']).map((key) => ({
      key,
      label: key,
    })),
    contextBlocks: parseContextBlocks(event.payload['contextBlocks']),
    lastResponseSummary: null,
    errorMessage: null,
    staleReason: null,
  };
}

function markPromptStale(prompt: PromptViewState | null): PromptViewState | null {
  if (prompt == null) {
    return null;
  }

  if (prompt.status !== 'pending' && prompt.status !== 'responding') {
    return prompt;
  }

  return {
    ...prompt,
    status: 'stale',
    staleReason: null,
  };
}

function applyActivityMarker(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const description =
    typeof event.payload['description'] === 'string' ? event.payload['description'] : '';
  const activityId = `${event.turnId}-activity`;
  const newBlock: ContentBlockState = {
    blockId: `${activityId}-${String(event.seq)}`,
    kind: 'status',
    text: description,
    metadata: null,
  };

  const existing = entries.find((e) => e.kind === 'activity-group' && e.turnId === event.turnId);
  if (existing) {
    return entries.map((e) =>
      e.kind === 'activity-group' && e.turnId === event.turnId
        ? { ...e, contentBlocks: [...e.contentBlocks, newBlock] }
        : e,
    );
  }

  const activityEntry: TranscriptEntryState = {
    entryId: activityId,
    kind: 'activity-group',
    turnId: event.turnId,
    status: 'active',
    timestamp: event.timestamp,
    contentBlocks: [newBlock],
    artifacts: [],
    controls: [],
    prompt: null,
  };
  return [...entries, activityEntry];
}

function applyApprovalPrompt(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const prompt = createPromptState(event);
  if (prompt == null) {
    return entries;
  }
  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => ({
    ...e,
    prompt,
  }));
}

function isConsumedNoopEvent(event: StreamEvent): boolean {
  if (event.kind === 'checkpoint') {
    return true;
  }

  if (event.kind === 'approval-prompt') {
    return createPromptState(event) == null;
  }

  return false;
}

function applyApprovalResponse(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const existing = findEntryByTurnId(entries, event.turnId);
  if (!existing?.prompt) return entries;

  const approvalId =
    typeof event.payload['approvalId'] === 'string' ? event.payload['approvalId'] : '';
  if (existing.prompt.promptId !== approvalId) return entries;

  const response = typeof event.payload['response'] === 'string' ? event.payload['response'] : null;
  return replaceTurnEntry(entries, event.turnId, (e) => {
    if (!e.prompt) return e;
    return {
      ...e,
      prompt: {
        ...e.prompt,
        status: 'resolved',
        lastResponseSummary: response,
        errorMessage: null,
      },
    };
  });
}

function applyArtifactNotice(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const artifactId =
    typeof event.payload['artifactId'] === 'string' ? event.payload['artifactId'] : '';
  const kind = typeof event.payload['kind'] === 'string' ? event.payload['kind'] : 'unknown';
  const label = typeof event.payload['label'] === 'string' ? event.payload['label'] : '';

  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => {
    const existingIdx = e.artifacts.findIndex((a) => a.artifactId === artifactId);
    const ref: ArtifactReferenceState = { artifactId, kind, label, availability: 'listed' };

    if (existingIdx >= 0) {
      const artifacts = [...e.artifacts];
      artifacts[existingIdx] = ref;
      return { ...e, artifacts };
    }
    return { ...e, artifacts: [...e.artifacts, ref] };
  });
}

function applyCancellation(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => ({
    ...e,
    status: 'cancelled',
    prompt: markPromptStale(e.prompt),
  }));
}

function applySystemNotice(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
  noticeStatus: string,
): readonly TranscriptEntryState[] {
  const message = typeof event.payload['message'] === 'string' ? event.payload['message'] : '';
  const sysEntry: TranscriptEntryState = {
    entryId: `${event.turnId}-${event.kind}-${String(event.seq)}`,
    kind: 'system-status',
    turnId: event.turnId,
    status: noticeStatus,
    timestamp: event.timestamp,
    contentBlocks: [
      {
        blockId: `${event.turnId}-${event.kind}-${String(event.seq)}-msg`,
        kind: 'status',
        text: message,
        metadata: null,
      },
    ],
    artifacts: [],
    controls: [],
    prompt: null,
  };
  return [...entries, sysEntry];
}

// ─── Event dispatch ─────────────────────────────────────────────────────────

/** Compile-time exhaustiveness check. Throws at runtime if reached. */
function assertNeverEventKind(kind: never): never {
  throw new Error(`Unhandled stream event kind: ${String(kind)}`);
}

function applyEvent(
  entries: readonly TranscriptEntryState[],
  event: StreamEvent,
): readonly TranscriptEntryState[] {
  switch (event.kind) {
    case 'stream-started':
      return applyStreamStarted(entries, event);
    case 'text-delta':
      return applyTextDelta(entries, event);
    case 'status-change':
      return applyStatusChange(entries, event);
    case 'stream-completed':
      return applyStreamCompleted(entries, event);
    case 'stream-failed':
      return applyStreamFailed(entries, event);
    case 'activity-marker':
      return applyActivityMarker(entries, event);
    case 'approval-prompt':
      return applyApprovalPrompt(entries, event);
    case 'approval-response':
      return applyApprovalResponse(entries, event);
    case 'artifact-notice':
      return applyArtifactNotice(entries, event);
    case 'cancellation':
      return applyCancellation(entries, event);
    case 'warning':
      return applySystemNotice(entries, event, 'warning');
    case 'error':
      return applySystemNotice(entries, event, 'error');
    case 'checkpoint':
      return entries;
    default:
      return assertNeverEventKind(event.kind);
  }
}

// ─── Core reconciliation ────────────────────────────────────────────────────

/**
 * Reconcile a batch of stream events against existing transcript entries.
 *
 * Events are applied sequentially. Stale events (seq ≤ per-turn high-water
 * mark) are silently dropped. The returned state carries updated high-water
 * marks for subsequent calls.
 */
export function reconcileStreamEvents(
  entries: readonly TranscriptEntryState[],
  events: readonly StreamEvent[],
  state: ReconcilerState,
): ReconcileResult {
  if (events.length === 0) return { entries, state, consumedSeqs: new Set() };

  let current = entries;
  const hwMap = new Map(state.highWaterSeq);
  const consumedSeqs = new Set<number>();

  for (const event of events) {
    if (isStaleEvent(event, { highWaterSeq: hwMap })) continue;

    const prev = current;
    current = applyEvent(current, event);

    // Advance high-water when the event mutated entries, or for kinds that
    // are intentionally consumed no-ops. Conditional events like
    // approval-response must not consume seq when they didn't match, so
    // they remain eligible on later replay.
    if (current !== prev || isConsumedNoopEvent(event)) {
      consumedSeqs.add(event.seq);
      const prevHw = hwMap.get(event.turnId);
      if (prevHw === undefined || event.seq > prevHw) {
        hwMap.set(event.turnId, event.seq);
      }
    }
  }

  return { entries: current, state: { highWaterSeq: hwMap }, consumedSeqs };
}
