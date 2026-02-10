/**
 * Shared Agent Executor — Unified executeAgent() with all options from both pipelines.
 *
 * Features adopted from evolve:
 *   - Stderr capture (32KB buffer)
 *   - Stdin piping (avoids Windows 8191-char limit)
 *   - Progress ticking (elapsed + KB every N seconds)
 *   - Status bar integration
 *   - Configurable output buffer size (default 128KB)
 *
 * Features from nightly:
 *   - Simple agent dispatch (claude/codex)
 *   - Timeout + kill
 */

import spawn from 'cross-spawn';
import { getActiveModel } from '../hydra-agents.mjs';
import { detectModelError, recoverFromModelError, isModelRecoveryEnabled } from '../hydra-model-recovery.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 32 * 1024;

/**
 * Execute an agent CLI as a headless subprocess.
 *
 * @param {string} agent - Agent name: 'claude', 'codex', 'gemini'
 * @param {string} prompt - The prompt to send
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Working directory
 * @param {number} [opts.timeoutMs] - Timeout in ms (default: 15 min)
 * @param {string} [opts.modelOverride] - Model override string
 * @param {boolean} [opts.collectStderr=true] - Collect stderr output
 * @param {boolean} [opts.useStdin=true] - Pipe prompt via stdin (avoids Windows cmd limits)
 * @param {number} [opts.progressIntervalMs=0] - Log progress every N ms (0 = disabled)
 * @param {Function} [opts.onProgress] - Callback: (elapsed, outputKB) => void
 * @param {Function} [opts.onStatusBar] - Callback for status bar updates: (agent, meta) => void
 * @param {number} [opts.maxOutputBytes] - Max stdout buffer (default: 128KB)
 * @param {number} [opts.maxStderrBytes] - Max stderr buffer (default: 32KB)
 * @param {string} [opts.phaseLabel] - Label for status bar (e.g., 'Task 3/5')
 * @returns {Promise<{ok: boolean, output: string, stderr: string, error: string|null, durationMs: number, timedOut: boolean}>}
 */
export function executeAgent(agent, prompt, opts = {}) {
  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    modelOverride,
    collectStderr = true,
    useStdin = true,
    progressIntervalMs = 0,
    onProgress,
    onStatusBar,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    phaseLabel,
  } = opts;

  if (modelOverride && !/^[a-zA-Z0-9-.:]+$/.test(modelOverride)) {
    return Promise.resolve({
      ok: false,
      output: '',
      stderr: `Invalid model override format: "${modelOverride}"`,
      error: 'Security violation: invalid model format',
      durationMs: 0,
      timedOut: false
    });
  }

  return new Promise((resolve) => {
    let cmd, args;
    const useStdinForPrompt = useStdin;

    if (agent === 'codex') {
      args = ['exec', '-', '--full-auto'];
      if (cwd) args.push('-C', cwd);
      const effectiveModel = modelOverride || getActiveModel('codex');
      if (effectiveModel) args.push('--model', effectiveModel);
      cmd = 'codex';
    } else if (agent === 'gemini') {
      args = [];
      if (!useStdinForPrompt) args.push(prompt);
      cmd = 'gemini';
    } else {
      // claude
      if (useStdinForPrompt) {
        args = ['--output-format', 'json', '--permission-mode', 'auto-edit'];
      } else {
        args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'auto-edit'];
      }
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'claude';
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    const stderrChunks = [];
    let stderrBytes = 0;

    const stdinMode = useStdinForPrompt ? 'pipe' : 'ignore';

    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: [stdinMode, 'pipe', 'pipe'],
    });

    // Pipe prompt via stdin if applicable
    if (useStdinForPrompt && child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => {
      stdoutBytes += Buffer.byteLength(d);
      stdoutChunks.push(d);
      while (stdoutBytes > maxOutputBytes && stdoutChunks.length > 1) {
        const dropped = stdoutChunks.shift();
        stdoutBytes -= Buffer.byteLength(dropped);
      }
    });

    if (collectStderr) {
      child.stderr.on('data', (d) => {
        stderrBytes += Buffer.byteLength(d);
        stderrChunks.push(d);
        while (stderrBytes > maxStderrBytes && stderrChunks.length > 1) {
          const dropped = stderrChunks.shift();
          stderrBytes -= Buffer.byteLength(dropped);
        }
      });
    } else {
      child.stderr.on('data', () => {});
    }

    const startTime = Date.now();
    let timedOut = false;

    // Timeout
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);

    // Progress ticking
    let progressTimer = null;
    if (progressIntervalMs > 0 && onProgress) {
      progressTimer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const outputKB = Math.round(stdoutBytes / 1024);
        onProgress(elapsed, outputKB);
      }, progressIntervalMs);
    }

    // Status bar update
    if (onStatusBar) {
      onStatusBar(agent, { phase: phaseLabel || 'executing', step: 'running' });
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      const output = stdoutChunks.join('');
      resolve({
        ok: false,
        output,
        stdout: output, // alias for metrics compatibility
        stderr: stderrChunks.join(''),
        error: err.message,
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      if (onStatusBar) {
        onStatusBar(agent, { phase: phaseLabel || 'done', step: 'idle' });
      }
      const output = stdoutChunks.join('');
      resolve({
        ok: code === 0,
        output,
        stdout: output, // alias for metrics compatibility
        stderr: stderrChunks.join(''),
        error: code !== 0 ? `Exit code ${code}` : null,
        durationMs: Date.now() - startTime,
        timedOut,
      });
    });
  });
}

/**
 * Execute an agent with automatic model-error recovery.
 *
 * Calls executeAgent() first. If the result indicates a model error
 * (e.g. "model not found"), attempts to select a fallback model and retry.
 *
 * @param {string} agent - Agent name
 * @param {string} prompt - The prompt to send
 * @param {object} [opts] - Same options as executeAgent, plus:
 * @param {object} [opts.rl] - readline interface for interactive fallback selection
 * @returns {Promise<object>} executeAgent result, augmented with { recovered, originalModel }
 */
export async function executeAgentWithRecovery(agent, prompt, opts = {}) {
  const result = await executeAgent(agent, prompt, opts);

  if (result.ok || !isModelRecoveryEnabled()) {
    return result;
  }

  const detection = detectModelError(agent, result);
  if (!detection.isModelError) {
    return result;
  }

  const recovery = await recoverFromModelError(agent, detection.failedModel, {
    rl: opts.rl,
  });

  if (!recovery.recovered) {
    result.modelError = detection;
    return result;
  }

  // Retry with the new model
  const retryResult = await executeAgent(agent, prompt, {
    ...opts,
    modelOverride: recovery.newModel,
  });

  retryResult.recovered = true;
  retryResult.originalModel = detection.failedModel;
  retryResult.newModel = recovery.newModel;
  return retryResult;
}
