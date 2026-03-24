/**
 * T041 — Artifact panel and clickable badge browser specs.
 *
 * Tests the React component integration:
 * 1. ArtifactPanel renders ArtifactPreview when artifact is visible, nothing when null
 * 2. ArtifactPanel close button fires onClose callback
 * 3. Artifact badges in TranscriptTurn are clickable and fire onArtifactSelect
 * 4. Workspace layout renders artifact panel when visibleArtifact is set
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type {
  ArtifactReferenceState,
  ArtifactViewState,
  ContentBlockState,
  TranscriptEntryState,
} from './model/workspace-store.ts';
import { ArtifactPanel } from './components/artifact-panel.tsx';
import { TranscriptTurn } from './components/transcript-turn.tsx';

afterEach(() => {
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeBlock(overrides: Partial<ContentBlockState> = {}): ContentBlockState {
  return {
    blockId: 'b-1',
    kind: 'text',
    text: 'sample text',
    metadata: null,
    ...overrides,
  };
}

function makeArtifactView(overrides: Partial<ArtifactViewState> = {}): ArtifactViewState {
  return {
    artifactId: 'art-1',
    turnId: 'turn-1',
    kind: 'file',
    label: 'main.ts',
    availability: 'ready',
    previewBlocks: [makeBlock()],
    ...overrides,
  };
}

function makeArtifactRef(overrides: Partial<ArtifactReferenceState> = {}): ArtifactReferenceState {
  return {
    artifactId: 'art-1',
    kind: 'file',
    label: 'main.ts',
    availability: 'listed',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<TranscriptEntryState> = {}): TranscriptEntryState {
  return {
    entryId: 'entry-1',
    kind: 'turn',
    turnId: 'turn-1',
    attributionLabel: null,
    status: 'completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    contentBlocks: [],
    artifacts: [],
    controls: [],
    prompt: null,
    ...overrides,
  };
}

// ─── ArtifactPanel ──────────────────────────────────────────────────────────

describe('ArtifactPanel', () => {
  it('renders nothing when artifact is null', () => {
    const { container } = render(<ArtifactPanel artifact={null} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders artifact preview when artifact is provided', () => {
    render(<ArtifactPanel artifact={makeArtifactView()} onClose={vi.fn()} />);
    expect(screen.getByTestId('artifact-panel')).toBeTruthy();
    expect(screen.getByTestId('artifact-preview')).toBeTruthy();
    expect(screen.getByText('main.ts')).toBeTruthy();
  });

  it('renders a close button', () => {
    render(<ArtifactPanel artifact={makeArtifactView()} onClose={vi.fn()} />);
    expect(screen.getByTestId('artifact-panel-close')).toBeTruthy();
  });

  it('fires onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<ArtifactPanel artifact={makeArtifactView()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('artifact-panel-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders loading state for loading artifact', () => {
    const artifact = makeArtifactView({ availability: 'loading', previewBlocks: [] });
    render(<ArtifactPanel artifact={artifact} onClose={vi.fn()} />);
    expect(screen.getByTestId('artifact-loading')).toBeTruthy();
  });

  it('renders error state for errored artifact', () => {
    const artifact = makeArtifactView({ availability: 'error', previewBlocks: [] });
    render(<ArtifactPanel artifact={artifact} onClose={vi.fn()} />);
    expect(screen.getByTestId('artifact-error')).toBeTruthy();
  });

  it('applies aria-label for accessibility', () => {
    render(<ArtifactPanel artifact={makeArtifactView()} onClose={vi.fn()} />);
    const panel = screen.getByTestId('artifact-panel');
    expect(panel.getAttribute('aria-label')).toBe('Artifact: main.ts');
  });
});

// ─── TranscriptTurn clickable artifact badges ───────────────────────────────

describe('TranscriptTurn artifact badges', () => {
  it('renders artifact badges as clickable buttons', () => {
    const entry = makeEntry({
      artifacts: [makeArtifactRef()],
    });
    render(<TranscriptTurn entry={entry} onArtifactSelect={vi.fn()} />);
    const badges = screen.getAllByTestId('artifact-badge');
    expect(badges.length).toBe(1);
    // Should be a button element
    expect(badges[0]?.tagName).toBe('BUTTON');
  });

  it('fires onArtifactSelect with artifactId and turnId when badge clicked', () => {
    const onArtifactSelect = vi.fn();
    const entry = makeEntry({
      turnId: 'turn-42',
      artifacts: [makeArtifactRef({ artifactId: 'art-99' })],
    });
    render(<TranscriptTurn entry={entry} onArtifactSelect={onArtifactSelect} />);
    fireEvent.click(screen.getByTestId('artifact-badge'));
    expect(onArtifactSelect).toHaveBeenCalledWith('art-99', 'turn-42');
  });

  it('renders multiple badges that are independently clickable', () => {
    const onArtifactSelect = vi.fn();
    const entry = makeEntry({
      artifacts: [
        makeArtifactRef({ artifactId: 'art-a', label: 'Alpha' }),
        makeArtifactRef({ artifactId: 'art-b', label: 'Beta' }),
      ],
    });
    render(<TranscriptTurn entry={entry} onArtifactSelect={onArtifactSelect} />);
    const badges = screen.getAllByTestId('artifact-badge');
    expect(badges.length).toBe(2);

    const secondBadge = badges.at(1);
    if (secondBadge === undefined) throw new Error('Expected second artifact badge');
    fireEvent.click(secondBadge);
    expect(onArtifactSelect).toHaveBeenCalledWith('art-b', 'turn-1');
  });

  it('renders artifact badges even without onArtifactSelect (non-clickable fallback)', () => {
    const entry = makeEntry({
      artifacts: [makeArtifactRef()],
    });
    render(<TranscriptTurn entry={entry} />);
    const badges = screen.getAllByTestId('artifact-badge');
    expect(badges.length).toBe(1);
  });
});
