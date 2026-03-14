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

// ── Diagnosis Helpers ────────────────────────────────────────────────────────

/** Classification result for error diagnosis helpers. */
interface ClassificationResult {
  errorCategory: string;
  errorDetail: string;
  errorContext?: string;
}

function matchAgentErrorPattern(combined: string): ClassificationResult | null {
  for (const { pattern, category, detail } of AGENT_ERROR_PATTERNS) {
    if (pattern.test(combined)) {
      const matchLine = combined.split('\n').find((l) => pattern.test(l));
      return {
        errorCategory: category,
        errorDetail: detail,
        errorContext: matchLine?.trim().slice(0, 300),
      };
    }
  }
  return null;
}

function classifyBySignal(signal: string): ClassificationResult {
  const signalMap: Partial<Record<string, SignalInfo>> = {
    SIGKILL: { category: 'oom', detail: 'killed (SIGKILL / OOM)' },
    SIGTERM: { category: 'signal', detail: 'terminated (SIGTERM)' },
    SIGINT: { category: 'signal', detail: 'interrupted (SIGINT)' },
    SIGSEGV: { category: 'crash', detail: 'segmentation fault (SIGSEGV)' },
    SIGABRT: { category: 'crash', detail: 'aborted (SIGABRT)' },
    SIGBUS: { category: 'crash', detail: 'bus error (SIGBUS)' },
  };
  const mapped = signalMap[signal] ?? { category: 'signal', detail: `terminated by ${signal}` };
  return { errorCategory: mapped.category, errorDetail: mapped.detail };
}

function exitCodeToCategory(code: number): string {
  if (code === 127) return 'invocation';
  if (code === 126) return 'permission';
  if (code === 137) return 'oom';
  if (code === 139) return 'crash';
  if (code >= 128 && code <= 159) return 'signal';
  return 'runtime';
}

function classifyByExitCode(code: number): ClassificationResult | null {
  if (!(code in EXIT_CODE_LABELS)) return null;
  return { errorCategory: exitCodeToCategory(code), errorDetail: EXIT_CODE_LABELS[code] };
}

function classifyByJsonlErrors(agent: string, result: ExecuteResult): ClassificationResult | null {
  if (getAgent(agent)?.features.jsonOutput !== true) return null;
  const jsonlErrors = extractCodexErrors(result.stdout ?? result.output);
  if (jsonlErrors.length === 0) return null;
  return {
    errorCategory: agent === 'codex' ? 'codex-jsonl-error' : 'jsonl-error',
    errorDetail: `${agent} reported ${String(jsonlErrors.length)} error(s): ${jsonlErrors.join('; ').slice(0, 200)}`,
    errorContext: jsonlErrors[0].slice(0, 300),
  };
}

function classifyNullExitCode(agent: string, result: ExecuteResult): ClassificationResult {
  const stderrTrimmed = result.stderr.replace(/\[Hydra Telemetry\].*?\n/g, '').trim();
  if (stderrTrimmed === '') {
    return {
      errorCategory: 'silent-crash',
      errorDetail: `${agent} terminated without exit code or signal — possible spawn failure, missing binary, or env issue`,
      errorContext: result.error?.slice(0, 300),
    };
  }
  return {
    errorCategory: 'unclassified',
    errorDetail: `${agent} terminated without exit code, but produced stderr`,
    errorContext: stderrTrimmed.split('\n').slice(0, 3).join(' | ').slice(0, 300),
  };
}

function isUnclassified(result: ExecuteResult): boolean {
  return result.errorCategory == null || result.errorCategory === '';
}

function isSilentCrash(result: ExecuteResult, code: number): boolean {
  return (
    isUnclassified(result) &&
    code !== 0 &&
    result.output.trim() === '' &&
    result.stderr.trim() === ''
  );
}

function classifySilentCrash(agent: string, code: number): ClassificationResult {
  return {
    errorCategory: 'silent-crash',
    errorDetail: `${agent} exited with code ${String(code)} but produced no output — possible early crash, missing binary, or env issue`,
  };
}

function classifyUnclassified(code: number, result: ExecuteResult): ClassificationResult {
  const cls: ClassificationResult = {
    errorCategory: 'unclassified',
    errorDetail: `Exit code ${String(code)}`,
  };
  if (result.stderr.trim() !== '') {
    cls.errorContext = result.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  }
  return cls;
}

function applyClassification(result: ExecuteResult, cls: ClassificationResult): void {
  result.errorCategory = cls.errorCategory;
  result.errorDetail = cls.errorDetail;
  if (cls.errorContext !== undefined) result.errorContext = cls.errorContext;
}

function enrichErrorText(result: ExecuteResult): void {
  const originalError = result.error ?? '';
  const isGeneric =
    originalError === '' ||
    originalError.includes('Exit code') ||
    originalError.includes('Spawn error') ||
    originalError.includes('Process terminated') ||
    originalError.includes('mystery error') ||
    originalError.includes('something went wrong');

  if (!isGeneric) return;
  const signalPart = result.signal == null ? '' : ` (signal ${result.signal})`;
  const codePart = result.exitCode === null ? '' : ` (exit code ${String(result.exitCode)})`;
  result.error = `[${result.errorCategory ?? ''}] ${result.errorDetail ?? ''}${signalPart === '' ? codePart : signalPart}`;
}

// ── Main Diagnosis Entry Point ──────────────────────────────────────────────

/**
 * Diagnose a failed agent result by interpreting exit code + stderr patterns.
 * Enriches the result object with errorCategory and errorDetail fields.
 * Exported for use in worker and evolve pipelines.
 */
export function diagnoseAgentError(agent: string, result: ExecuteResult): ExecuteResult {
  if (result.ok) return result;

  const combined = [result.stderr, result.output, result.error ?? ''].join('\n');
  const code = result.exitCode;

  // 1. Check agent-specific patterns first (highest signal)
  const patternMatch = matchAgentErrorPattern(combined);
  if (patternMatch) {
    applyClassification(result, patternMatch);
    return result;
  }

  // 2. Interpret signal (process killed by signal)
  if (result.signal != null) {
    applyClassification(result, classifyBySignal(result.signal));
    return result;
  }

  // 3. For agents with --json output, extract JSONL error events
  const jsonlCls = classifyByJsonlErrors(agent, result);
  if (jsonlCls) applyClassification(result, jsonlCls);

  // 4. Interpret exit code (only if not already classified)
  if (isUnclassified(result) && code !== null) {
    const exitCls = classifyByExitCode(code);
    if (exitCls) {
      applyClassification(result, exitCls);
      enrichErrorText(result);
      return result;
    }
  }

  // 5. Null exit code with no signal
  if (code === null) {
    applyClassification(result, classifyNullExitCode(agent, result));
    enrichErrorText(result);
    return result;
  }

  // 6. Silent crash (non-zero exit, no output)
  if (isSilentCrash(result, code)) {
    applyClassification(result, classifySilentCrash(agent, code));
    enrichErrorText(result);
    return result;
  }

  // 7. Non-zero exit with stderr but no pattern match
  if (code !== 0 && isUnclassified(result)) {
    applyClassification(result, classifyUnclassified(code, result));
  }

  enrichErrorText(result);
  return result;
}
