import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { PromptCard } from './prompt-card.tsx';
import type { ContentBlockState, PromptViewState } from '../model/workspace-types.ts';

afterEach(() => {
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePrompt(overrides: Partial<PromptViewState> = {}): PromptViewState {
  return {
    promptId: 'prompt-1',
    parentTurnId: 'turn-1',
    status: 'pending',
    allowedResponses: [],
    contextBlocks: [],
    lastResponseSummary: null,
    errorMessage: null,
    staleReason: null,
    ...overrides,
  };
}

function makeBlock(overrides: Partial<ContentBlockState> = {}): ContentBlockState {
  return {
    blockId: 'block-1',
    kind: 'text',
    text: 'plain text',
    metadata: null,
    ...overrides,
  };
}

// ─── Structured context rendering ───────────────────────────────────────────

describe('PromptCard — structured context blocks', () => {
  it('renders structured block in a <pre> element preserving whitespace', () => {
    const structuredText =
      '{\n  "tool": "file_edit",\n  "path": "/src/app.ts",\n  "indent": "    four spaces"\n}';
    const block = makeBlock({
      kind: 'structured',
      text: structuredText,
    });
    const prompt = makePrompt({ contextBlocks: [block] });

    const { container } = render(<PromptCard prompt={prompt} />);

    const preElement = container.querySelector('pre');
    expect(preElement).not.toBeNull();
    expect(preElement?.textContent).toBe(structuredText);
  });

  it('preserves leading indentation in structured context', () => {
    const indentedText = 'line1\n  indented\n    deeper\nback';
    const block = makeBlock({
      kind: 'structured',
      text: indentedText,
    });
    const prompt = makePrompt({ contextBlocks: [block] });

    const { container } = render(<PromptCard prompt={prompt} />);

    const preElement = container.querySelector('pre');
    expect(preElement).not.toBeNull();
    // The raw text content must retain the original whitespace exactly
    expect(preElement?.textContent).toContain('  indented');
    expect(preElement?.textContent).toContain('    deeper');
  });

  it('renders code blocks in a <pre> element as well', () => {
    const codeText = 'function hello() {\n  return "world";\n}';
    const block = makeBlock({ kind: 'code', text: codeText });
    const prompt = makePrompt({ contextBlocks: [block] });

    const { container } = render(<PromptCard prompt={prompt} />);

    const preElement = container.querySelector('pre');
    expect(preElement).not.toBeNull();
    expect(preElement?.textContent).toBe(codeText);
  });

  it('renders plain text blocks without <pre>', () => {
    const block = makeBlock({ kind: 'text', text: 'Just a paragraph' });
    const prompt = makePrompt({ contextBlocks: [block] });

    const { container } = render(<PromptCard prompt={prompt} />);

    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByTestId('prompt-context').textContent).toContain('Just a paragraph');
  });

  it('renders mixed block kinds correctly', () => {
    const textBlock = makeBlock({ blockId: 'b-text', kind: 'text', text: 'Description' });
    const structuredBlock = makeBlock({
      blockId: 'b-struct',
      kind: 'structured',
      text: '  indented\n    content',
    });
    const prompt = makePrompt({ contextBlocks: [textBlock, structuredBlock] });

    const { container } = render(<PromptCard prompt={prompt} />);

    const preElements = container.querySelectorAll('pre');
    expect(preElements).toHaveLength(1);
    expect(preElements[0].textContent).toBe('  indented\n    content');
    expect(screen.getByTestId('prompt-context').textContent).toContain('Description');
  });
});
