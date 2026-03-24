/**
 * Safe artifact renderers for the chat workspace.
 *
 * Provides reusable renderer primitives that the later artifact panel (T041)
 * will consume. All content is rendered safely — no raw HTML injection, no
 * dangerouslySetInnerHTML, no active content execution. Every text value
 * passes through React's built-in JSX escaping or the SafeText component.
 *
 * Artifact kinds (from web-contracts): file, diff, patch, test-result, log,
 * plan, structured-data. Content block kinds (workspace-types): text, code,
 * status, structured.
 */

import type { JSX, CSSProperties } from 'react';

import { SafeText } from './safe-text.tsx';
import {
  ARTIFACT_KIND_LABELS,
  artifactKindToLabel,
  classifyArtifactKind,
  isCodeLikeArtifact,
  contentBlockStyle,
} from './artifact-render-utils.ts';
import type {
  ArtifactViewState,
  ContentBlockKind,
  ContentBlockState,
} from '../model/workspace-types.ts';
import type { ArtifactClassification } from './artifact-render-utils.ts';

// Re-export pure utilities so consumers can import from a single module
export {
  ARTIFACT_KIND_LABELS,
  artifactKindToLabel,
  classifyArtifactKind,
  isCodeLikeArtifact,
  contentBlockStyle,
};
export type { ArtifactClassification };

// ─── React components ───────────────────────────────────────────────────────

const BADGE_STYLE: CSSProperties = {
  display: 'inline-block',
  fontSize: '0.75rem',
  fontWeight: 600,
  padding: '0.125rem 0.5rem',
  borderRadius: '0.25rem',
  backgroundColor: 'rgba(128, 128, 128, 0.15)',
  color: 'inherit',
};

export interface ArtifactKindBadgeProps {
  readonly kind: string;
}

/**
 * Small badge showing the artifact kind as a human-readable label.
 */
export function ArtifactKindBadge({ kind }: ArtifactKindBadgeProps): JSX.Element {
  return (
    <span style={BADGE_STYLE} data-testid={`artifact-kind-badge-${kind}`}>
      {artifactKindToLabel(kind)}
    </span>
  );
}

// ─── ArtifactContentBlock ───────────────────────────────────────────────────

export interface ArtifactContentBlockProps {
  readonly kind: ContentBlockKind;
  readonly text: string | null | undefined;
  readonly 'data-testid'?: string;
}

/**
 * Render a single content block safely based on its kind.
 * Code and structured blocks use `<pre>` with monospace; text and status
 * use standard `<div>` wrappers. All text passes through React's built-in
 * JSX escaping — no dangerouslySetInnerHTML.
 */
export function ArtifactContentBlock(props: ArtifactContentBlockProps): JSX.Element {
  const { kind, text } = props;
  const testId = props['data-testid'];
  const style = contentBlockStyle(kind);

  if (kind === 'code' || kind === 'structured') {
    return (
      <pre style={style} data-testid={testId}>
        {text ?? ''}
      </pre>
    );
  }

  if (kind === 'status') {
    return (
      <div style={style} data-testid={testId}>
        <SafeText text={text} />
      </div>
    );
  }

  // Default: text / unknown
  return (
    <div style={style} data-testid={testId}>
      <SafeText text={text} />
    </div>
  );
}

// ─── ArtifactHeader ─────────────────────────────────────────────────────────

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.375rem 0',
};

const LABEL_STYLE: CSSProperties = {
  fontWeight: 600,
  fontSize: '0.875rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const SUMMARY_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  opacity: 0.7,
  marginTop: '0.125rem',
};

export interface ArtifactHeaderProps {
  readonly label: string;
  readonly kind: string;
  readonly summary?: string | null;
}

/**
 * Header bar for an artifact — label, kind badge, and optional summary.
 * All text is rendered through React's safe JSX escaping.
 */
export function ArtifactHeader({ label, kind, summary }: ArtifactHeaderProps): JSX.Element {
  return (
    <div data-testid="artifact-header">
      <div style={HEADER_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        <ArtifactKindBadge kind={kind} />
      </div>
      {summary != null && summary !== '' && (
        <div style={SUMMARY_STYLE} data-testid="artifact-summary">
          <SafeText text={summary} />
        </div>
      )}
    </div>
  );
}

// ─── ArtifactPreview ────────────────────────────────────────────────────────

const PREVIEW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const STATE_MSG_STYLE: CSSProperties = {
  fontStyle: 'italic',
  opacity: 0.6,
  padding: '0.5rem 0',
};

export interface ArtifactPreviewProps {
  readonly artifact: ArtifactViewState;
}

/**
 * Full artifact preview — header + content blocks (or status indicators).
 *
 * Handles availability states: loading, unavailable, error, listed, ready.
 * When ready, renders each preview block through ArtifactContentBlock.
 */
export function ArtifactPreview({ artifact }: ArtifactPreviewProps): JSX.Element {
  const { kind, label, availability, previewBlocks } = artifact;

  return (
    <div style={PREVIEW_STYLE} data-testid="artifact-preview" data-artifact-kind={kind}>
      <ArtifactHeader label={label} kind={kind} />

      {availability === 'loading' && (
        <div style={STATE_MSG_STYLE} data-testid="artifact-loading">
          Loading artifact…
        </div>
      )}

      {availability === 'unavailable' && (
        <div style={STATE_MSG_STYLE} data-testid="artifact-unavailable">
          Artifact is unavailable.
        </div>
      )}

      {availability === 'error' && (
        <div style={STATE_MSG_STYLE} data-testid="artifact-error">
          Failed to load artifact.
        </div>
      )}

      {availability === 'listed' && (
        <div style={STATE_MSG_STYLE} data-testid="artifact-listed">
          Artifact announced — content pending.
        </div>
      )}

      {availability === 'ready' && (
        <>
          {previewBlocks.length === 0 && (
            <div style={STATE_MSG_STYLE} data-testid="artifact-empty">
              No preview available.
            </div>
          )}
          {previewBlocks.map((block: ContentBlockState) => (
            <ArtifactContentBlock
              key={block.blockId}
              kind={block.kind}
              text={block.text}
              data-testid={`artifact-block-${block.blockId}`}
            />
          ))}
        </>
      )}
    </div>
  );
}
