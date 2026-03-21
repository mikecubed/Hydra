import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { SafeText, escapeForDisplay, splitTextLines } from './safe-text.tsx';

afterEach(() => {
  cleanup();
});

// ─── escapeForDisplay ───────────────────────────────────────────────────────

describe('escapeForDisplay', () => {
  it('returns plain text unchanged', () => {
    expect(escapeForDisplay('Hello, operator.')).toBe('Hello, operator.');
  });

  it('escapes angle brackets', () => {
    expect(escapeForDisplay('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersands', () => {
    expect(escapeForDisplay('a & b')).toBe('a &amp; b');
  });

  it('escapes double quotes', () => {
    expect(escapeForDisplay('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeForDisplay("it's")).toBe('it&#39;s');
  });

  it('handles empty string', () => {
    expect(escapeForDisplay('')).toBe('');
  });

  it('handles multiple special characters together', () => {
    expect(escapeForDisplay('<b>"a & b"</b>')).toBe('&lt;b&gt;&quot;a &amp; b&quot;&lt;/b&gt;');
  });

  it('does not double-escape already-escaped entities', () => {
    expect(escapeForDisplay('&amp;')).toBe('&amp;amp;');
  });
});

// ─── splitTextLines ─────────────────────────────────────────────────────────

describe('splitTextLines', () => {
  it('splits on newline characters', () => {
    expect(splitTextLines('line one\nline two')).toEqual(['line one', 'line two']);
  });

  it('returns single-element array for text without newlines', () => {
    expect(splitTextLines('no newlines here')).toEqual(['no newlines here']);
  });

  it('handles empty string', () => {
    expect(splitTextLines('')).toEqual(['']);
  });

  it('handles consecutive newlines', () => {
    expect(splitTextLines('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('handles carriage-return + newline', () => {
    expect(splitTextLines('line1\r\nline2')).toEqual(['line1', 'line2']);
  });
});

// ─── SafeText component ────────────────────────────────────────────────────

describe('SafeText', () => {
  it('renders plain text as-is', () => {
    render(<SafeText text="Hello, operator." />);
    expect(screen.getByText('Hello, operator.')).toBeTruthy();
  });

  it('renders text containing HTML-like tags safely (no DOM injection)', () => {
    const { container } = render(<SafeText text='<img src="x" onerror="alert(1)">' />);
    // No actual <img> element should exist in the document
    expect(document.querySelector('img')).toBeNull();
    // The raw angle-bracket text should be visible as text content
    expect(container.textContent).toContain('<img');
  });

  it('renders multiline text with line breaks', () => {
    const { container } = render(<SafeText text={'line 1\nline 2'} />);
    const brs = container.querySelectorAll('br');
    expect(brs.length).toBe(1);
  });

  it('renders empty text without crashing', () => {
    const { container } = render(<SafeText text="" />);
    expect(container.textContent).toBe('');
  });

  it('renders null-ish text as empty', () => {
    const { container } = render(<SafeText text={null} />);
    expect(container.textContent).toBe('');
  });

  it('wraps output in a span by default', () => {
    const { container } = render(<SafeText text="hello" />);
    expect(container.querySelector('span')).toBeTruthy();
  });

  it('applies data-testid when provided', () => {
    render(<SafeText text="hello" data-testid="safe-text-1" />);
    expect(screen.getByTestId('safe-text-1')).toBeTruthy();
  });
});
