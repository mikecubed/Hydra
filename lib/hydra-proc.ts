/**
 * Hydra process helpers.
 *
 * Some sandboxed environments (including certain CI / agent sandboxes) forbid
 * creating stdio pipes for child processes, returning EPERM when `stdio: 'pipe'`
 * is used (the default for spawnSync/exec). Hydra uses sync process execution
 * for git/gh and other tooling, so we provide a best-effort fallback that
 * captures stdout/stderr via temporary files (no pipes).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 * 8;

interface SpawnSyncCaptureOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  encoding?: BufferEncoding;
  windowsHide?: boolean;
  shell?: boolean;
  input?: string | Buffer;
  maxOutputBytes?: number;
  noPipes?: boolean;
}

interface SpawnSyncCaptureResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  signal: string | null;
}

function safeRm(dirPath: string) {
  if (dirPath === '') return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function readFileTruncated(filePath: string, maxBytes: number, encoding: BufferEncoding): string {
  try {
    const st = fs.statSync(filePath);
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_OUTPUT_BYTES;
    if (st.size <= limit) {
      return fs.readFileSync(filePath, { encoding });
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(limit);
      const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
      const suffix = `\n... (truncated, showing first ${String(bytesRead)} bytes)`;
      return buf.subarray(0, bytesRead).toString(encoding) + suffix;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  } catch {
    return '';
  }
}

/**
 * Detect if this environment supports spawning child processes with piped stdio.
 * @returns {boolean}
 */
export function supportsPipedStdio(): boolean {
  try {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5_000,
    });
    if (r.error && ((r.error as NodeJS.ErrnoException).code ?? '') === 'EPERM') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function closeFdSafe(fd: number | 'ignore' | null): void {
  if (typeof fd === 'number') {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function buildStdinFd(
  stdinPath: string,
  input: string | Buffer | undefined,
  encoding: BufferEncoding,
): number | 'ignore' {
  if (input === undefined) return 'ignore';
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, encoding);
  fs.writeFileSync(stdinPath, buf);
  return fs.openSync(stdinPath, 'r');
}

function trySpawnWithPipes(
  command: string,
  args: string[],
  opts: SpawnSyncCaptureOpts,
  encoding: BufferEncoding,
  maxOutputBytes: number,
): SpawnSyncCaptureResult | null {
  const r = spawnSync(command, Array.isArray(args) ? args : [], {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout,
    encoding,
    windowsHide: opts.windowsHide !== false,
    shell: Boolean(opts.shell),
    input: opts.input,
    maxBuffer: maxOutputBytes,
  });
  const isEPERM =
    r.error !== undefined && ((r.error as NodeJS.ErrnoException).code ?? '') === 'EPERM';
  if (isEPERM) return null;
  return {
    status: r.status ?? null,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error ?? null,
    signal: r.signal ?? null,
  };
}

function spawnWithTempFiles(
  command: string,
  args: string[],
  opts: SpawnSyncCaptureOpts,
  encoding: BufferEncoding,
  maxOutputBytes: number,
): SpawnSyncCaptureResult {
  let tmpDir = '';
  let stdinFd: number | 'ignore' = 'ignore';
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-proc-'));
    const stdoutPath = path.join(tmpDir, 'stdout.txt');
    const stderrPath = path.join(tmpDir, 'stderr.txt');

    stdoutFd = fs.openSync(stdoutPath, 'w');
    stderrFd = fs.openSync(stderrPath, 'w');
    stdinFd = buildStdinFd(path.join(tmpDir, 'stdin.txt'), opts.input, encoding);

    const r = spawnSync(command, Array.isArray(args) ? args : [], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      windowsHide: opts.windowsHide !== false,
      shell: Boolean(opts.shell),
      stdio: [stdinFd, stdoutFd, stderrFd],
    });

    // Close fds before reading so the OS flushes all writes.
    closeFdSafe(stdinFd);
    closeFdSafe(stdoutFd);
    closeFdSafe(stderrFd);

    const stdout = readFileTruncated(stdoutPath, maxOutputBytes, encoding);
    const stderr = readFileTruncated(stderrPath, maxOutputBytes, encoding);

    return {
      status: r.status ?? null,
      stdout,
      stderr,
      error: r.error ?? null,
      signal: r.signal ?? null,
    };
  } finally {
    // Guard against early exceptions leaving fds open.
    closeFdSafe(stdinFd);
    closeFdSafe(stdoutFd);
    closeFdSafe(stderrFd);
    safeRm(tmpDir);
  }
}

/**
 * Spawn synchronously and capture stdout/stderr. Falls back to file-backed
 * stdio capture when pipes are forbidden (EPERM).
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {object} [opts.env]
 * @param {number} [opts.timeout]
 * @param {string} [opts.encoding='utf8']
 * @param {boolean} [opts.windowsHide=true]
 * @param {boolean} [opts.shell=false]
 * @param {string|Buffer} [opts.input] - stdin data (no pipes fallback uses temp file)
 * @param {number} [opts.maxOutputBytes=8MiB] - per stream cap when using file capture
 * @param {boolean} [opts.noPipes=false] - force file-backed capture
 * @returns {{ status: number|null, stdout: string, stderr: string, error: Error|null, signal: string|null }}
 */
export function spawnSyncCapture(
  command: string,
  args: string[] = [],
  opts: SpawnSyncCaptureOpts = {},
): SpawnSyncCaptureResult {
  const encoding = opts.encoding ?? 'utf8';
  const maxOutputBytes: number = Number.isFinite(opts.maxOutputBytes)
    ? (opts.maxOutputBytes as number)
    : DEFAULT_MAX_OUTPUT_BYTES;
  const forceNoPipes = Boolean(opts.noPipes ?? process.env['HYDRA_NO_PIPES']);

  if (!forceNoPipes) {
    const result = trySpawnWithPipes(command, args, opts, encoding, maxOutputBytes);
    if (result !== null) return result;
  }

  return spawnWithTempFiles(command, args, opts, encoding, maxOutputBytes);
}
