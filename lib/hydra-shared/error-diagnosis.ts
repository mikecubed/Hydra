/**
 * Agent error diagnosis — pattern matching and exit code interpretation.
 *
 * Extracted from agent-executor.ts. Enriches a failed ExecuteResult with
 * structured errorCategory and errorDetail fields.
 */

import { getAgent } from '../hydra-agents.ts';
import { extractCodexErrors } from './codex-helpers.ts';
import type { ExecuteResult } from '../types.ts';

/** Signal mapping entry */
interface SignalInfo {
  category: string;
  detail: string;
}

/** Agent error pattern entry */
interface AgentErrorPattern {
  pattern: RegExp;
  category: string;
  detail: string;
}

const EXIT_CODE_LABELS: Record<number, string> = {
  1: 'general error',
  2: 'misuse of shell command / invalid arguments',
  126: 'command found but not executable (permission denied)',
  127: 'command not found',
  128: 'invalid exit argument',
  130: 'terminated by Ctrl-C (SIGINT)',
  137: 'killed (SIGKILL / OOM)',
  139: 'segmentation fault (SIGSEGV)',
  143: 'terminated (SIGTERM)',
};

// ── Agent-Specific Error Patterns ───────────────────────────────────────────
// Checked against combined stderr+stdout to produce a structured errorCategory.

const AGENT_ERROR_PATTERNS: AgentErrorPattern[] = [
  // Auth / credential failures
  {
    pattern:
      /(?:auth(?:entication|orization)?|credentials?|api.?key|token)\s*(?:failed|expired|invalid|missing|required|denied|error)/i,
    category: 'auth',
    detail: 'Authentication or API key issue',
  },
  {
    pattern: /OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY/i,
    category: 'auth',
    detail: 'Missing or invalid API key environment variable',
  },
  {
    pattern: /unauthorized|401\b|403\b/i,
    category: 'auth',
    detail: 'Unauthorized or forbidden API response',
  },

  // Codex sandbox / permission errors
  {
    pattern: /sandbox\s*(?:violation|error|timeout|denied)/i,
    category: 'sandbox',
    detail: 'Codex sandbox restriction triggered',
  },
  {
    pattern: /execution\s*(?:not permitted|denied|failed|blocked)/i,
    category: 'sandbox',
    detail: 'Code execution was denied or blocked',
  },
  {
    pattern: /permission\s*(?:denied|error|failed)/i,
    category: 'permission',
    detail: 'Filesystem or execution permission denied',
  },

  // CLI invocation issues (wrong flags, missing binary)
  {
    pattern: /unknown\s+(?:flag|option|argument)|unrecognized\s+(?:flag|option)/i,
    category: 'invocation',
    detail: 'CLI received an unknown flag or option',
  },
  {
    pattern: /directory\s+not\s+found|no\s+such\s+directory|invalid\s+working\s+directory|chdir\b/i,
    category: 'invocation',
    detail: 'Invalid working directory (CWD)',
  },
  {
    pattern: /prompt\s*(?:too long|invalid|malformed|format)/i,
    category: 'invocation',
    detail: 'Prompt formatting or length error',
  },
  {
    pattern: /(?:command|binary|executable)\s*not\s*found/i,
    category: 'invocation',
    detail: 'Agent CLI binary not found on PATH',
  },
  {
    pattern: /ENOENT|spawn\s+.*\s+ENOENT/i,
    category: 'invocation',
    detail: 'Agent CLI binary not found (ENOENT)',
  },

  // Network / connectivity
  {
    pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i,
    category: 'network',
    detail: 'Network connectivity error',
  },
  {
    pattern: /(?:fetch|request)\s*failed|network\s*error/i,
    category: 'network',
    detail: 'HTTP request failed',
  },
  {
    pattern: /\b50[023]\b.*(?:error|status)/i,
    category: 'server',
    detail: 'API server error (5xx)',
  },

  // JSON / output parsing failures
  {
    pattern: /(?:unexpected|invalid)\s*(?:token|json|end of)/i,
    category: 'parse',
    detail: 'Output parsing failure (malformed JSON)',
  },

  // Generic / Mystery errors (opaque agent or backend failures)
  {
    pattern: /something went wrong/i,
    category: 'internal',
    detail: 'Internal agent error (something went wrong)',
  },
  {
    pattern: /mystery error/i,
    category: 'internal',
    detail: 'Internal agent error (mystery error)',
  },
  {
    pattern: /internal\s*(?:server\s*)?error|unexpected\s*error/i,
    category: 'internal',
    detail: 'Internal agent or API error',
  },
  {
    pattern: /unhandled\s*(?:exception|error|rejection)/i,
    category: 'internal',
    detail: 'Unhandled exception in agent process',
  },

  // Out of memory
  {
    pattern: /(?:out of memory|heap|ENOMEM|JavaScript heap)/i,
    category: 'oom',
    detail: 'Process ran out of memory',
  },

  // Account-level usage/spend limits (NOT transient rate limits — no retry)
  {
    pattern: /you'?ve hit your usage limit|usage limit has been reached|usage_limit_reached/i,
    category: 'usage-limit',
    detail: 'API usage limit reached — upgrade or wait for reset',
  },
  {
    pattern: /spending_limit_reached|credit balance.*(?:exhausted|zero|empty)/i,
    category: 'usage-limit',
    detail: 'API spend limit reached — check billing settings',
  },
];

/**
 * Diagnose a failed agent result by interpreting exit code + stderr patterns.
 * Enriches the result object with errorCategory and errorDetail fields.
 * Exported for use in worker and evolve pipelines.
 *
 * Exit code interpretation follows Unix semantics (e.g. 127 = command not found).
 * On Windows, exit code classification is best-effort; spawn/CLI behavior may differ.
 *
 * @param {string} agent - Agent name
 * @param {object} result - executeAgent result (mutated in place)
 * @returns {object} The same result, with errorCategory and errorDetail added
 */
