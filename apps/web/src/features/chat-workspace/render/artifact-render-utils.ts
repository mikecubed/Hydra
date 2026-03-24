/**
 * Pure utility functions for artifact rendering.
 *
 * These functions are framework-agnostic (no React/JSX) and can be imported
 * by both the React renderer components and Node.js-native unit tests.
 */

import type { CSSProperties } from 'react';

import type { ContentBlockKind } from '../model/workspace-types.ts';

// ─── Kind labels ────────────────────────────────────────────────────────────

/**
 * Human-readable labels for every contract-defined artifact kind.
 */
export const ARTIFACT_KIND_LABELS: Readonly<Record<string, string>> = {
  file: 'File',
  diff: 'Diff',
  patch: 'Patch',
  'test-result': 'Test Result',
  log: 'Log',
  plan: 'Plan',
  'structured-data': 'Structured Data',
};

/**
 * Return a human-readable label for an artifact kind.
 * Falls back to title-casing the raw kind string for unknown kinds.
 */
export function artifactKindToLabel(kind: string): string {
  if (kind in ARTIFACT_KIND_LABELS) {
    return ARTIFACT_KIND_LABELS[kind]!;
  }
  if (kind === '') return '';
  return kind
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Kind classification ────────────────────────────────────────────────────

/** Rendering strategy classification for artifact kinds. */
export type ArtifactClassification = 'code' | 'prose' | 'data';

const KIND_CLASSIFICATION: Readonly<Record<string, ArtifactClassification>> = {
  file: 'code',
  diff: 'code',
  patch: 'code',
  log: 'code',
  'test-result': 'data',
  'structured-data': 'data',
  plan: 'prose',
};

/**
 * Classify an artifact kind into a rendering strategy.
 * - `code` — monospace, pre-formatted (file, diff, patch, log)
 * - `data` — monospace structured display (test-result, structured-data)
 * - `prose` — standard text flow (plan, unknown)
 */
export function classifyArtifactKind(kind: string): ArtifactClassification {
  return KIND_CLASSIFICATION[kind] ?? 'prose';
}

/**
 * Returns true if the artifact kind should use code-like (monospace) rendering.
 */
export function isCodeLikeArtifact(kind: string): boolean {
  return classifyArtifactKind(kind) === 'code';
}

// ─── Content block styles ───────────────────────────────────────────────────

const CODE_STYLE: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '0.875rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '0.5rem',
  overflow: 'auto',
};

const TEXT_STYLE: CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '0.25rem 0',
};

const STATUS_STYLE: CSSProperties = {
  whiteSpace: 'pre-wrap',
  fontStyle: 'italic',
  opacity: 0.7,
  margin: 0,
  padding: '0.25rem 0',
};

const STRUCTURED_STYLE: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '0.875rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '0.5rem',
  overflow: 'auto',
};

/**
 * Return the inline style object for a given content block kind.
 */
export function contentBlockStyle(kind: ContentBlockKind | string): CSSProperties {
  switch (kind) {
    case 'code':
      return CODE_STYLE;
    case 'status':
      return STATUS_STYLE;
    case 'structured':
      return STRUCTURED_STYLE;
    case 'text':
    default:
      return TEXT_STYLE;
  }
}
