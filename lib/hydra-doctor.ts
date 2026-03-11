/**
 * Hydra Doctor — Higher-level failure diagnostic and triage layer.
 *
 * Fires when evolve/nightly/tasks encounters a non-trivial failure. It:
 * - Calls the existing investigator for diagnosis (reuses investigate())
 * - Triages the result into an actionable follow-up: daemon task, suggestion, or KB entry
 * - Tracks error patterns across sessions via append-only NDJSON log
 *
 * Diagnosis actions:
 *   ticket  — Fundamental issue → create suggestion for future investigation
 *   fix     — Fixable issue → create daemon task (fallback: suggestion)
 *   ignore  — Transient issue → log only
 *
 * All operations are best-effort and never block the calling pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHydraConfig } from './hydra-config.ts';
import type { ActionItem, PipelineResult } from './hydra-action-pipeline.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HYDRA_ROOT = path.resolve(__dirname, '..');

const LOG_DIR = path.join(HYDRA_ROOT, 'docs', 'coordination', 'doctor');
const LOG_PATH = path.join(LOG_DIR, 'DOCTOR_LOG.ndjson');

// ── Interfaces ──────────────────────────────────────────────────────────────

interface FailureInfo {
  pipeline: string;
  phase?: string;
  agent?: string;
  error?: string;
  exitCode?: number | null;
  signal?: string | null;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
  taskTitle?: string;
  branchName?: string;
  context?: string;
  command?: string;
  args?: unknown;
  promptSnippet?: string;
  errorCategory?: string;
  errorDetail?: string;
  errorContext?: string;
  stderrTail?: string;
  notes?: string;
  assignedTo?: string;
  preferredAgent?: string;
}

interface InvestigatorDiagnosis {
  diagnosis?: string;
  explanation?: string;
  rootCause?: string;
}

interface DoctorDiagnosis {
  severity: string;
  action: string;
  explanation: string;
  rootCause: string;
  followUp: unknown;
  investigatorDiagnosis: InvestigatorDiagnosis | null;
  recurring: boolean;
}

// ── Session State ───────────────────────────────────────────────────────────

let _initialized = false;
let _history: Record<string, unknown>[] = [];
let _sessionEntries: string[] = [];
let _sessionStats = { total: 0, fixes: 0, tickets: 0, investigations: 0, ignored: 0 };

// ── Config ──────────────────────────────────────────────────────────────────

function getDoctorConfig() {
  const cfg = loadHydraConfig();
  const doc = cfg.doctor ?? {};
  return {
    enabled: doc.enabled !== false,
    autoCreateTasks: doc.autoCreateTasks !== false,
    autoCreateSuggestions: doc.autoCreateSuggestions !== false,
    addToKnowledgeBase: doc.addToKnowledgeBase !== false,
    recurringThreshold: doc.recurringThreshold ?? 3,
    recurringWindowDays: doc.recurringWindowDays ?? 7,
  };
}
type DoctorConfig = ReturnType<typeof getDoctorConfig>;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the doctor. Loads diagnostic history from the log file.
 */
export function initDoctor(): void {
  if (_initialized) return;
  _history = loadHistory();
  _initialized = true;
}

/**
 * Check if the doctor is enabled in config.
 */
export function isDoctorEnabled(): boolean {
  return getDoctorConfig().enabled;
}

/**
 * Get session statistics.
 */
export function getDoctorStats(): {
  total: number;
  fixes: number;
  tickets: number;
  investigations: number;
  ignored: number;
} {
  return { ..._sessionStats };
}

/**
 * Get recent diagnostic log entries.
 * @param {number} [limit=25] - Max entries to return
 * @returns {object[]} Most recent log entries (newest first)
 */
export function getDoctorLog(limit = 25): Record<string, unknown>[] {
  if (!_initialized) initDoctor();
  return _history.slice(-limit).reverse();
}

/**
 * Reset session state (for testing or between sessions).
 * Also removes any entries written during this session from the persistent log file.
 */
