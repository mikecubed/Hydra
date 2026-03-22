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
  TranscriptEntryState,
} from './workspace-types.ts';

// ─── Reconciler state ───────────────────────────────────────────────────────

/** Per-turn high-water mark tracking for duplicate suppression. */
export interface ReconcilerState {
  readonly highWaterSeq: ReadonlyMap<string, number>;
  /**
   * Turns sealed by authoritative REST history. Events for sealed turns are
   * unconditionally treated as stale, preventing post-reconnect replays from
   * mutating entries that REST has already provided in their final form.
   */
  readonly sealedTurns?: ReadonlySet<string>;
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
  return { highWaterSeq: new Map(), sealedTurns: new Set() };
}

// ─── Duplicate detection ────────────────────────────────────────────────────

/**
 * Returns `true` when the event's seq is at or below the high-water mark for
 * its turn, or when the turn has been sealed by an authoritative refresh —
 * meaning it has already been processed and should be skipped.
 */
export function isStaleEvent(event: StreamEvent, state: ReconcilerState): boolean {
  if (state.sealedTurns?.has(event.turnId) === true) return true;
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
  return replaceTurnEntry(withEntry, event.turnId, (e) => ({ ...e, status }));
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
    return { ...e, status: 'failed', contentBlocks: blocks };
  });
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
  const promptId =
    typeof event.payload['approvalId'] === 'string' ? event.payload['approvalId'] : '';

  const withEntry = ensureTurnEntry(entries, event.turnId, event.timestamp);
  return replaceTurnEntry(withEntry, event.turnId, (e) => ({
    ...e,
    prompt: {
      promptId,
      parentTurnId: event.turnId,
      status: 'pending' as const,
      lastResponseSummary: null,
    },
  }));
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
      prompt: { ...e.prompt, status: 'resolved' as const, lastResponseSummary: response },
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
  return replaceTurnEntry(withEntry, event.turnId, (e) => ({ ...e, status: 'cancelled' }));
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
    if (isStaleEvent(event, { highWaterSeq: hwMap, sealedTurns: state.sealedTurns })) continue;

    const prev = current;
    current = applyEvent(current, event);

    // Advance high-water when the event mutated entries, or for kinds that
    // are intentionally no-op (checkpoint). Conditional events like
    // approval-response must not consume seq when they didn't match, so
    // they remain eligible on later replay.
    if (current !== prev || event.kind === 'checkpoint') {
      consumedSeqs.add(event.seq);
      const prevHw = hwMap.get(event.turnId);
      if (prevHw === undefined || event.seq > prevHw) {
        hwMap.set(event.turnId, event.seq);
      }
    }
  }

  return {
    entries: current,
    state: { highWaterSeq: hwMap, sealedTurns: state.sealedTurns },
    consumedSeqs,
  };
}

// ─── Authoritative merge & deduplication ────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * Seal turns whose authoritative status is terminal. Events for sealed turns
 * are unconditionally treated as stale by `isStaleEvent`, preventing
 * post-reconnect replays from mutating entries REST has already finalized.
 */
export function sealAuthoritativeTurns(
  state: ReconcilerState,
  authoritativeEntries: readonly TranscriptEntryState[],
): ReconcilerState {
  const sealed = new Set(state.sealedTurns);
  for (const entry of authoritativeEntries) {
    if (entry.kind === 'turn' && entry.turnId != null && TERMINAL_STATUSES.has(entry.status)) {
      sealed.add(entry.turnId);
    }
  }
  return { ...state, sealedTurns: sealed };
}

/**
 * Merge authoritative REST history with current (stream-reconciled) entries.
 *
 * REST entries form the base. For turns present in both, REST is authoritative
 * for content blocks and status (the server's view is always more current
 * after a reconnect). Stream metadata (artifacts, controls, prompt) is
 * preserved where richer — these are derived from real-time events the
 * server may not include in the REST snapshot.
 *
 * Stream-only entries (turns REST doesn't know about, activity-groups,
 * system-status) are appended at the end.
 */
export function mergeAuthoritativeEntries(
  restEntries: readonly TranscriptEntryState[],
  currentEntries: readonly TranscriptEntryState[],
): readonly TranscriptEntryState[] {
  // Build lookup maps for current (stream-reconciled) entries
  const currentTurnMap = new Map<string | null, TranscriptEntryState>();
  for (const entry of currentEntries) {
    if (entry.kind === 'turn' && entry.turnId != null) {
      currentTurnMap.set(entry.turnId, entry);
    }
  }

  // Merge: REST is base, with stream metadata preserved for matching turns
  const merged: TranscriptEntryState[] = restEntries.map((entry) => {
    if (entry.kind !== 'turn' || entry.turnId == null) return entry;

    const streamed = currentTurnMap.get(entry.turnId);
    if (streamed == null) return entry;

    // REST is authoritative for content and status; preserve richer stream metadata
    return {
      ...entry,
      artifacts: streamed.artifacts.length > 0 ? streamed.artifacts : entry.artifacts,
      controls: streamed.controls.length > 0 ? streamed.controls : entry.controls,
      prompt: streamed.prompt ?? entry.prompt,
    };
  });

  // Track what REST covers for dedup
  const restTurnIds = new Set<string | null>();
  const restEntryIds = new Set<string>();
  for (const entry of merged) {
    if (entry.turnId != null) restTurnIds.add(entry.turnId);
    restEntryIds.add(entry.entryId);
  }

  // Append stream-only entries (in-flight turns, activity groups, etc.)
  for (const entry of currentEntries) {
    if (entry.kind === 'turn') {
      if (!restTurnIds.has(entry.turnId)) {
        merged.push(entry);
      }
    } else {
      if (!restEntryIds.has(entry.entryId)) {
        merged.push(entry);
      }
    }
  }

  return merged;
}

/**
 * Remove duplicate entries, keeping the first occurrence of each turn
 * (by `turnId`) and each non-turn entry (by `entryId`).
 *
 * Intended as a safety net — correctly merged entries should already be
 * unique. First-occurrence wins because authoritative REST entries precede
 * stream-only entries in a merged array.
 */
export function deduplicateEntries(
  entries: readonly TranscriptEntryState[],
): readonly TranscriptEntryState[] {
  const seenTurnIds = new Set<string>();
  const seenEntryIds = new Set<string>();

  return entries.filter((entry) => {
    // Turn-entry dedup: by turnId
    if (entry.kind === 'turn' && entry.turnId != null) {
      if (seenTurnIds.has(entry.turnId)) return false;
      seenTurnIds.add(entry.turnId);
    }

    // General entryId dedup for all entry kinds
    if (seenEntryIds.has(entry.entryId)) return false;
    seenEntryIds.add(entry.entryId);

    return true;
  });
}
