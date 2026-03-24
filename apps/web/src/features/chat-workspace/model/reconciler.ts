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
  EntryControlKind,
  EntryControlState,
  PromptResponseChoiceState,
  PromptStatus,
  PromptViewState,
  TranscriptEntryState,
} from './workspace-types.ts';
import { mergePromptState } from './prompt-merge.ts';

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

  const nextText = trimAuthoritativeReplayOverlap(entry, resolvedBlockId, text, blockId);
  if (nextText.length === 0) {
    return entry;
  }

  const newBlock: ContentBlockState = {
    blockId: resolvedBlockId,
    kind: 'text',
    text: nextText,
    metadata: null,
  };
  return { ...entry, contentBlocks: [...entry.contentBlocks, newBlock] };
}

function trimAuthoritativeReplayOverlap(
  entry: TranscriptEntryState,
  resolvedBlockId: string,
  text: string,
  explicitBlockId: string | undefined,
): string {
  if (explicitBlockId !== undefined || entry.status !== 'streaming') {
    return text;
  }

  const authoritativeBlock = entry.contentBlocks.find(
    (block) => block.kind === 'text' && block.blockId === `${String(entry.turnId)}-response`,
  );
  if (authoritativeBlock?.text == null || authoritativeBlock.text.length === 0) {
    return text;
  }

  const authoritativeText = authoritativeBlock.text;
  if (resolvedBlockId !== `${String(entry.turnId)}-streaming`) {
    return text;
  }

  if (authoritativeText.endsWith(text)) {
    return '';
  }

  const overlap = resolveTextOverlap(authoritativeText, text);
  return overlap === 0 ? text : text.slice(overlap);
}