export function resetDoctor(): void {
  if (_sessionEntries.length > 0) {
    try {
      if (fs.existsSync(LOG_PATH)) {
        const sessionTs = new Set(_sessionEntries);
        const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
        const kept = lines.filter((l) => {
          try {
            const parsed = JSON.parse(l) as Record<string, unknown>;
            return !sessionTs.has(parsed['ts'] as string);
          } catch {
            return true;
          }
        });
        fs.writeFileSync(LOG_PATH, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
      }
    } catch {
      /* best effort — don't break if file is locked */
    }
  }
  _initialized = false;
  _history = [];
  _sessionEntries = [];
  _sessionStats = { total: 0, fixes: 0, tickets: 0, investigations: 0, ignored: 0 };
}

/**
 * Diagnose a pipeline failure and create appropriate follow-ups.
 *
 * @param {object} failure
 * @param {string} failure.pipeline - Source pipeline ('evolve', 'nightly', 'tasks')
 * @param {string} [failure.phase] - Phase where failure occurred
 * @param {string} [failure.agent] - Agent that failed
 * @param {string} [failure.error] - Error message
 * @param {number|null} [failure.exitCode] - Numeric exit code from agent process
 * @param {string|null} [failure.signal] - Termination signal (e.g. SIGKILL)
 * @param {string} [failure.stderr] - Agent stderr output
 * @param {string} [failure.stdout] - Agent stdout output
 * @param {boolean} [failure.timedOut] - Whether this was a timeout
 * @param {string} [failure.taskTitle] - Title of the task being worked on
 * @param {string} [failure.branchName] - Branch where failure occurred
 * @param {string} [failure.context] - Additional context
 * @returns {Promise<DoctorDiagnosis>}
 */
export async function diagnose(failure: FailureInfo): Promise<DoctorDiagnosis> {
  if (!_initialized) initDoctor();

  const cfg = getDoctorConfig();
  _sessionStats.total++;

  const signature = buildSignature(failure);
  const recurring = isRecurring(signature, cfg);

  if (isRateLimitError(failure)) {
    const result: DoctorDiagnosis = {
      severity: 'low',
      action: 'ignore',
      explanation: 'Rate limit — already handled by retry logic',
      rootCause: 'rate_limit',
      followUp: null,
      investigatorDiagnosis: null,
      recurring: false,
    };
    appendLog(failure, result, signature);
    _sessionStats.ignored++;
    return result;
  }

  let investigatorDiagnosis: InvestigatorDiagnosis | null = null;
  try {
    const inv = await lazyLoadInvestigator();
    if (inv?.isInvestigatorAvailable()) {
      _sessionStats.investigations++;
      investigatorDiagnosis = (await inv.investigate({
        phase: failure.phase ?? 'agent',
        agent: failure.agent,
        error: (failure.error ?? '').slice(0, 2000),
        exitCode: failure.exitCode ?? null,
        signal: failure.signal ?? null,
        stderr: (failure.stderr ?? '').slice(-2000),
        stdout: (failure.stdout ?? '').slice(-2000),
        timedOut: failure.timedOut ?? false,
        command: failure.command,
        args: failure.args as string[] | undefined,
        promptSnippet: failure.promptSnippet,
        context: failure.context ?? `Pipeline: ${failure.pipeline}`,
        attemptNumber: 1,
      })) as InvestigatorDiagnosis;
    }
  } catch {
    // Investigator unavailable — proceed with heuristic triage
  }

  const diagnosis = triage(failure, investigatorDiagnosis, recurring, cfg);

  if (diagnosis.action === 'ticket' && cfg.autoCreateSuggestions) {
    diagnosis.followUp = await createFollowUp(failure, diagnosis, 'suggestion');
  } else if (diagnosis.action === 'fix' && cfg.autoCreateTasks) {
    diagnosis.followUp = await createFollowUp(failure, diagnosis, 'task');
  }

  if (diagnosis.action !== 'ignore' && cfg.addToKnowledgeBase) {
    await addKBEntry(failure, diagnosis);
  }

  appendLog(failure, diagnosis, signature);

  return diagnosis;
}

// ── Triage Logic ────────────────────────────────────────────────────────────

function triage(
  failure: FailureInfo,
  investigatorDiagnosis: InvestigatorDiagnosis | null,
  recurring: boolean,
  cfg: DoctorConfig,
): DoctorDiagnosis {
  const invDiag = investigatorDiagnosis?.diagnosis;
  let severity: string;
  let action: string;
  let explanation: string;
  let rootCause: string;

  if (invDiag === 'fundamental') {
    severity = recurring ? 'critical' : 'high';
    action = 'ticket';
    explanation =
      investigatorDiagnosis?.explanation ?? 'Fundamental failure requiring investigation';
    rootCause = investigatorDiagnosis?.rootCause ?? 'unknown';
  } else if (invDiag === 'fixable') {
    severity = recurring ? 'high' : 'medium';
    action = 'fix';
    explanation = investigatorDiagnosis?.explanation ?? 'Fixable issue detected';
    rootCause = investigatorDiagnosis?.rootCause ?? 'unknown';
  } else if (invDiag === 'transient') {
    if (recurring) {
      severity = 'medium';
      action = 'ticket';
      explanation = `Recurring transient failure (${String(cfg.recurringThreshold)}+ occurrences): ${investigatorDiagnosis?.explanation ?? failure.error ?? 'unknown'}`;
      rootCause = investigatorDiagnosis?.rootCause ?? 'recurring_transient';
    } else {
      severity = 'low';
      action = 'ignore';
      explanation = investigatorDiagnosis?.explanation ?? 'Transient failure';
      rootCause = investigatorDiagnosis?.rootCause ?? 'transient';
    }
  } else {
    if (failure.timedOut) {
      severity = recurring ? 'medium' : 'low';
      action = recurring ? 'ticket' : 'ignore';
      explanation = `Agent timed out${recurring ? ' (recurring)' : ''}`;
      rootCause = 'timeout';
    } else if (failure.errorCategory && failure.errorCategory !== 'unclassified') {
      severity = recurring ? 'high' : 'medium';
      action = recurring ? 'ticket' : 'fix';
      const exitInfo = failure.exitCode == null ? '' : ` (exit ${String(failure.exitCode)})`;
      const signalInfo = failure.signal ? ` (signal ${failure.signal})` : '';
      explanation = `[${failure.errorCategory}] ${failure.errorDetail ?? failure.error ?? 'unknown'}${exitInfo}${signalInfo}`;
      rootCause = failure.errorCategory;
    } else {
      severity = 'medium';
      action = 'ticket';
      const exitInfo = failure.exitCode == null ? '' : ` (exit ${String(failure.exitCode)})`;
      const signalInfo = failure.signal ? ` (signal ${failure.signal})` : '';
      const stderrHint =
        !failure.error && failure.stderr
          ? ((failure.stderr ?? '')
              .replace(/\[Hydra Telemetry\].*?\n/g, '')
              .trim()
              .split('\n')[0]
              ?.slice(0, 150) ?? '')
          : '';
      explanation =
        ((failure.error ?? '').slice(0, 200) ||
          stderrHint ||
          'Unknown failure without investigator') +
        exitInfo +
        signalInfo;
      rootCause = 'unknown';
    }
  }

  if (recurring && action === 'ignore') {
    action = 'ticket';
    severity = 'medium';
  }

  if (action === 'fix') _sessionStats.fixes++;
  else if (action === 'ticket') _sessionStats.tickets++;
  else _sessionStats.ignored++;

  return {
    severity,
    action,
    explanation,
    rootCause,
    followUp: null as unknown,
    investigatorDiagnosis: investigatorDiagnosis ?? null,
    recurring,
  };
}

// ── Signature & Recurrence ──────────────────────────────────────────────────

function buildSignature(failure: FailureInfo): string {
  const agent = failure.agent ?? 'unknown';
  const phase = failure.phase ?? 'unknown';
  let errorText = failure.error ?? '';

  if (failure.errorCategory && failure.errorCategory !== 'unclassified') {
    errorText = `[${failure.errorCategory}] ${failure.errorDetail ?? errorText}`;
  } else if (failure.signal) {
    errorText = `Signal ${failure.signal}${errorText ? ` (${errorText})` : ''}`;
  }

  const isGeneric =
    errorText.includes('Exit code') ||
    errorText === 'Process terminated abnormally' ||
    errorText.startsWith('[unclassified]');

  if (isGeneric && failure.stderr) {
    const stderrClean = failure.stderr.replace(/\[Hydra Telemetry\].*?\n/g, '').trim();
    if (stderrClean) {
      const lines = stderrClean
        .split('\n')
        .filter((l: string) => !l.startsWith('[Hydra Telemetry]'));
      if (lines.length > 0) {
        const firstLine = lines[0].trim();
        errorText = `${errorText} (${firstLine})`;
      }
    }
  }

  const errorSnippet = errorText.slice(0, 100).replace(/\s+/g, ' ').trim();
  return `${agent}:${phase}:${errorSnippet}`;
}

function isRecurring(signature: string, cfg: DoctorConfig): boolean {
  const windowMs = cfg.recurringWindowDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const matches = _history.filter(
    (h) => h['signature'] === signature && new Date(h['ts'] as string).getTime() > cutoff,
  );
  return matches.length >= cfg.recurringThreshold;
}

// ── Rate Limit Detection (quick filter) ─────────────────────────────────────

function isRateLimitError(failure: FailureInfo): boolean {
  const text = `${failure.error ?? ''} ${failure.stderr ?? ''}`.toLowerCase();
  return /rate.?limit|429|resource.?exhausted|quota.?exhausted|too many requests/i.test(text);
}

// ── Follow-up Creation ──────────────────────────────────────────────────────

async function createFollowUp(
  failure: FailureInfo,
  diagnosis: DoctorDiagnosis,
  type: string,
): Promise<unknown> {
  const titleDetail =
    failure.errorCategory && failure.errorCategory !== 'unclassified'
      ? `[${failure.errorCategory}] ${(failure.errorDetail ?? diagnosis.explanation).slice(0, 70)}`
      : diagnosis.explanation.slice(0, 80);
  const title = `[doctor] ${failure.pipeline}: ${titleDetail}`;
  const notes = [
    `Pipeline: ${failure.pipeline}`,
    `Phase: ${failure.phase ?? 'unknown'}`,
    `Agent: ${failure.agent ?? 'unknown'}`,
    `Root cause: ${diagnosis.rootCause}`,
    failure.errorCategory ? `Error category: ${failure.errorCategory}` : '',
    failure.errorDetail ? `Error detail: ${failure.errorDetail}` : '',
    failure.errorContext ? `Error context: ${failure.errorContext}` : '',
    failure.exitCode == null ? '' : `Exit code: ${String(failure.exitCode)}`,
    failure.signal ? `Signal: ${failure.signal}` : '',
    diagnosis.recurring ? 'Status: RECURRING' : '',
    failure.branchName ? `Branch: ${failure.branchName}` : '',
    failure.taskTitle ? `Task: ${failure.taskTitle}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const preferredAgent = diagnosis.action === 'fix' ? 'codex' : 'gemini';

  if (type === 'task') {
    const created = await tryCreateDaemonTask(title, notes, preferredAgent);
    if (created) return { type: 'daemon_task', title };
    return await createSuggestionFollowUp(failure, diagnosis, title, notes);
  }

  return await createSuggestionFollowUp(failure, diagnosis, title, notes);
}

async function tryCreateDaemonTask(
  title: string,
  notes: string,
  preferredAgent: string,
): Promise<boolean> {
  try {
    const { request } = await import('./hydra-utils.ts');
    const result = await request('POST', 'http://localhost:4173', '/task/add', {
      title,
      notes,
      preferredAgent,
      source: 'doctor',
    });
    return result != null && !(result as Record<string, unknown>)['error'];
  } catch {
    return false;
  }
}

async function createSuggestionFollowUp(
  failure: FailureInfo,
  diagnosis: DoctorDiagnosis,
  title: string,
  notes: string,
): Promise<unknown> {
  try {
    const { loadSuggestions, saveSuggestions, addSuggestion } =
      await import('./hydra-evolve-suggestions.ts');
    const sg = loadSuggestions(undefined as unknown as string);
    const entry = addSuggestion(sg, {
      title,
      description: notes,
      source: `doctor:${diagnosis.action}`,
      area: failure.pipeline,
    });
    if (entry) {
      saveSuggestions(undefined as unknown as string, sg);
      return { type: 'suggestion', id: entry.id, title };
    }
    return { type: 'suggestion_dedup', title };
  } catch {
    return null;
  }
}

// ── Knowledge Base ──────────────────────────────────────────────────────────

async function addKBEntry(failure: FailureInfo, diagnosis: DoctorDiagnosis): Promise<void> {
  try {
    const { loadKnowledgeBase, saveKnowledgeBase, addEntry } = await import('./hydra-knowledge.ts');
    const kb = loadKnowledgeBase(undefined as unknown as string);
    const entry = addEntry(kb, {
      area: failure.pipeline,
      finding: `[Doctor] ${diagnosis.explanation} (root cause: ${diagnosis.rootCause})`,
      applicability: diagnosis.recurring ? 'high' : 'medium',
      attempted: false,
      outcome: null,
    });
    if (entry) saveKnowledgeBase(undefined as unknown as string, kb);
  } catch {
    // Best effort
  }
}

// ── Lazy Loaders ────────────────────────────────────────────────────────────

async function lazyLoadInvestigator() {
  try {
    return await import('./hydra-investigator.ts');
  } catch {
    return null;
  }
}

// ── History / Logging ───────────────────────────────────────────────────────

function loadHistory(): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch {
    return [];
  }
}

function appendLog(failure: FailureInfo, diagnosis: DoctorDiagnosis, signature: string): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const ts = new Date().toISOString();
    const entry: Record<string, unknown> = {
      ts,
      pipeline: failure.pipeline,
      phase: failure.phase ?? null,
      agent: failure.agent ?? null,
      error: (failure.error ?? '').slice(0, 500),
      exitCode: failure.exitCode ?? null,
      signal: failure.signal ?? null,
      command: failure.command ?? null,
      args: failure.args ?? null,
      promptSnippet: failure.promptSnippet ?? null,
      stderrTail: (failure.stderr ?? '').slice(-500) || null,
      stdoutTail: (failure.stdout ?? '').slice(-500) || null,
      timedOut: failure.timedOut ?? false,
      taskTitle: failure.taskTitle ?? null,
      branchName: failure.branchName ?? null,
      errorCategory: failure.errorCategory ?? null,
      errorDetail: failure.errorDetail ?? null,
      errorContext: (failure.errorContext ?? '').slice(0, 300) || null,
      signature,
      severity: diagnosis.severity,
      action: diagnosis.action,
      explanation: diagnosis.explanation,
      rootCause: diagnosis.rootCause,
      recurring: diagnosis.recurring,
      followUp: diagnosis.followUp,
    };

    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');

    _history.push(entry);
    _sessionEntries.push(ts);
  } catch {
    // Best effort — don't let logging failures break the pipeline
  }
}

// ── Action Pipeline Scanners ─────────────────────────────────────────────────

/**
 * Scan doctor log for pending fix/ticket entries that haven't been addressed.
 * Deduplicates by signature — only the most recent entry per unique issue is shown,
 * with an occurrence count. Excludes doctor-fix feedback entries.
 * @returns {Promise<ActionItem[]>}
 */
export function scanDoctorLog(): Promise<ActionItem[]> {
  if (!_initialized) initDoctor();
  const items: ActionItem[] = [];

  type SigEntry = { entry: Record<string, unknown>; count: number };
  const bySignature = new Map<string, SigEntry>();

  for (const entry of _history) {
    const entryAction = entry['action'] as string | undefined;
    if (entryAction !== 'fix' && entryAction !== 'ticket') continue;
    const entryPipeline = entry['pipeline'] as string | undefined;
    if (entryPipeline === 'doctor-fix') continue;

    const entrySignature = entry['signature'] as string | undefined;
    const entryAgent = entry['agent'] as string | undefined;
    const entryPhase = entry['phase'] as string | undefined;
    const entryError = entry['error'] as string | undefined;
    const entryTs = entry['ts'] as string;

    const sig =
      entrySignature ??
      `${entryAgent ?? ''}:${entryPhase ?? ''}:${(entryError ?? '').slice(0, 80)}`;
    const existing = bySignature.get(sig);
    if (!existing || new Date(entryTs) > new Date(existing.entry['ts'] as string)) {
      bySignature.set(sig, { entry, count: (existing?.count ?? 0) + 1 });
    } else {
      existing.count++;
    }
  }

  for (const [sig, { entry, count }] of bySignature) {
    const countLabel = count > 1 ? ` (${String(count)}x)` : '';
    const isTransient = classifyIssueType(entry) === 'transient';

    const entryExplanation = entry['explanation'] as string | undefined;
    const entryPipeline = entry['pipeline'] as string | undefined;
    const entryPhase = entry['phase'] as string | undefined;
    const entryAgent = entry['agent'] as string | undefined;
    const entryRootCause = entry['rootCause'] as string | undefined;
    const entryErrorCategory = entry['errorCategory'] as string | undefined;
    const entryErrorDetail = entry['errorDetail'] as string | undefined;
    const entryExitCode = entry['exitCode'] as number | null | undefined;
    const entrySignal = entry['signal'] as string | undefined;
    const entryRecurring = entry['recurring'] as boolean | undefined;
    const entryError = entry['error'] as string | undefined;
    const entrySeverity = entry['severity'] as 'critical' | 'high' | 'medium' | 'low' | undefined;

    items.push({
      id: `doctor-${sig.slice(0, 40)}`,
      title: `${(entryExplanation ?? 'Unknown issue').slice(0, 90)}${countLabel}`,
      description: [
        `Pipeline: ${entryPipeline ?? 'unknown'}`,
        `Phase: ${entryPhase ?? 'unknown'}`,
        `Agent: ${entryAgent ?? 'unknown'}`,
        `Root cause: ${entryRootCause ?? 'unknown'}`,
        entryErrorCategory ? `Category: ${entryErrorCategory}` : null,
        entryErrorDetail ? `Detail: ${entryErrorDetail}` : null,
        entryExitCode == null ? null : `Exit: ${String(entryExitCode)}`,
        entrySignal ? `Signal: ${entrySignal}` : null,
        count > 1 ? `Occurrences: ${String(count)}` : null,
        entryRecurring ? 'RECURRING' : null,
        entryError ? `Error: ${entryError.slice(0, 200)}` : null,
      ]
        .filter(Boolean)
        .join(' | '),
      category: isTransient ? 'acknowledge' : 'fix',
      severity: entrySeverity ?? 'medium',
      source: 'doctor-log',
      agent: selectFixAgent(entry),
      actionPrompt: isTransient ? undefined : buildFixPrompt(entry),
      meta: { entry, count, issueType: classifyIssueType(entry) },
    });
  }

  return Promise.resolve(items);
}

/**
 * Classify an issue as transient, config, invocation, auth, or code.
 * Uses structured errorCategory from diagnoseAgentError when available.
 * Also checks the log entry fields that may have been persisted.
 */
function classifyIssueType(entry: Record<string, unknown>): string {
  const error = ((entry['error'] as string | undefined) ?? '').toLowerCase();
  const rootCause = ((entry['rootCause'] as string | undefined) ?? '').toLowerCase();

  const meta = entry['meta'] as Record<string, unknown> | undefined;
  const metaEntry = meta?.['entry'] as Record<string, unknown> | undefined;
  const cat = (
    (entry['errorCategory'] as string | undefined) ??
    (metaEntry?.['errorCategory'] as string | undefined) ??
    ''
  ).toLowerCase();

  if (cat === 'auth') return 'config';
  if (cat === 'invocation') return 'config';
  if (cat === 'sandbox') return 'config';
  if (cat === 'permission') return 'config';
  if (cat === 'network') return 'transient';
  if (cat === 'server') return 'transient';
  if (cat === 'oom') return 'transient';
  if (cat === 'crash') return 'transient';
  if (cat === 'signal') return 'transient';
  if (cat === 'internal') return 'transient';
  if (cat === 'codex-jsonl-error') return 'transient';
  if (cat === 'parse') return 'code';
  if (cat === 'silent-crash') return 'config';

  if ((entry['timedOut'] as boolean | undefined) || (entry['signal'] as string | null | undefined))
    return 'transient';
  if (/timeout|timed.?out/i.test(error) || /timeout/i.test(rootCause)) return 'transient';
  if (/segfault|sigsegv|segmentation/i.test(error + rootCause)) return 'transient';
  if (/rate.?limit|429|resource.?exhausted|quota/i.test(error)) return 'transient';

  if (
    /\[auth\]|api.?key|unauthorized|401|403|credentials?.*(?:missing|invalid|expired)/i.test(error)
  )
    return 'config';
  if (/\[invocation\]|unknown\s+flag|command not found|ENOENT/i.test(error)) return 'config';
  if (/\[sandbox\]|sandbox.*(?:violation|error|denied)|execution.*denied/i.test(error))
    return 'config';
  if (/silent.?crash|no output produced/i.test(error)) return 'config';

  if (/something went wrong|mystery error/i.test(error)) return 'transient';
  if (/generic error|non-specific|opaque|placeholder/i.test(rootCause)) return 'transient';

  if (/not configured|not in.*config|missing.*config/i.test(rootCause + error)) return 'config';

  return 'code';
}

/**
 * Select the best agent to fix an issue — avoid using the agent that failed.
 */
function selectFixAgent(entry: Record<string, unknown>): string {
  const failedAgent = (entry['agent'] as string | undefined) ?? 'codex';
  if (failedAgent === 'claude') return 'gemini';
  return 'claude';
}

/**
 * Scan daemon for failed/blocked tasks.
 * @param {string} baseUrl
 * @returns {Promise<ActionItem[]>}
 */
export async function scanDaemonIssues(baseUrl: string): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { request } = await import('./hydra-utils.ts');
    const status = await request('GET', baseUrl, '/status');
    const statusData = status as Record<string, unknown>;
    if (!statusData['tasks']) return items;

    for (const task of statusData['tasks'] as Record<string, unknown>[]) {
      const taskStatus = task['status'] as string;
      if (taskStatus === 'blocked' || taskStatus === 'failed') {
        const taskId = task['id'] as string;
        const taskTitle = (task['title'] as string | undefined) ?? taskId;
        const taskNotes = (task['notes'] as string | undefined) ?? '';
        const assignedTo =
          (task['assignedTo'] as string | undefined) ??
          (task['preferredAgent'] as string | undefined) ??
          'codex';
        items.push({
          id: `daemon-task-${taskId}`,
          title: `${taskStatus === 'blocked' ? 'Blocked' : 'Failed'} task: ${taskTitle}`,
          description: taskNotes,
          category: 'fix',
          severity: taskStatus === 'failed' ? 'high' : 'medium',
          source: 'daemon',
          agent: assignedTo,
          actionPrompt:
            taskStatus === 'failed'
              ? `Investigate and fix the failed task: ${taskTitle}\n\nNotes: ${taskNotes || 'none'}`
              : `Unblock the task: ${taskTitle}\n\nNotes: ${taskNotes || 'none'}`,
          meta: { taskId, daemonTask: task },
        });
      }
    }
  } catch {
    // Daemon unavailable
  }
  return items;
}

/**
 * Scan recent activity for error patterns.
 * @returns {Promise<ActionItem[]>}
 */
export async function scanErrorActivity(): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { getRecentActivity } = await import('./hydra-activity.ts');
    const activities = getRecentActivity(50) as unknown as Record<string, unknown>[];

    for (const act of activities) {
      const actType = act['type'] as string | undefined;
      if (actType?.includes('error') || actType?.includes('failure')) {
        const actTs = act['ts'] as string | number | undefined;
        const actSummary = act['summary'] as string | undefined;
        const actMessage = act['message'] as string | undefined;
        const actDetail = act['detail'] as string | undefined;
        const actAgent = (act['agent'] as string | undefined) ?? 'codex';
        items.push({
          id: `activity-${String(actTs ?? Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
          title: `Error: ${(actSummary ?? actMessage ?? 'Unknown error').slice(0, 100)}`,
          description: actDetail ?? actSummary ?? '',
          category: 'fix',
          severity: 'medium',
          source: 'activity',
          agent: actAgent,
          actionPrompt: `Investigate and fix: ${actSummary ?? actMessage ?? 'Unknown error'}\n\nContext: ${actDetail ?? 'none'}`,
          meta: { activity: act },
        });
      }
    }
  } catch {
    // Activity module unavailable
  }
  return items;
}

