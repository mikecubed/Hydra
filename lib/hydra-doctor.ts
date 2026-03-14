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
        fs.writeFileSync(LOG_PATH, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
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
async function runInvestigator(failure: FailureInfo): Promise<InvestigatorDiagnosis | null> {
  try {
    const inv = await lazyLoadInvestigator();
    if (inv?.isInvestigatorAvailable() === true) {
      _sessionStats.investigations++;
      return (await inv.investigate({
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
  return null;
}

async function resolveFollowUp(
  failure: FailureInfo,
  diagnosis: DoctorDiagnosis,
  cfg: DoctorConfig,
): Promise<unknown> {
  if (diagnosis.action === 'ticket' && cfg.autoCreateSuggestions) {
    return await createFollowUp(failure, diagnosis, 'suggestion');
  }
  if (diagnosis.action === 'fix' && cfg.autoCreateTasks) {
    return await createFollowUp(failure, diagnosis, 'task');
  }
  return null;
}

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

  const investigatorDiagnosis = await runInvestigator(failure);
  const diagnosis = triage(failure, investigatorDiagnosis, recurring, cfg);

  diagnosis.followUp = await resolveFollowUp(failure, diagnosis, cfg);

  if (diagnosis.action !== 'ignore' && cfg.addToKnowledgeBase) {
    await addKBEntry(failure, diagnosis);
  }

  appendLog(failure, diagnosis, signature);

  return diagnosis;
}

// ── Triage Logic ────────────────────────────────────────────────────────────

interface TriageResult {
  severity: string;
  action: string;
  explanation: string;
  rootCause: string;
}

function resolveInvExplanation(invExpl: string, fallback: string): string {
  return invExpl === '' ? fallback : invExpl;
}

function triageFromInvestigator(
  invDiag: string,
  investigatorDiagnosis: InvestigatorDiagnosis | null,
  failure: FailureInfo,
  recurring: boolean,
  cfg: DoctorConfig,
): TriageResult {
  const invExpl = investigatorDiagnosis?.explanation ?? '';
  const invRoot = investigatorDiagnosis?.rootCause ?? 'unknown';

  if (invDiag === 'fundamental') {
    return {
      severity: recurring ? 'critical' : 'high',
      action: 'ticket',
      explanation: resolveInvExplanation(invExpl, 'Fundamental failure requiring investigation'),
      rootCause: invRoot,
    };
  }
  if (invDiag === 'fixable') {
    return {
      severity: recurring ? 'high' : 'medium',
      action: 'fix',
      explanation: resolveInvExplanation(invExpl, 'Fixable issue detected'),
      rootCause: invRoot,
    };
  }
  // transient
  return triageTransient(invExpl, invRoot, failure, recurring, cfg);
}

function triageTransient(
  invExpl: string,
  invRoot: string,
  failure: FailureInfo,
  recurring: boolean,
  cfg: DoctorConfig,
): TriageResult {
  if (recurring) {
    const detail = resolveInvExplanation(invExpl, failure.error ?? 'unknown');
    return {
      severity: 'medium',
      action: 'ticket',
      explanation: `Recurring transient failure (${String(cfg.recurringThreshold)}+ occurrences): ${detail}`,
      rootCause: invRoot === 'unknown' ? 'recurring_transient' : invRoot,
    };
  }
  return {
    severity: 'low',
    action: 'ignore',
    explanation: resolveInvExplanation(invExpl, 'Transient failure'),
    rootCause: invRoot === 'unknown' ? 'transient' : invRoot,
  };
}

function formatExitSignalInfo(failure: FailureInfo): { exitInfo: string; signalInfo: string } {
  const exitInfo = failure.exitCode == null ? '' : ` (exit ${String(failure.exitCode)})`;
  const signalStr = failure.signal ?? '';
  const signalInfo = signalStr === '' ? '' : ` (signal ${signalStr})`;
  return { exitInfo, signalInfo };
}

function triageHeuristic(failure: FailureInfo, recurring: boolean): TriageResult {
  if (failure.timedOut === true) {
    return {
      severity: recurring ? 'medium' : 'low',
      action: recurring ? 'ticket' : 'ignore',
      explanation: `Agent timed out${recurring ? ' (recurring)' : ''}`,
      rootCause: 'timeout',
    };
  }

  const errorCat = failure.errorCategory ?? '';
  if (errorCat !== '' && errorCat !== 'unclassified') {
    const { exitInfo, signalInfo } = formatExitSignalInfo(failure);
    return {
      severity: recurring ? 'high' : 'medium',
      action: recurring ? 'ticket' : 'fix',
      explanation: `[${errorCat}] ${failure.errorDetail ?? failure.error ?? 'unknown'}${exitInfo}${signalInfo}`,
      rootCause: errorCat,
    };
  }

  return triageUnknown(failure);
}

function triageUnknown(failure: FailureInfo): TriageResult {
  const { exitInfo, signalInfo } = formatExitSignalInfo(failure);
  const errorStr = failure.error ?? '';
  const stderrStr = failure.stderr ?? '';
  let stderrHint = '';
  if (errorStr === '' && stderrStr !== '') {
    stderrHint =
      stderrStr
        .replace(/\[Hydra Telemetry\].*?\n/g, '')
        .trim()
        .split('\n')[0]
        ?.slice(0, 150) ?? '';
  }

  const errorSlice = errorStr.slice(0, 200);
  let explanationBase = 'Unknown failure without investigator';
  if (errorSlice !== '') {
    explanationBase = errorSlice;
  } else if (stderrHint !== '') {
    explanationBase = stderrHint;
  }

  return {
    severity: 'medium',
    action: 'ticket',
    explanation: explanationBase + exitInfo + signalInfo,
    rootCause: 'unknown',
  };
}

function updateSessionStats(action: string): void {
  if (action === 'fix') _sessionStats.fixes++;
  else if (action === 'ticket') _sessionStats.tickets++;
  else _sessionStats.ignored++;
}

function triage(
  failure: FailureInfo,
  investigatorDiagnosis: InvestigatorDiagnosis | null,
  recurring: boolean,
  cfg: DoctorConfig,
): DoctorDiagnosis {
  const invDiag = investigatorDiagnosis?.diagnosis ?? '';

  const result: TriageResult =
    invDiag === 'fundamental' || invDiag === 'fixable' || invDiag === 'transient'
      ? triageFromInvestigator(invDiag, investigatorDiagnosis, failure, recurring, cfg)
      : triageHeuristic(failure, recurring);

  if (recurring && result.action === 'ignore') {
    result.action = 'ticket';
    result.severity = 'medium';
  }

  updateSessionStats(result.action);

  return {
    ...result,
    followUp: null as unknown,
    investigatorDiagnosis: investigatorDiagnosis ?? null,
    recurring,
  };
}

// ── Signature & Recurrence ──────────────────────────────────────────────────

function enrichErrorWithStderr(errorText: string, stderr: string): string {
  const stderrClean = stderr.replace(/\[Hydra Telemetry\].*?\n/g, '').trim();
  if (stderrClean === '') return errorText;
  const lines = stderrClean.split('\n').filter((l: string) => !l.startsWith('[Hydra Telemetry]'));
  if (lines.length > 0) {
    return `${errorText} (${lines[0].trim()})`;
  }
  return errorText;
}

function categorizeErrorText(failure: FailureInfo): string {
  let errorText = failure.error ?? '';
  const errorCat = failure.errorCategory ?? '';
  const signalStr = failure.signal ?? '';

  if (errorCat !== '' && errorCat !== 'unclassified') {
    errorText = `[${errorCat}] ${failure.errorDetail ?? errorText}`;
  } else if (signalStr !== '') {
    errorText = `Signal ${signalStr}${errorText === '' ? '' : ` (${errorText})`}`;
  }
  return errorText;
}

function buildSignature(failure: FailureInfo): string {
  const agent = failure.agent ?? 'unknown';
  const phase = failure.phase ?? 'unknown';
  let errorText = categorizeErrorText(failure);

  const isGeneric =
    errorText.includes('Exit code') ||
    errorText === 'Process terminated abnormally' ||
    errorText.startsWith('[unclassified]');

  const stderrStr = failure.stderr ?? '';
  if (isGeneric && stderrStr !== '') {
    errorText = enrichErrorWithStderr(errorText, stderrStr);
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

function labelIfPresent(label: string, val: string): string | null {
  return val === '' ? null : `${label}: ${val}`;
}

function buildFollowUpNotes(failure: FailureInfo, diagnosis: DoctorDiagnosis): string {
  return [
    `Pipeline: ${failure.pipeline}`,
    `Phase: ${failure.phase ?? 'unknown'}`,
    `Agent: ${failure.agent ?? 'unknown'}`,
    `Root cause: ${diagnosis.rootCause}`,
    labelIfPresent('Error category', failure.errorCategory ?? ''),
    labelIfPresent('Error detail', failure.errorDetail ?? ''),
    labelIfPresent('Error context', failure.errorContext ?? ''),
    failure.exitCode == null ? '' : `Exit code: ${String(failure.exitCode)}`,
    labelIfPresent('Signal', failure.signal ?? ''),
    diagnosis.recurring ? 'Status: RECURRING' : '',
    labelIfPresent('Branch', failure.branchName ?? ''),
    labelIfPresent('Task', failure.taskTitle ?? ''),
  ]
    .filter(Boolean)
    .join('\n');
}

async function createFollowUp(
  failure: FailureInfo,
  diagnosis: DoctorDiagnosis,
  type: string,
): Promise<unknown> {
  const errorCat = failure.errorCategory ?? '';
  const titleDetail =
    errorCat !== '' && errorCat !== 'unclassified'
      ? `[${errorCat}] ${(failure.errorDetail ?? diagnosis.explanation).slice(0, 70)}`
      : diagnosis.explanation.slice(0, 80);
  const title = `[doctor] ${failure.pipeline}: ${titleDetail}`;
  const notes = buildFollowUpNotes(failure, diagnosis);
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
    return result != null && (result as Record<string, unknown>)['error'] == null;
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

function sliceOrNull(val: string | undefined, maxLen: number): string | null {
  const s = (val ?? '').slice(-maxLen);
  return s === '' ? null : s;
}

function orNull<T>(val: T | undefined | null): T | null {
  return val ?? null;
}

function buildFailureLogFields(failure: FailureInfo): Record<string, unknown> {
  const errorCtxSlice = (failure.errorContext ?? '').slice(0, 300);
  return {
    pipeline: failure.pipeline,
    phase: orNull(failure.phase),
    agent: orNull(failure.agent),
    error: (failure.error ?? '').slice(0, 500),
    exitCode: orNull(failure.exitCode),
    signal: orNull(failure.signal),
    command: orNull(failure.command),
    args: orNull(failure.args),
    promptSnippet: orNull(failure.promptSnippet),
    stderrTail: sliceOrNull(failure.stderr, 500),
    stdoutTail: sliceOrNull(failure.stdout, 500),
    timedOut: failure.timedOut ?? false,
    taskTitle: orNull(failure.taskTitle),
    branchName: orNull(failure.branchName),
    errorCategory: orNull(failure.errorCategory),
    errorDetail: orNull(failure.errorDetail),
    errorContext: errorCtxSlice === '' ? null : errorCtxSlice,
  };
}

function buildLogEntry(
  failure: FailureInfo,
  diagnosis: DoctorDiagnosis,
  signature: string,
  ts: string,
): Record<string, unknown> {
  return {
    ts,
    ...buildFailureLogFields(failure),
    signature,
    severity: diagnosis.severity,
    action: diagnosis.action,
    explanation: diagnosis.explanation,
    rootCause: diagnosis.rootCause,
    recurring: diagnosis.recurring,
    followUp: diagnosis.followUp,
  };
}

function appendLog(failure: FailureInfo, diagnosis: DoctorDiagnosis, signature: string): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const ts = new Date().toISOString();
    const entry = buildLogEntry(failure, diagnosis, signature, ts);

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
type SigEntry = { entry: Record<string, unknown>; count: number };

function deduplicateHistory(history: Record<string, unknown>[]): Map<string, SigEntry> {
  const bySignature = new Map<string, SigEntry>();

  for (const entry of history) {
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
    if (existing == null || new Date(entryTs) > new Date(existing.entry['ts'] as string)) {
      bySignature.set(sig, { entry, count: (existing?.count ?? 0) + 1 });
    } else {
      existing.count++;
    }
  }

  return bySignature;
}

function buildDoctorItemDescription(entry: Record<string, unknown>, count: number): string {
  const errorCatStr = (entry['errorCategory'] as string | undefined) ?? '';
  const errorDetailStr = (entry['errorDetail'] as string | undefined) ?? '';
  const signalStr = (entry['signal'] as string | undefined) ?? '';
  const errorStr = (entry['error'] as string | undefined) ?? '';
  const entryRecurring = entry['recurring'] as boolean | undefined;

  return [
    `Pipeline: ${(entry['pipeline'] as string | undefined) ?? 'unknown'}`,
    `Phase: ${(entry['phase'] as string | undefined) ?? 'unknown'}`,
    `Agent: ${(entry['agent'] as string | undefined) ?? 'unknown'}`,
    `Root cause: ${(entry['rootCause'] as string | undefined) ?? 'unknown'}`,
    labelIfPresent('Category', errorCatStr),
    labelIfPresent('Detail', errorDetailStr),
    entry['exitCode'] == null ? null : `Exit: ${String(entry['exitCode'] as number)}`,
    labelIfPresent('Signal', signalStr),
    count > 1 ? `Occurrences: ${String(count)}` : null,
    entryRecurring === true ? 'RECURRING' : null,
    errorStr === '' ? null : `Error: ${errorStr.slice(0, 200)}`,
  ]
    .filter(Boolean)
    .join(' | ');
}

function buildDoctorItem(sig: string, entry: Record<string, unknown>, count: number): ActionItem {
  const countLabel = count > 1 ? ` (${String(count)}x)` : '';
  const isTransient = classifyIssueType(entry) === 'transient';
  const entryExplanation = entry['explanation'] as string | undefined;
  const entrySeverity = entry['severity'] as 'critical' | 'high' | 'medium' | 'low' | undefined;

  return {
    id: `doctor-${sig.slice(0, 40)}`,
    title: `${(entryExplanation ?? 'Unknown issue').slice(0, 90)}${countLabel}`,
    description: buildDoctorItemDescription(entry, count),
    category: isTransient ? 'acknowledge' : 'fix',
    severity: entrySeverity ?? 'medium',
    source: 'doctor-log',
    agent: selectFixAgent(entry),
    actionPrompt: isTransient ? undefined : buildFixPrompt(entry),
    meta: { entry, count, issueType: classifyIssueType(entry) },
  };
}

export function scanDoctorLog(): Promise<ActionItem[]> {
  if (!_initialized) initDoctor();

  const bySignature = deduplicateHistory(_history);
  const items: ActionItem[] = [];

  for (const [sig, { entry, count }] of bySignature) {
    items.push(buildDoctorItem(sig, entry, count));
  }

  return Promise.resolve(items);
}

/**
 * Classify an issue as transient, config, invocation, auth, or code.
 * Uses structured errorCategory from diagnoseAgentError when available.
 * Also checks the log entry fields that may have been persisted.
 */
const CATEGORY_CONFIG_SET = new Set([
  'auth',
  'invocation',
  'sandbox',
  'permission',
  'silent-crash',
]);
const CATEGORY_TRANSIENT_SET = new Set([
  'network',
  'server',
  'oom',
  'crash',
  'signal',
  'internal',
  'codex-jsonl-error',
]);

function classifyByCategory(cat: string): string | null {
  if (CATEGORY_CONFIG_SET.has(cat)) return 'config';
  if (CATEGORY_TRANSIENT_SET.has(cat)) return 'transient';
  if (cat === 'parse') return 'code';
  return null;
}

function classifyByEntryFields(entry: Record<string, unknown>): string | null {
  const timedOut = entry['timedOut'] as boolean | undefined;
  const signal = entry['signal'] as string | null | undefined;
  if (timedOut === true || (signal != null && signal !== '')) return 'transient';
  return null;
}

function classifyByErrorPatterns(error: string, rootCause: string): string | null {
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

  return null;
}

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

  const byCat = classifyByCategory(cat);
  if (byCat != null) return byCat;

  const byFields = classifyByEntryFields(entry);
  if (byFields != null) return byFields;

  return classifyByErrorPatterns(error, rootCause) ?? 'code';
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
    if (statusData['tasks'] == null) return items;

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
        const notesLabel = taskNotes === '' ? 'none' : taskNotes;
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
              ? `Investigate and fix the failed task: ${taskTitle}\n\nNotes: ${notesLabel}`
              : `Unblock the task: ${taskTitle}\n\nNotes: ${notesLabel}`,
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
function buildActivityItem(act: Record<string, unknown>): ActionItem {
  const actTs = act['ts'] as string | number | undefined;
  const actSummary = act['summary'] as string | undefined;
  const actMessage = act['message'] as string | undefined;
  const actDetail = act['detail'] as string | undefined;
  const actAgent = (act['agent'] as string | undefined) ?? 'codex';
  const errorLabel = actSummary ?? actMessage ?? 'Unknown error';

  return {
    id: `activity-${String(actTs ?? Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    title: `Error: ${errorLabel.slice(0, 100)}`,
    description: actDetail ?? actSummary ?? '',
    category: 'fix',
    severity: 'medium',
    source: 'activity',
    agent: actAgent,
    actionPrompt: `Investigate and fix: ${errorLabel}\n\nContext: ${actDetail ?? 'none'}`,
    meta: { activity: act },
  };
}

export async function scanErrorActivity(): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  try {
    const { getRecentActivity } = await import('./hydra-activity.ts');
    const activities = getRecentActivity(50) as unknown as Record<string, unknown>[];

    for (const act of activities) {
      const actType = act['type'] as string | undefined;
      if (actType?.includes('error') === true || actType?.includes('failure') === true) {
        items.push(buildActivityItem(act));
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
function applyEnrichments(items: ActionItem[], enriched: Array<Record<string, unknown>>): void {
  for (const enrichment of enriched) {
    const idx = enrichment['index'] as number;
    if (idx >= 0 && idx < items.length) {
      const prompt = enrichment['actionPrompt'] as string | undefined;
      if (prompt != null && prompt !== '') {
        items[idx]['actionPrompt'] = prompt;
      }
      const sev = enrichment['severity'] as ActionItem['severity'] | undefined;
      if (sev != null) {
        items[idx]['severity'] = sev;
      }
    }
  }
}

function addDiscoveredItems(items: ActionItem[], discovered: Array<Record<string, unknown>>): void {
  for (const disc of discovered) {
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
    if (jsonMatch != null) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      if (Array.isArray(parsed['enriched'])) {
        applyEnrichments(items, parsed['enriched'] as Array<Record<string, unknown>>);
      }
      if (Array.isArray(parsed['discovered'])) {
        addDiscoveredItems(items, parsed['discovered'] as Array<Record<string, unknown>>);
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
function handleTransientAction(item: ActionItem, startMs: number): PipelineResult {
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

function handleConfigAction(item: ActionItem, startMs: number): PipelineResult {
  const entry = (item.meta?.['entry'] as Record<string, unknown> | undefined) ?? {};
  const suggestion = buildConfigSuggestion(entry);
  return {
    item,
    ok: true,
    output: suggestion,
    durationMs: Date.now() - startMs,
  };
}

async function handleCodeAction(
  item: ActionItem,
  opts: Record<string, unknown>,
  startMs: number,
): Promise<PipelineResult> {
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

    const resultError = result.error ?? '';
    const ok = result.ok && resultError === '';

    let errorMsg: string | undefined;
    if (resultError !== '') {
      errorMsg = resultError;
    } else if (!ok) {
      errorMsg = 'Agent returned error';
    }

    return {
      item,
      ok,
      output: result.stdout ?? result.output,
      error: errorMsg,
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

export async function executeFixAction(
  item: ActionItem,
  opts: Record<string, unknown> = {},
): Promise<PipelineResult> {
  const startMs = Date.now();
  const issueType = (item.meta?.['issueType'] as string | undefined) ?? 'code';

  if (issueType === 'transient' || item.category === 'acknowledge') {
    return handleTransientAction(item, startMs);
  }

  if (issueType === 'config') {
    return handleConfigAction(item, startMs);
  }

  return await handleCodeAction(item, opts, startMs);
}

/**
 * Remove log entries matching a signature (used when acknowledging transient issues).
 */
function clearLogEntriesBySignature(signature: string | undefined): void {
  if (signature == null || signature === '') return;
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
    fs.writeFileSync(LOG_PATH, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
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

function appendEntryField(
  parts: string[],
  entry: Record<string, unknown>,
  key: string,
  label: string,
): void {
  const val = entry[key] as string | undefined;
  if (val != null && val !== '') {
    parts.push(`${label}: ${val}`);
  }
}

function buildFixPrompt(entry: Record<string, unknown>): string {
  const explanation = (entry['explanation'] as string | undefined) ?? 'Unknown';
  const rootCause = (entry['rootCause'] as string | undefined) ?? 'unknown';
  const parts = [
    `Fix the following issue in the Hydra orchestration system:`,
    '',
    `Issue: ${explanation}`,
    `Root cause: ${rootCause}`,
  ];

  appendEntryField(parts, entry, 'pipeline', 'Pipeline');
  appendEntryField(parts, entry, 'phase', 'Phase');
  appendEntryField(parts, entry, 'errorCategory', 'Error category');
  appendEntryField(parts, entry, 'errorDetail', 'Error detail');
  appendEntryField(parts, entry, 'errorContext', 'Error context');
  if (entry['exitCode'] != null) parts.push(`Exit code: ${String(entry['exitCode'] as number)}`);
  appendEntryField(parts, entry, 'signal', 'Signal');

  const errorStr = (entry['error'] as string | undefined) ?? '';
  if (errorStr !== '') parts.push(`Error: ${errorStr.slice(0, 500)}`);
  const stderrStr = (entry['stderrTail'] as string | undefined) ?? '';
  if (stderrStr !== '') parts.push(`Stderr: ${stderrStr.slice(-500)}`);

  parts.push('');
  parts.push('Investigate the root cause and apply a minimal, targeted fix.');

  return parts.join('\n');
}
