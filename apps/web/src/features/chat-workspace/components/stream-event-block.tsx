/**
 * StreamEventBlock — renders a single stream event as a self-contained block.
 *
 * Covers the initial stream-event vocabulary defined in `@hydra/web-contracts`:
 * text-delta, status-change, stream lifecycle (started/completed/failed),
 * error, warning, activity-marker, artifact-notice, cancellation, checkpoint,
 * and approval events.
 *
 * All text content is rendered through SafeText — no raw HTML injection.
 * Visual patterns are aligned with TranscriptTurn (inline styles, dark theme).
 */

import type { JSX } from 'react';
import type { StreamEventKind } from '@hydra/web-contracts';

import { SafeText } from '../render/safe-text.tsx';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StreamEventData {
  readonly seq: number;
  readonly turnId: string;
  readonly kind: StreamEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export interface StreamEventBlockProps {
  readonly event: StreamEventData;
}

// ─── Styles (aligned with transcript-turn.tsx patterns) ─────────────────────

const blockStyle = {
  border: '1px solid rgba(148, 163, 184, 0.1)',
  borderRadius: '0.375rem',
  background: 'rgba(30, 41, 59, 0.4)',
  padding: '0.5rem 0.75rem',
  display: 'grid',
  gap: '0.25rem',
  fontSize: '0.875rem',
} as const;

const kindBadgeStyle = {
  display: 'inline-block',
  background: 'rgba(148, 163, 184, 0.15)',
  borderRadius: '0.25rem',
  padding: '0.1rem 0.4rem',
  fontSize: '0.75rem',
  fontFamily: 'monospace',
  color: '#94a3b8',
} as const;

const statusBadgeStyle = {
  ...kindBadgeStyle,
  background: 'rgba(56, 189, 248, 0.15)',
  color: '#38bdf8',
} as const;

const errorStyle = {
  color: '#f87171',
  lineHeight: 1.5,
} as const;

const warningStyle = {
  color: '#fbbf24',
  lineHeight: 1.5,
} as const;

const textStyle = {
  margin: 0,
  lineHeight: 1.6,
} as const;

const muted = {
  color: '#94a3b8',
  fontSize: '0.8rem',
} as const;

// ─── Payload accessors (safe string extraction) ────────────────────────────

function payloadString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

// ─── Per-kind renderers ─────────────────────────────────────────────────────

function TextDeltaBody({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const text = payloadString(payload, 'text');
  return (
    <div style={textStyle}>
      <SafeText text={text} />
    </div>
  );
}

function StatusChangeBody({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const status = payloadString(payload, 'status');
  const message = payloadString(payload, 'message');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      {status != null && <span style={statusBadgeStyle}>{status}</span>}
      {message != null && <SafeText text={message} />}
    </div>
  );
}

function ErrorBody({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const message = payloadString(payload, 'message') ?? payloadString(payload, 'error');
  return (
    <div style={errorStyle}>
      <SafeText text={message} />
    </div>
  );
}

function WarningBody({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const message = payloadString(payload, 'message');
  return (
    <div style={warningStyle}>
      <SafeText text={message} />
    </div>
  );
}

function ActivityMarkerBody({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const summary = payloadString(payload, 'summary');
  return (
    <div style={muted}>
      <SafeText text={summary} />
    </div>
  );
}

function ArtifactNoticeBody({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const label = payloadString(payload, 'label');
  const artifactKind = payloadString(payload, 'artifactKind');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      {artifactKind != null && <span style={kindBadgeStyle}>{artifactKind}</span>}
      {label != null && <SafeText text={label} />}
    </div>
  );
}

function StreamFailedBody({
  payload,
}: {
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const error = payloadString(payload, 'error') ?? payloadString(payload, 'message');
  return (
    <div style={errorStyle}>
      <SafeText text={error} />
    </div>
  );
}

// ─── Body dispatcher ────────────────────────────────────────────────────────

function EventBody({
  kind,
  payload,
}: {
  readonly kind: StreamEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}): JSX.Element | null {
  switch (kind) {
    case 'text-delta':
      return <TextDeltaBody payload={payload} />;
    case 'status-change':
      return <StatusChangeBody payload={payload} />;
    case 'error':
      return <ErrorBody payload={payload} />;
    case 'warning':
      return <WarningBody payload={payload} />;
    case 'stream-failed':
      return <StreamFailedBody payload={payload} />;
    case 'activity-marker':
      return <ActivityMarkerBody payload={payload} />;
    case 'artifact-notice':
      return <ArtifactNoticeBody payload={payload} />;
    case 'stream-started':
    case 'stream-completed':
    case 'checkpoint':
    case 'cancellation':
    case 'approval-prompt':
    case 'approval-response':
      return null;
    default:
      return null;
  }
}

// ─── Main component ─────────────────────────────────────────────────────────

export function StreamEventBlock({ event }: StreamEventBlockProps): JSX.Element {
  return (
    <article style={blockStyle} data-event-kind={event.kind} data-seq={String(event.seq)}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={kindBadgeStyle}>{event.kind}</span>
      </header>
      <EventBody kind={event.kind} payload={event.payload} />
    </article>
  );
}
