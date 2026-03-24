/**
 * Artifact inspection panel for T041.
 *
 * Renders the currently selected artifact in a closeable panel using the
 * T040 ArtifactPreview renderer. Returns null when no artifact is selected,
 * so the parent layout can conditionally render the panel slot.
 */

import type { JSX, CSSProperties } from 'react';
import type { ArtifactViewState } from '../model/workspace-types.ts';
import { ArtifactPreview } from '../render/artifact-renderers.tsx';

const PANEL_STYLE: CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: '0.75rem',
  background: 'rgba(15, 23, 42, 0.7)',
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const PANEL_HEADER_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  fontWeight: 600,
};

const CLOSE_BUTTON_STYLE: CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.3)',
  borderRadius: '0.375rem',
  background: 'rgba(30, 41, 59, 0.85)',
  color: 'inherit',
  cursor: 'pointer',
  padding: '0.25rem 0.5rem',
  fontSize: '0.8rem',
};

export interface ArtifactPanelProps {
  readonly artifact: ArtifactViewState | null;
  readonly onClose: () => void;
}

export function ArtifactPanel({ artifact, onClose }: ArtifactPanelProps): JSX.Element | null {
  if (artifact == null) return null;

  return (
    <aside
      style={PANEL_STYLE}
      data-testid="artifact-panel"
      aria-label={`Artifact: ${artifact.label}`}
    >
      <div style={PANEL_HEADER_STYLE}>
        <h4 style={HEADING_STYLE}>Artifact Inspector</h4>
        <button
          type="button"
          style={CLOSE_BUTTON_STYLE}
          data-testid="artifact-panel-close"
          onClick={onClose}
          aria-label="Close artifact panel"
        >
          ✕
        </button>
      </div>
      <ArtifactPreview artifact={artifact} />
    </aside>
  );
}