/**
 * AI enrichment: use concierge providers to analyze items + CLI context.
 * @param {ActionItem[]} items
 * @param {string} cliContext - Recent CLI output
 * @returns {Promise<ActionItem[]>}
 */
export async function enrichWithDiagnosis(
  items: ActionItem[],
  cliContext: string,
): Promise<ActionItem[]> {
  try {
    const { streamWithFallback } = await import('./hydra-concierge-providers.ts');

    const itemSummary = items
      .map(
        (item, i) => `${String(i + 1)}. [${item.severity}] ${item.title} (source: ${item.source})`,
      )
      .join('\n');

    const prompt = `You are a DevOps diagnostic assistant. Analyze these issues found in the Hydra orchestration system and the recent CLI output.

ISSUES:
${itemSummary}

RECENT CLI OUTPUT:
${cliContext.slice(-3000)}

For each issue, suggest a brief actionPrompt (what an AI coding agent should do to fix it). Also identify any NEW issues visible in the CLI output that aren't in the list above.

Respond as JSON:
{
  "enriched": [{"index": 0, "actionPrompt": "...", "severity": "high|medium|low"}],
  "discovered": [{"title": "...", "description": "...", "severity": "...", "actionPrompt": "..."}]
}`;

    let response = '';
    await streamWithFallback(
      [{ role: 'user', content: prompt }],
      { model: 'gpt-4.1-mini', maxTokens: 1500 },
      (chunk: string) => {
        response += chunk;
      },
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      if (Array.isArray(parsed['enriched'])) {
        for (const enrichment of parsed['enriched'] as Array<Record<string, unknown>>) {
          const idx = enrichment['index'] as number;
          if (idx >= 0 && idx < items.length) {
            if (enrichment['actionPrompt'])
              items[idx]['actionPrompt'] = enrichment['actionPrompt'] as string;
            if (enrichment['severity'])
              items[idx]['severity'] = enrichment['severity'] as ActionItem['severity'];
          }
        }
      }

      if (Array.isArray(parsed['discovered'])) {
        for (const disc of parsed['discovered'] as Array<Record<string, unknown>>) {
          items.push({
            id: `discovered-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
            title: ((disc['title'] as string | undefined) ?? 'Discovered issue').slice(0, 100),
            description: (disc['description'] as string | undefined) ?? '',
            category: 'fix',
            severity: (disc['severity'] as ActionItem['severity'] | undefined) ?? 'medium',
            source: 'cli-output',
            agent: 'codex',
            actionPrompt:
              (disc['actionPrompt'] as string | undefined) ??
              `Fix: ${(disc['title'] as string | undefined) ?? 'issue'}`,
          });
        }
      }
    }
  } catch {
    // Non-fatal: return items with template-based prompts
    for (const item of items) {
      item.actionPrompt ??= `Investigate and fix: ${item.title}\n\n${item.description}`;
    }
  }

  return items;
}

/**
 * Execute a single fix action.
 *
 * Handles three issue types:
 *   - transient: acknowledges and clears from log (no agent dispatch)
 *   - config: shows suggested config change (no agent dispatch)
 *   - code: dispatches a DIFFERENT agent than the one that failed
 *
 * Does NOT log failures back to doctor to prevent feedback loops.
 *
 * @param {ActionItem} item
 * @param {object} opts
 * @returns {Promise<PipelineResult>}
 */
export async function executeFixAction(
  item: ActionItem,
  opts: Record<string, unknown> = {},
): Promise<PipelineResult> {
  const startMs = Date.now();
  const issueType = (item.meta?.['issueType'] as string | undefined) ?? 'code';

  if (issueType === 'transient' || item.category === 'acknowledge') {
    const count = (item.meta?.['count'] as number | undefined) ?? 1;
    const entryForSig = item.meta?.['entry'] as Record<string, unknown> | undefined;
    clearLogEntriesBySignature(entryForSig?.['signature'] as string | undefined);
    return {
      item,
      ok: true,
      output: `Acknowledged ${String(count)} transient occurrence(s) and cleared from log`,
      durationMs: Date.now() - startMs,
    };
  }

  if (issueType === 'config') {
    const entry = (item.meta?.['entry'] as Record<string, unknown> | undefined) ?? {};
    const suggestion = buildConfigSuggestion(entry);
    return {
      item,
      ok: true,
      output: suggestion,
      durationMs: Date.now() - startMs,
    };
  }

  const agent = item.agent ?? 'claude';
  const prompt = item.actionPrompt ?? `Fix: ${item.title}`;
  const projectRoot = opts['projectRoot'] as string | undefined;
  const cwd = projectRoot ?? process.cwd();

  try {
    const { executeAgentWithRecovery } = await import('./hydra-shared/agent-executor.ts');

    const result = await executeAgentWithRecovery(agent, prompt, {
      cwd,
      timeoutMs: 5 * 60 * 1000,
    });

    const ok = result.ok && !result.error;

    // Do NOT call diagnose() here — prevents feedback loop

    return {
      item,
      ok,
      output: result.stdout ?? result.output,
      error: result.error ?? (ok ? undefined : 'Agent returned error'),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      item,
      ok: false,
      error: (err as Error).message,
      durationMs: Date.now() - startMs,
    };
  }
}

/**
 * Remove log entries matching a signature (used when acknowledging transient issues).
 */
function clearLogEntriesBySignature(signature: string | undefined): void {
  if (!signature) return;
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        return entry['signature'] !== signature;
      } catch {
        return true;
      }
    });
    fs.writeFileSync(LOG_PATH, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    _history = _history.filter((h) => h['signature'] !== signature);
  } catch {
    /* best effort */
  }
}

/**
 * Build a human-readable config suggestion for config-type issues.
 */
function buildConfigSuggestion(entry: Record<string, unknown>): string {
  const rootCause = (entry['rootCause'] as string | undefined) ?? '';
  const explanationStr = (entry['explanation'] as string | undefined) ?? rootCause;
  const parts = [`Config issue detected: ${explanationStr}`];
  const phase = (entry['phase'] as string | undefined) ?? 'unknown';
  const entryError = (entry['error'] as string | undefined) ?? '';

  if (/phase.*not configured|not in.*phases/i.test(rootCause + entryError)) {
    parts.push(`Suggestion: Add "${phase}" to investigator.phases in hydra.config.json`);
    parts.push(`Or disable investigation for this phase to suppress the warning.`);
  } else {
    parts.push(`Review hydra.config.json for the relevant section.`);
  }

  return parts.join('\n');
}

// ── Fix Prompt Builder ──────────────────────────────────────────────────────

function buildFixPrompt(entry: Record<string, unknown>): string {
  const explanation = (entry['explanation'] as string | undefined) ?? 'Unknown';
  const rootCause = (entry['rootCause'] as string | undefined) ?? 'unknown';
  const parts = [
    `Fix the following issue in the Hydra orchestration system:`,
    '',
    `Issue: ${explanation}`,
    `Root cause: ${rootCause}`,
  ];

  if (entry['pipeline']) parts.push(`Pipeline: ${entry['pipeline'] as string}`);
  if (entry['phase']) parts.push(`Phase: ${entry['phase'] as string}`);
  if (entry['errorCategory']) parts.push(`Error category: ${entry['errorCategory'] as string}`);
  if (entry['errorDetail']) parts.push(`Error detail: ${entry['errorDetail'] as string}`);
  if (entry['errorContext']) parts.push(`Error context: ${entry['errorContext'] as string}`);
  if (entry['exitCode'] != null) parts.push(`Exit code: ${String(entry['exitCode'] as number)}`);
  if (entry['signal']) parts.push(`Signal: ${entry['signal'] as string}`);
  if (entry['error']) parts.push(`Error: ${(entry['error'] as string).slice(0, 500)}`);
  if (entry['stderrTail']) parts.push(`Stderr: ${(entry['stderrTail'] as string).slice(-500)}`);

  parts.push('');
  parts.push('Investigate the root cause and apply a minimal, targeted fix.');

  return parts.join('\n');
}
