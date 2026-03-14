/**
 * Hydra MCP Client
 *
 * JSON-RPC over stdio transport for communicating with MCP servers
 * (primarily Codex MCP). Enables multi-turn context, structured tool calls,
 * and event streaming.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { loadHydraConfig } from './hydra-config.ts';

let requestIdCounter = 0;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * MCPClient manages a long-lived child process communicating via JSON-RPC over stdin/stdout.
 */
export class MCPClient extends EventEmitter {
  command: string;
  args: string[];
  cwd: string;
  sessionTimeout: number;
  child: ReturnType<typeof spawn> | null;
  pending: Map<number, PendingRequest>;
  buffer: string;
  startedAt: number | null;
  lastActivityAt: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;

  constructor(
    command: string,
    args: string[] = [],
    opts: { cwd?: string; sessionTimeout?: number } = {},
  ) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = opts.cwd ?? process.cwd();
    this.sessionTimeout = opts.sessionTimeout ?? 300_000;
    this.child = null;
    this.pending = new Map<number, PendingRequest>();
    this.buffer = '';
    this.startedAt = null;
    this.lastActivityAt = null;
    this.idleTimer = null;
  }

  /**
   * Spawn the MCP server process and initialize JSON-RPC.
   */
  async start(): Promise<unknown> {
    if (this.child) return;

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // stdout and stderr are always defined with stdio: ['pipe', 'pipe', 'pipe']
    if (this.child.stdout) {
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (data: unknown) => {
        this._onData(String(data));
      });
    }
    if (this.child.stderr) {
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (data: unknown) => this.emit('stderr', data));
    }

    this.child.on('error', (err) => {
      this.emit('error', err);
      this._rejectAll(err);
    });

    this.child.on('close', (code) => {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      this.emit('close', code);
      this._rejectAll(new Error(`MCP process exited with code ${String(code)}`));
      this.child = null;
    });

    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();
    this._resetIdleTimer();

    // Send initialize request
    const initResult = await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hydra', version: '1.0.0' },
    });

    // Send initialized notification
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    return initResult;
  }

  /**
   * Send a JSON-RPC request and await the response.
   */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('MCP client not started'));
        return;
      }

      const id = ++requestIdCounter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.lastActivityAt = Date.now();
      this._resetIdleTimer();

      this._send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  /**
   * Call an MCP tool.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<unknown> {
    return this.call('tools/call', { name: toolName, arguments: args }, timeoutMs);
  }

  /**
   * List available tools.
   */
  async listTools(): Promise<unknown> {
    return this.call('tools/list', {});
  }

  /**
   * Graceful shutdown.
   */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.child) return;

    this._rejectAll(new Error('MCP client closing'));

    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }

    // Give process time to exit gracefully
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child) {
          this.child.kill();
        }
        resolve();
      }, 3_000);

      if (this.child) {
        this.child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    });

    this.child = null;
  }

  /**
   * Check if the MCP server is alive.
   */
  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * Get uptime in milliseconds.
   */
  uptimeMs(): number {
    return this.startedAt == null ? 0 : Date.now() - this.startedAt;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _send(obj: Record<string, unknown>): void {
    if (this.child?.stdin?.writable !== true) return;
    const json = JSON.stringify(obj);
    try {
      this.child.stdin.write(`${json}\n`);
    } catch {
      /* ignore write errors */
    }
  }

  _onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? ''; // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        this._handleMessage(msg);
      } catch {
        /* skip non-JSON lines */
      }
    }
  }

  _handleMessage(msg: Record<string, unknown>): void {
    // Response to a request
    if (msg['id'] !== undefined && this.pending.has(msg['id'] as number)) {
      const pending = this.pending.get(msg['id'] as number);
      if (pending == null) return;
      this.pending.delete(msg['id'] as number);
      clearTimeout(pending.timer);

      if (msg['error'] == null) {
        pending.resolve(msg['result']);
      } else {
        const errRecord = msg['error'] as Record<string, unknown>;
        const errMsg =
          typeof errRecord['message'] === 'string' && errRecord['message'] !== ''
            ? errRecord['message']
            : 'MCP error';
        pending.reject(new Error(errMsg));
      }
      return;
    }

    // Notification (no id)
    if (msg['method'] != null) {
      this.emit('notification', msg);
    }
  }

  _rejectAll(err: Error): void {
    for (const [_id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  _resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.emit('idle');
      void this.close();
    }, this.sessionTimeout);
    this.idleTimer.unref(); // Don't prevent process exit when idle
  }
}

// ── High-Level Codex MCP Helper ───────────────────────────────────────────────

let codexClient: MCPClient | null = null;

/**
 * Get or create a Codex MCP client.
 */
function extractMCPText(result: Record<string, unknown> | null): string {
  if (result == null) return '';
  if (Array.isArray(result['content'])) {
    return (result['content'] as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  }
  if (typeof result['content'] === 'string') {
    return result['content'];
  }
  // Fallback: preserve non-standard MCP responses instead of silently dropping them
  try {
    return JSON.stringify(result);
  } catch {
    return '';
  }
}

export function getCodexMCPClient(opts: { cwd?: string } = {}): MCPClient | null {
  const cfg = loadHydraConfig();
  const mcpConfig = (cfg as Record<string, unknown>)['mcp'] as Record<string, unknown> | undefined;
  const codexMcpConfig = mcpConfig?.['codex'] as Record<string, unknown> | undefined;

  if (codexMcpConfig?.['enabled'] !== true) return null;
  if (codexClient?.isAlive() === true) return codexClient;

  codexClient = new MCPClient(
    (codexMcpConfig['command'] as string | undefined) ?? 'codex',
    (codexMcpConfig['args'] as string[] | undefined) ?? ['mcp-server'],
    {
      cwd: opts.cwd ?? process.cwd(),
      sessionTimeout: (codexMcpConfig['sessionTimeout'] as number | undefined) ?? 300_000,
    },
  );

  return codexClient;
}

/**
 * Call Codex via MCP with optional multi-turn context.
 */
export async function codexMCP(
  prompt: string,
  opts: { threadId?: string; cwd?: string } = {},
): Promise<{ ok: boolean; result: string; viaMCP: boolean; error?: string; threadId?: string }> {
  const client = getCodexMCPClient({ cwd: opts.cwd });
  if (!client) {
    return { ok: false, result: '', viaMCP: false, error: 'MCP not enabled' };
  }

  try {
    if (!client.isAlive()) {
      await client.start();
    }

    const toolName = opts.threadId == null ? 'codex' : 'codex-reply';
    const args = opts.threadId == null ? { prompt } : { thread_id: opts.threadId, prompt };

    const result = (await client.callTool(toolName, args, 120_000)) as Record<
      string,
      unknown
    > | null;
    const text = extractMCPText(result);

    const threadId = (result?.['conversationId'] ?? result?.['threadId'] ?? opts.threadId) as
      | string
      | undefined;

    return {
      ok: true,
      result: text,
      threadId: threadId ?? undefined,
      viaMCP: true,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      result: '',
      viaMCP: true,
      error: (err as Error).message,
    };
  }
}

/**
 * Gracefully close the Codex MCP client.
 */
export async function closeCodexMCP(): Promise<void> {
  if (codexClient) {
    await codexClient.close();
    // eslint-disable-next-line require-atomic-updates -- singleton teardown: only one caller closes at a time
    codexClient = null;
  }
}