function resolveTextOverlap(authoritativeText: string, text: string): number {
  const maxOverlap = Math.min(authoritativeText.length, text.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (authoritativeText.endsWith(text.slice(0, overlap))) {
      return overlap;
    }
  }
  return 0;
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

/** Resolve operator-facing label for a response key from allowedResponses. */
function resolveLabel(
  allowedResponses: readonly PromptResponseChoiceState[],
  responseKey: string,
): string {
  for (const choice of allowedResponses) {
    if (typeof choice === 'string') {
      if (choice === responseKey) return choice;
    } else if (choice.key === responseKey) {
      return choice.label;
    }
  }
  return responseKey;
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
    const summary = response == null ? null : resolveLabel(e.prompt.allowedResponses, response);
    return {
      ...e,
      prompt: {
        ...e.prompt,
        status: 'resolved',
        lastResponseSummary: summary,
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
    if (isStaleEvent(event, { highWaterSeq: hwMap, sealedTurns: state.sealedTurns })) continue;

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

  return {
    entries: current,
    state: { highWaterSeq: hwMap, sealedTurns: state.sealedTurns },
    consumedSeqs,
  };
}

// ─── Authoritative merge & deduplication ────────────────────────────────────

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

function mergeTerminalControls(
  restControls: readonly EntryControlState[],
  streamedControls: readonly EntryControlState[],
): readonly EntryControlState[] {
  const mergedByKind = new Map<EntryControlKind, EntryControlState>();

  for (const control of streamedControls) {
    if (control.kind === 'cancel') {
      continue;
    }

    mergedByKind.set(control.kind, control);
  }

  for (const control of restControls) {
    mergedByKind.set(control.kind, control);
  }

  return [...mergedByKind.values()];
}

/** Prompt statuses that should not survive terminal REST turns unchanged. */
const ACTIONABLE_PROMPT_STATUSES: ReadonlySet<PromptStatus> = new Set([
  'pending',
  'responding',
  'error',
]);

/**
 * When a REST turn is terminal, an actionable prompt from the stream is stale
 * and must not survive the merge — otherwise the UI would show a pending prompt
 * card on a completed/failed/cancelled turn after reconnect or refresh.
 *
 * Terminal/resolved prompts are preserved as-is (informational, no action).
 */
function coercePromptForTerminalTurn(
  prompt: PromptViewState | null,
  restIsTerminal: boolean,
): PromptViewState | null {
  if (!restIsTerminal || prompt == null) return prompt;
  if (!ACTIONABLE_PROMPT_STATUSES.has(prompt.status)) return prompt;
  return { ...prompt, status: 'stale', staleReason: 'turn-completed' };
}

/**
 * Compute a simple richness metric for the content blocks of a turn entry.
 * Used to break ties when both REST and streamed entries are non-terminal —
 * the entry with more total text content wins, as it is likely the more
 * up-to-date snapshot.
 */
function contentRichness(entry: TranscriptEntryState): number {
  let total = 0;
  for (const block of entry.contentBlocks) {
    if (block.text != null) {
      total += block.text.length;
    }
  }
  return total;
}

/**
 * Non-terminal status rank for lifecycle progression ordering. Higher rank
 * means the turn has progressed further. Used to avoid downgrading a live
 * streamed status badge when REST content is richer.
 */
const NON_TERMINAL_RANK: ReadonlyMap<string, number> = new Map([
  ['submitted', 0],
  ['executing', 1],
  ['streaming', 1],
]);

/** Returns true when `a` represents a strictly more advanced non-terminal status than `b`. */
function isStrictlyMoreAdvanced(a: string, b: string): boolean {
  return (NON_TERMINAL_RANK.get(a) ?? 0) > (NON_TERMINAL_RANK.get(b) ?? 0);
}

function shouldPreserveStreamedTurn(
  restEntry: TranscriptEntryState,
  streamedEntry: TranscriptEntryState,
): boolean {
  const restTerminal = TERMINAL_STATUSES.has(restEntry.status);
  const streamedTerminal = TERMINAL_STATUSES.has(streamedEntry.status);

  if (restTerminal) {
    return false;
  }

  if (streamedTerminal) {
    return true;
  }

  // Both non-terminal: prefer whichever has richer content, falling back to
  // streamed when equal (stream is the live source during normal operation).
  return contentRichness(streamedEntry) >= contentRichness(restEntry);
}

function shouldPreserveStreamedStatus(
  restStatus: string,
  streamedStatus: string,
  preserveStreamedTurn: boolean,
): boolean {
  const restTerminal = TERMINAL_STATUSES.has(restStatus);
  const streamedTerminal = TERMINAL_STATUSES.has(streamedStatus);

  if (restTerminal) {
    return false;
  }

  if (streamedTerminal) {
    return true;
  }

  if (isStrictlyMoreAdvanced(restStatus, streamedStatus)) {
    return false;
  }

  if (isStrictlyMoreAdvanced(streamedStatus, restStatus)) {
    return true;
  }

  return preserveStreamedTurn;
}

/**
 * Seal turns whose authoritative status is terminal. Events for sealed turns
 * are unconditionally treated as stale by `isStaleEvent`, preventing
 * post-reconnect replays from mutating entries REST has already finalized.
 *
 * Returns the original `state` by reference when nothing new is sealed,
 * so callers can use `===` to detect no-ops.
 */
export function sealAuthoritativeTurns(
  state: ReconcilerState,
  authoritativeEntries: readonly TranscriptEntryState[],
): ReconcilerState {
  const existing = state.sealedTurns;
  let sealed: Set<string> | undefined;

  for (const entry of authoritativeEntries) {
    if (entry.kind === 'turn' && entry.turnId != null && TERMINAL_STATUSES.has(entry.status)) {
      if (existing?.has(entry.turnId) === true) continue;
      sealed ??= new Set(existing);
      sealed.add(entry.turnId);
    }
  }

  if (sealed === undefined) return state;
  return { ...state, sealedTurns: sealed };
}

/**
 * Merge authoritative REST history with current (stream-reconciled) entries.
 *
 * REST entries form the base ordering. For turns present in both sources
 * the merge strategy depends on whether the REST turn is terminal
 * (completed / failed / cancelled):
 *
 *  - **Terminal REST turns** are fully authoritative — REST status and
 *    contentBlocks replace the streamed versions.
 *  - **Non-terminal REST turns** compare content richness (total text length)
 *    between REST and streamed entries. The richer content source wins. Status
 *    is evaluated independently — the more advanced non-terminal status is kept
 *    to avoid downgrading a live streamed badge (e.g. 'streaming' → 'submitted').
 *
 * In both cases, stream metadata (artifacts, controls, prompt) is kept
 * where richer — these are derived from real-time events the server may
 * not include in the REST snapshot.
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

    const preserveStreamedTurn = shouldPreserveStreamedTurn(entry, streamed);

    // When REST content is richer (preserveStreamedTurn=false) but both are
    // non-terminal, the streamed status may still be more advanced. Preserve
    // it to avoid downgrading live status badges (e.g. 'streaming' → 'submitted').
    const preserveStreamedStatus = shouldPreserveStreamedStatus(
      entry.status,
      streamed.status,
      preserveStreamedTurn,
    );

    let controls = entry.controls;
    if (streamed.controls.length > 0) {
      controls = TERMINAL_STATUSES.has(entry.status)
        ? mergeTerminalControls(entry.controls, streamed.controls)
        : streamed.controls;
    }

    return {
      ...entry,
      status: preserveStreamedStatus ? streamed.status : entry.status,
      contentBlocks: preserveStreamedTurn ? streamed.contentBlocks : entry.contentBlocks,
      artifacts: streamed.artifacts.length > 0 ? streamed.artifacts : entry.artifacts,
      controls,
      prompt: coercePromptForTerminalTurn(
        mergePromptState(streamed.prompt, entry.prompt),
        TERMINAL_STATUSES.has(entry.status),
      ),
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

// ─── Multi-session convergence ──────────────────────────────────────────────

/** Summary of turn-status changes between pre-merge and post-merge entries. */
export interface ConvergenceDrift {
  readonly turnStatusChanges: ReadonlyMap<string, { readonly from: string; readonly to: string }>;
  readonly hasExternalChanges: boolean;
}

/**
 * Detect convergence drift by comparing turn statuses before and after an
 * authoritative merge.
 *
 * Only tracks turns that existed in both snapshots and transitioned from a
 * non-terminal status to a terminal one. Routine non-terminal lifecycle
 * progress (for example `submitted -> executing`) is expected during normal
 * convergence and must not be treated as an external invalidation event.
 */
export function detectConvergenceDrift(
  beforeEntries: readonly TranscriptEntryState[],
  afterEntries: readonly TranscriptEntryState[],
): ConvergenceDrift {
  const beforeMap = new Map<string, string>();
  for (const e of beforeEntries) {
    if (e.kind === 'turn' && e.turnId != null) {
      beforeMap.set(e.turnId, e.status);
    }
  }

  const turnStatusChanges = new Map<string, { from: string; to: string }>();
  for (const e of afterEntries) {
    if (e.kind !== 'turn' || e.turnId == null) continue;
    const beforeStatus = beforeMap.get(e.turnId);
    if (
      beforeStatus != null &&
      beforeStatus !== e.status &&
      !TERMINAL_STATUSES.has(beforeStatus) &&
      TERMINAL_STATUSES.has(e.status)
    ) {
      turnStatusChanges.set(e.turnId, { from: beforeStatus, to: e.status });
    }
  }

  return {
    turnStatusChanges,
    hasExternalChanges: turnStatusChanges.size > 0,
  };
}

const STALE_CONTROL_REASON = 'Already acted on in another session';

/**
 * After an authoritative merge, entry-level controls that reference actions
 * no longer valid must be explicitly disabled with a reason rather than
 * silently stripped, so the operator understands why controls are unavailable.
 *
 * The merge algorithm (`mergeTerminalControls`) strips cancel controls from
 * terminal turns. This function restores them as disabled with an explicit
 * reason, and disables any other enabled controls that became stale.
 *
 * - Turns that transitioned to terminal have their enabled controls disabled.
 * - Controls that were present in `previousEntries` but stripped during merge
 *   are re-added as disabled with a stale reason.
 * - Already-disabled controls are preserved as-is.
 * - Non-terminal entries are untouched.
 *
 * Returns `mergedEntries` by reference when no changes are needed.
 */
export function invalidateStaleEntryControls(
  previousEntries: readonly TranscriptEntryState[],
  mergedEntries: readonly TranscriptEntryState[],
): readonly TranscriptEntryState[] {
  // Build maps for previous turn entries (status + controls)
  const prevTurnMap = new Map<string, TranscriptEntryState>();
  for (const e of previousEntries) {
    if (e.kind === 'turn' && e.turnId != null) {
      prevTurnMap.set(e.turnId, e);
    }
  }

  // Find turns that changed to terminal
  const changedToTerminal = new Set<string>();
  for (const e of mergedEntries) {
    if (e.kind !== 'turn' || e.turnId == null) continue;
    if (!TERMINAL_STATUSES.has(e.status)) continue;
    const prev = prevTurnMap.get(e.turnId);
    // Only invalidate controls on turns that existed before and were non-terminal
    if (prev != null && !TERMINAL_STATUSES.has(prev.status)) {
      changedToTerminal.add(e.turnId);
    }
  }

  if (changedToTerminal.size === 0) return mergedEntries;

  const result = mergedEntries.map((entry) => {
    if (entry.kind !== 'turn' || entry.turnId == null) return entry;
    if (!changedToTerminal.has(entry.turnId)) return entry;

    const prev = prevTurnMap.get(entry.turnId);
    const prevControlsByKind = new Map<EntryControlKind, EntryControlState>();
    if (prev != null) {
      for (const c of prev.controls) {
        prevControlsByKind.set(c.kind, c);
      }
    }

    // Disable any still-enabled controls
    const updatedControls: EntryControlState[] = entry.controls.map((control) =>
      control.enabled
        ? { ...control, enabled: false, reasonDisabled: STALE_CONTROL_REASON }
        : control,
    );

    // Build set of control kinds present after merge
    const mergedKinds = new Set(entry.controls.map((c) => c.kind));

    // Re-add controls that were present before but stripped during merge
    for (const [kind, prevControl] of prevControlsByKind) {
      if (!mergedKinds.has(kind)) {
        updatedControls.push({
          ...prevControl,
          enabled: false,
          reasonDisabled: STALE_CONTROL_REASON,
        });
      }
    }

    const controlsChanged =
      updatedControls.length !== entry.controls.length ||
      updatedControls.some((c, i) => c !== entry.controls[i]);

    if (!controlsChanged) return entry;

    return { ...entry, controls: updatedControls };
  });

  return result.some((entry, index) => entry !== mergedEntries[index]) ? result : mergedEntries;
}
