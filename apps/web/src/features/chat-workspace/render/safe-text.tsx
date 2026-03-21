/**
 * Safe text rendering primitives for the chat workspace.
 *
 * All user-facing or stream-sourced text passes through these helpers
 * before reaching the DOM. No raw HTML is ever injected — content is
 * escaped and rendered via React's safe text node / element API only.
 */

import type { JSX } from 'react';

// ─── Escaping ───────────────────────────────────────────────────────────────

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_RE = /[&<>"']/g;

/**
 * Escape a string for safe display in an HTML context.
 *
 * This is a defence-in-depth measure — React already escapes text nodes,
 * but callers that build `aria-label` values, `title` attributes, or log
 * output can use this to ensure no markup leaks through.
 */
export function escapeForDisplay(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}

// ─── Line splitting ─────────────────────────────────────────────────────────

/**
 * Split text on line boundaries (LF or CRLF) for multiline rendering.
 */
export function splitTextLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ─── SafeText component ────────────────────────────────────────────────────

export interface SafeTextProps {
  /** The text content to render safely. */
  readonly text: string | null | undefined;
  /** Optional data-testid for test targeting. */
  readonly 'data-testid'?: string;
}

/**
 * Render arbitrary text safely, preserving line breaks as `<br />` elements.
 *
 * - Never uses `dangerouslySetInnerHTML`.
 * - Angle brackets, ampersands, and quotes in the source text are rendered
 *   as visible characters (React's JSX text escaping handles this).
 * - Multiline text is split on `\n` and joined with `<br />` elements.
 */
export function SafeText(props: SafeTextProps): JSX.Element {
  const { text } = props;
  const testId = props['data-testid'];

  if (text == null || text === '') {
    return <span data-testid={testId} />;
  }

  const lines = splitTextLines(text);

  if (lines.length === 1) {
    return <span data-testid={testId}>{lines[0]}</span>;
  }

  // Interleave text segments with <br /> elements
  const children: (string | JSX.Element)[] = [];
  for (const [i, line] of lines.entries()) {
    if (i > 0) {
      children.push(<br key={`br-${String(i)}`} />);
    }
    children.push(line);
  }

  return <span data-testid={testId}>{children}</span>;
}