export function diagnoseAgentError(agent: string, result: ExecuteResult): ExecuteResult {
  if (result.ok) return result;

  const code = result.exitCode;
  const stderr = result.stderr;
  const stdout = result.output;
  const error = result.error ?? '';
  const combined = [stderr, stdout, error].join('\n');

  // 1. Check agent-specific patterns first (highest signal)
  for (const { pattern, category, detail } of AGENT_ERROR_PATTERNS) {
    if (pattern.test(combined)) {
      result.errorCategory = category;
      result.errorDetail = detail;
      // Extract the matching line for context
      const matchLine = combined.split('\n').find((l) => pattern.test(l));
      if (matchLine != null) result.errorContext = matchLine.trim().slice(0, 300);
      return result;
    }
  }

  // 2. Interpret signal (process killed by signal — code may be null)
  const signal = result.signal;
  if (signal != null) {
    const signalMap: Partial<Record<string, SignalInfo>> = {
      SIGKILL: { category: 'oom', detail: 'killed (SIGKILL / OOM)' },
      SIGTERM: { category: 'signal', detail: 'terminated (SIGTERM)' },
      SIGINT: { category: 'signal', detail: 'interrupted (SIGINT)' },
      SIGSEGV: { category: 'crash', detail: 'segmentation fault (SIGSEGV)' },
      SIGABRT: { category: 'crash', detail: 'aborted (SIGABRT)' },
      SIGBUS: { category: 'crash', detail: 'bus error (SIGBUS)' },
    };
    const mapped = signalMap[signal] ?? { category: 'signal', detail: `terminated by ${signal}` };
    result.errorCategory = mapped.category;
    result.errorDetail = mapped.detail;
    return result;
  }

  // 3. For agents with --json output, extract JSONL error events (higher signal than exit code 1)
  if (getAgent(agent)?.features.jsonOutput === true) {
    const jsonlErrors = extractCodexErrors(result.stdout ?? result.output);
    if (jsonlErrors.length > 0) {
      result.errorCategory = agent === 'codex' ? 'codex-jsonl-error' : 'jsonl-error';
      result.errorDetail = `${agent} reported ${String(jsonlErrors.length)} error(s): ${jsonlErrors.join('; ').slice(0, 200)}`;
      result.errorContext = jsonlErrors[0].slice(0, 300);
      // Fall through to step 8 for error message enrichment
    }
  }

  // 4. Interpret exit code (only if not already classified, e.g. by JSONL extraction)
  if (
    (result.errorCategory == null || result.errorCategory === '') &&
    code !== null &&
    code in EXIT_CODE_LABELS
  ) {
    let errorCategory: string;
    if (code === 127) errorCategory = 'invocation';
    else if (code === 126) errorCategory = 'permission';
    else if (code === 137) errorCategory = 'oom';
    else if (code === 139) errorCategory = 'crash';
    else if (code >= 128 && code <= 159) errorCategory = 'signal';
    else errorCategory = 'runtime';
    result.errorCategory = errorCategory;
    result.errorDetail = EXIT_CODE_LABELS[code];
    return result;
  }

  // 5. Null exit code with no signal = process died without normal exit
  if (code === null) {
    const stderrTrimmed = stderr.replace(/\[Hydra Telemetry\].*?\n/g, '').trim();
    if (stderrTrimmed === '') {
      result.errorCategory = 'silent-crash';
      result.errorDetail = `${agent} terminated without exit code or signal — possible spawn failure, missing binary, or env issue`;
      if (result.error != null) result.errorContext = result.error.slice(0, 300);
    } else {
      result.errorCategory = 'unclassified';
      result.errorDetail = `${agent} terminated without exit code, but produced stderr`;
      result.errorContext = stderrTrimmed.split('\n').slice(0, 3).join(' | ').slice(0, 300);
    }
    return result;
  }

  // 6. Empty output with non-zero exit = likely process died before producing output
  if (
    (result.errorCategory == null || result.errorCategory === '') &&
    code !== 0 &&
    stdout.trim() === '' &&
    stderr.trim() === ''
  ) {
    result.errorCategory = 'silent-crash';
    result.errorDetail = `${agent} exited with code ${String(code)} but produced no output — possible early crash, missing binary, or env issue`;
    return result;
  }

  // 7. Non-zero exit with stderr but no pattern match = unclassified
  if (code !== 0 && (result.errorCategory == null || result.errorCategory === '')) {
    result.errorCategory = 'unclassified';
    result.errorDetail = `Exit code ${String(code)}`;
    if (stderr.trim() !== '') {
      result.errorContext = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    }
  }

  // 8. Final enrichment: Ensure result.error is descriptive
  {
    const originalError = result.error ?? '';
    // If error is non-existent, vague, or just the exit code, replace it with the diagnosis
    const isGeneric =
      originalError === '' ||
      originalError.includes('Exit code') ||
      originalError.includes('Spawn error') ||
      originalError.includes('Process terminated') ||
      originalError.includes('mystery error') ||
      originalError.includes('something went wrong');

    if (isGeneric) {
      const signalPart = result.signal == null ? '' : ` (signal ${result.signal})`;
      const codePart = result.exitCode === null ? '' : ` (exit code ${String(result.exitCode)})`;
      result.error = `[${result.errorCategory ?? ''}] ${result.errorDetail ?? ''}${signalPart === '' ? codePart : signalPart}`;
    }
  }

  return result;
}
