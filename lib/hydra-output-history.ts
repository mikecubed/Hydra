/**
 * Hydra Output History — Ring buffer capturing recent CLI output.
 *
 * Intercepts process.stdout.write / process.stderr.write to store recent
 * terminal output for AI consumption (e.g. doctor enrichment, error context).
 *
 * Filters out status bar redraws (scroll region escapes) and strips ANSI
 * for the clean-text API. Raw output is also available.
 */

import { stripAnsi } from './hydra-ui.ts';

// ── State ────────────────────────────────────────────────────────────────────

let _initialized = false;
let _maxLines: number = 200;
const _lines: string[] = []; // ANSI-stripped
const _linesRaw: string[] = []; // With ANSI
let _partial: string = ''; // Accumulate incomplete lines
let _partialRaw: string = '';

let _origStdoutWrite: typeof process.stdout.write | null = null;
let _origStderrWrite: typeof process.stderr.write | null = null;

// ── Scroll-region filter ─────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- intentional ANSI escape sequence detection
const SCROLL_REGION_RE = /\x1b\[\d*;\d*r|\x1b\[\d+[ABCDHJ]|\x1b\[s|\x1b\[u|\x1b\[\?25[lh]/;

function isStatusBarLine(raw: string): boolean {
  return SCROLL_REGION_RE.test(raw);
}

// ── Core ─────────────────────────────────────────────────────────────────────

function pushLine(clean: string, raw: string): void {
  _lines.push(clean);
  _linesRaw.push(raw);
  while (_lines.length > _maxLines) {
    _lines.shift();
    _linesRaw.shift();
  }
}

function processChunk(chunk: string | Uint8Array, _isRaw?: boolean): void {
  const str = typeof chunk === 'string' ? chunk : chunk.toString();
  if (!str) return;

  if (isStatusBarLine(str)) return;

  const rawStr = str;
  const cleanStr = stripAnsi(str);

  const rawParts = (_partialRaw + rawStr).split('\n');
  const cleanParts = (_partial + cleanStr).split('\n');

  _partialRaw = rawParts.pop() ?? '';
  _partial = cleanParts.pop() ?? '';

  for (const [i, clean] of cleanParts.entries()) {
    const raw = rawParts[i] || clean;
    if (clean.trim()) {
      pushLine(clean, raw);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start intercepting stdout/stderr writes.
 * Safe to call multiple times — only patches once.
 */
export function initOutputHistory(opts: { maxLines?: number } = {}): void {
  if (_initialized) return;
  _maxLines = opts.maxLines ?? 200;
  _initialized = true;

  _origStdoutWrite = process.stdout.write.bind(process.stdout);
  _origStderrWrite = process.stderr.write.bind(process.stderr);

  const patchedStdoutWrite = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((e?: Error | null) => void),
    cb?: (e?: Error | null) => void,
  ): boolean {
    try {
      processChunk(chunk);
    } catch {
      /* never break output */
    }
    if (typeof encodingOrCb === 'function') {
      return _origStdoutWrite!(chunk, encodingOrCb);
    }
    return _origStdoutWrite!(chunk, encodingOrCb, cb);
  };
  (process.stdout as NodeJS.WriteStream & { write: unknown }).write = patchedStdoutWrite;

  const patchedStderrWrite = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((e?: Error | null) => void),
    cb?: (e?: Error | null) => void,
  ): boolean {
    try {
      processChunk(chunk);
    } catch {
      /* never break output */
    }
    if (typeof encodingOrCb === 'function') {
      return _origStderrWrite!(chunk, encodingOrCb);
    }
    return _origStderrWrite!(chunk, encodingOrCb, cb);
  };
  (process.stderr as NodeJS.WriteStream & { write: unknown }).write = patchedStderrWrite;
}

/**
 * Get last n lines of output, ANSI-stripped.
 */
export function getRecentOutput(n: number = 50): string[] {
  return _lines.slice(-n);
}

/**
 * Get last n lines of output with ANSI intact.
 */
export function getRecentOutputRaw(n: number = 50): string[] {
  return _linesRaw.slice(-n);
}

/**
 * Clear the output buffer.
 */
export function clearOutputHistory(): void {
  _lines.length = 0;
  _linesRaw.length = 0;
  _partial = '';
  _partialRaw = '';
}

/**
 * Get recent output formatted as a single string for AI consumption.
 */
export function getOutputContext(n: number = 50): string {
  const lines = getRecentOutput(n);
  if (lines.length === 0) return '(no recent output)';
  return lines.join('\n');
}
