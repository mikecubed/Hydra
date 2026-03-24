/**
 * Artifact renderer component tests — browser-environment specs.
 *
 * Tests the React component layer of artifact-renderers.tsx using
 * @testing-library/react + jsdom. Verifies safe rendering, kind-specific
 * presentation, and HTML injection prevention.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import {
  ArtifactKindBadge,
  ArtifactContentBlock,
  ArtifactHeader,
  ArtifactPreview,
} from './artifact-renderers.tsx';

import type { ArtifactViewState, ContentBlockState } from '../model/workspace-types.ts';

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

function makeArtifact(overrides: Partial<ArtifactViewState> = {}): ArtifactViewState {
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

// ─── ArtifactKindBadge ──────────────────────────────────────────────────────

describe('ArtifactKindBadge', () => {
  it('renders the human-readable label for file kind', () => {
    render(<ArtifactKindBadge kind="file" />);
    expect(screen.getByText('File').textContent).toBe('File');
  });

  it('renders the human-readable label for diff kind', () => {
    render(<ArtifactKindBadge kind="diff" />);
    expect(screen.getByText('Diff').textContent).toBe('Diff');
  });

  it('renders the human-readable label for test-result kind', () => {
    render(<ArtifactKindBadge kind="test-result" />);
    expect(screen.getByText('Test Result').textContent).toBe('Test Result');
  });

  it('renders a title-cased fallback for unknown kinds', () => {
    render(<ArtifactKindBadge kind="custom-thing" />);
    expect(screen.getByText('Custom Thing').textContent).toBe('Custom Thing');
  });

  it('applies data-testid with kind suffix', () => {
    render(<ArtifactKindBadge kind="log" />);
    expect(screen.getByTestId('artifact-kind-badge-log').textContent).toBe('Log');
  });
});

// ─── ArtifactContentBlock ───────────────────────────────────────────────────

describe('ArtifactContentBlock', () => {
  it('renders plain text safely', () => {
    render(<ArtifactContentBlock kind="text" text="Hello, operator." />);
    expect(screen.getByText('Hello, operator.').textContent).toBe('Hello, operator.');
  });

  it('renders null text as empty', () => {
    const { container } = render(<ArtifactContentBlock kind="text" text={null} />);
    expect(container.textContent).toBe('');
  });

  it('does not inject raw HTML from text content', () => {
    render(<ArtifactContentBlock kind="text" text='<script>alert("xss")</script>' />);
    expect(document.querySelector('script')).toBeNull();
  });

  it('does not inject HTML from code content', () => {
    render(<ArtifactContentBlock kind="code" text='<img src="x" onerror="alert(1)">' />);
    expect(document.querySelector('img')).toBeNull();
  });

  it('preserves angle brackets as visible text in code blocks', () => {
    const { container } = render(<ArtifactContentBlock kind="code" text="<div>hello</div>" />);
    expect(container.textContent).toContain('<div>hello</div>');
  });

  it('uses monospace font for code blocks', () => {
    const { container } = render(<ArtifactContentBlock kind="code" text="const x = 1;" />);
    const pre = container.querySelector('pre');
    expect(pre?.tagName).toBe('PRE');
    expect(pre?.style.fontFamily).toBe('monospace');
  });

  it('uses monospace font for structured blocks', () => {
    const { container } = render(
      <ArtifactContentBlock kind="structured" text='{"key": "value"}' />,
    );
    const pre = container.querySelector('pre');
    expect(pre?.tagName).toBe('PRE');
    expect(pre?.style.fontFamily).toBe('monospace');
  });

  it('renders status blocks with italic styling', () => {
    const { container } = render(<ArtifactContentBlock kind="status" text="Running tests..." />);
    const el = container.firstElementChild;
    expect(el?.getAttribute('style')).toContain('italic');
  });

  it('applies data-testid when provided', () => {
    render(<ArtifactContentBlock kind="text" text="hello" data-testid="block-1" />);
    expect(screen.getByTestId('block-1').textContent).toBe('hello');
  });

  it('renders multiline text with preserved whitespace', () => {
    const { container } = render(<ArtifactContentBlock kind="text" text={'line1\nline2\nline3'} />);
    expect(container.textContent).toContain('line1');
    expect(container.textContent).toContain('line2');
    expect(container.textContent).toContain('line3');
  });
});

// ─── ArtifactHeader ─────────────────────────────────────────────────────────

describe('ArtifactHeader', () => {
  it('renders the artifact label', () => {
    render(<ArtifactHeader label="main.ts" kind="file" />);
    expect(screen.getByText('main.ts').textContent).toBe('main.ts');
  });

  it('renders the kind badge', () => {
    render(<ArtifactHeader label="output.log" kind="log" />);
    expect(screen.getByTestId('artifact-kind-badge-log').textContent).toBe('Log');
  });

  it('renders summary when provided', () => {
    render(<ArtifactHeader label="plan.md" kind="plan" summary="Implementation plan" />);
    expect(screen.getByText('Implementation plan').textContent).toBe('Implementation plan');
  });

  it('omits summary element when not provided', () => {
    const { container } = render(<ArtifactHeader label="plan.md" kind="plan" />);
    expect(container.querySelector('[data-testid="artifact-summary"]')).toBeNull();
  });

  it('escapes HTML in label text', () => {
    render(<ArtifactHeader label='<img src="x">' kind="file" />);
    expect(document.querySelector('img')).toBeNull();
  });

  it('escapes HTML in summary text', () => {
    render(<ArtifactHeader label="test" kind="file" summary='<script>alert("xss")</script>' />);
    expect(document.querySelector('script')).toBeNull();
  });

  it('applies data-testid to header container', () => {
    render(<ArtifactHeader label="test" kind="file" />);
    expect(screen.getByTestId('artifact-header').tagName).toBe('DIV');
  });
});

// ─── ArtifactPreview ────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function -- scenario-rich renderer coverage
describe('ArtifactPreview', () => {
  it('renders header with label and kind', () => {
    render(<ArtifactPreview artifact={makeArtifact()} />);
    expect(screen.getByText('main.ts').textContent).toBe('main.ts');
    expect(screen.getByTestId('artifact-kind-badge-file').textContent).toBe('File');
  });

  it('renders all preview blocks', () => {
    const artifact = makeArtifact({
      previewBlocks: [
        makeBlock({ blockId: 'b-1', text: 'First block' }),
        makeBlock({ blockId: 'b-2', text: 'Second block' }),
      ],
    });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByText('First block').textContent).toBe('First block');
    expect(screen.getByText('Second block').textContent).toBe('Second block');
  });

  it('renders empty state when no preview blocks exist', () => {
    const artifact = makeArtifact({ previewBlocks: [] });
    const { container } = render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByText('main.ts').textContent).toBe('main.ts');
    expect(container.querySelector('[data-testid="artifact-empty"]')?.textContent).toContain(
      'No preview available',
    );
  });

  it('shows loading indicator when availability is loading', () => {
    const artifact = makeArtifact({ availability: 'loading' });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByTestId('artifact-loading').textContent).toContain('Loading');
  });

  it('shows unavailable message when availability is unavailable', () => {
    const artifact = makeArtifact({ availability: 'unavailable' });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByTestId('artifact-unavailable').textContent).toContain('unavailable');
  });

  it('shows error state when availability is error', () => {
    const artifact = makeArtifact({ availability: 'error' });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByTestId('artifact-error').textContent).toContain('Failed to load artifact');
  });

  it('does not inject HTML from artifact label', () => {
    const artifact = makeArtifact({ label: '<img src=x onerror=alert(1)>' });
    render(<ArtifactPreview artifact={artifact} />);
    expect(document.querySelector('img')).toBeNull();
  });

  it('does not inject HTML from preview block text', () => {
    const artifact = makeArtifact({
      previewBlocks: [makeBlock({ text: '<script>alert("xss")</script>' })],
    });
    render(<ArtifactPreview artifact={artifact} />);
    expect(document.querySelector('script')).toBeNull();
  });

  it('renders code blocks within diff-kind artifacts with monospace', () => {
    const artifact = makeArtifact({
      kind: 'diff',
      previewBlocks: [makeBlock({ kind: 'code', text: '+ added line' })],
    });
    const { container } = render(<ArtifactPreview artifact={artifact} />);
    const pre = container.querySelector('pre');
    expect(pre?.tagName).toBe('PRE');
    expect(pre?.style.fontFamily).toBe('monospace');
  });

  it('renders structured-data blocks within artifacts with monospace', () => {
    const artifact = makeArtifact({
      kind: 'structured-data',
      previewBlocks: [makeBlock({ kind: 'structured', text: '{"ok":true}' })],
    });
    const { container } = render(<ArtifactPreview artifact={artifact} />);
    const pre = container.querySelector('pre');
    expect(pre?.tagName).toBe('PRE');
    expect(pre?.style.fontFamily).toBe('monospace');
    expect(pre?.textContent).toContain('{"ok":true}');
  });

  it('applies data-testid to preview container', () => {
    render(<ArtifactPreview artifact={makeArtifact()} />);
    expect(screen.getByTestId('artifact-preview').tagName).toBe('DIV');
  });

  it('sets data-artifact-kind attribute on container', () => {
    render(<ArtifactPreview artifact={makeArtifact({ kind: 'patch' })} />);
    const el = screen.getByTestId('artifact-preview');
    expect(el.getAttribute('data-artifact-kind')).toBe('patch');
  });

  it('shows listed placeholder when availability is listed', () => {
    const artifact = makeArtifact({ availability: 'listed', previewBlocks: [] });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByTestId('artifact-listed').textContent).toContain(
      'Artifact announced — content pending.',
    );
    expect(screen.getByText('Artifact announced — content pending.').textContent).toBe(
      'Artifact announced — content pending.',
    );
  });

  it('shows listed placeholder even when preview blocks exist', () => {
    const artifact = makeArtifact({
      availability: 'listed',
      previewBlocks: [makeBlock({ blockId: 'b-1', text: 'should not render' })],
    });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByTestId('artifact-listed').textContent).toContain(
      'Artifact announced — content pending.',
    );
    expect(screen.queryByText('should not render')).toBeNull();
  });

  it('does not show listed placeholder when availability is ready', () => {
    render(<ArtifactPreview artifact={makeArtifact()} />);
    expect(screen.queryByTestId('artifact-listed')).toBeNull();
  });

  it('renders content blocks only when availability is ready', () => {
    const artifact = makeArtifact({
      availability: 'ready',
      previewBlocks: [makeBlock({ blockId: 'b-1', text: 'visible content' })],
    });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByText('visible content').textContent).toBe('visible content');
    expect(screen.queryByTestId('artifact-listed')).toBeNull();
  });
});
