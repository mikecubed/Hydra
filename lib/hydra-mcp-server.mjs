#!/usr/bin/env node
/**
 * Hydra MCP Server
 *
 * Exposes Hydra agent orchestration as MCP tools via JSON-RPC over stdio.
 *
 * Two modes:
 * - **Standalone** (default): Directly invokes agent CLIs via executeAgent() — no daemon required.
 *   The `hydra_ask` tool always works in this mode.
 * - **Daemon**: When the daemon is reachable, also exposes task queue/handoff/council tools.
 *   Daemon tools gracefully return an error message if the daemon is unavailable.
 *
 * Usage:
 *   node hydra-mcp-server.mjs [url=http://127.0.0.1:4173]
 */

import { parseArgs, request } from './hydra-utils.mjs';
import { executeAgent, executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
import { forgeAgent, listForgedAgents } from './hydra-agent-forge.mjs';

let daemonAvailable = false;

async function checkDaemon(baseUrl) {
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function requireDaemon(baseUrl) {
  if (!daemonAvailable) {
    // Re-check in case it came up
    daemonAvailable = await checkDaemon(baseUrl);
  }
  if (!daemonAvailable) {
    throw new Error('Hydra daemon is not running. Start it with `npm start` to use daemon tools. The `hydra_ask` tool works without the daemon.');
  }
}

const TOOL_SCHEMAS = [
  {
    name: 'hydra_ask',
    description:
      'Ask another AI agent (Gemini or Codex) a question and get a response. Works without the Hydra daemon. ' +
      'Use gemini for analysis, review, critique, research. Use codex for implementation, refactoring, code generation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['gemini', 'codex'],
          description: 'Which agent to ask: "gemini" (analyst, reviewer) or "codex" (implementer)',
        },
        prompt: { type: 'string', description: 'The prompt to send to the agent' },
        system: { type: 'string', description: 'Optional system instruction to prepend to the prompt' },
        model: { type: 'string', description: 'Optional model override (defaults to config values)' },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'hydra_tasks_list',
    description: 'List open tasks with optional filters (requires daemon)',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status (todo, in_progress, blocked, done)' },
        owner: { type: 'string', description: 'Filter by owner agent' },
      },
    },
  },
  {
    name: 'hydra_tasks_claim',
    description: 'Atomically claim a task for an agent (requires daemon)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to claim' },
        agent: { type: 'string', description: 'Agent claiming the task' },
        title: { type: 'string', description: 'Create new task with this title if no taskId' },
        notes: { type: 'string' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'hydra_tasks_update',
    description: 'Update a task status or notes (requires daemon)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to update' },
        status: { type: 'string' },
        notes: { type: 'string' },
        claimToken: { type: 'string', description: 'Claim token for atomic updates' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'hydra_tasks_checkpoint',
    description: 'Save a checkpoint for a task (requires daemon)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        name: { type: 'string', description: 'Checkpoint name (e.g. proposal_complete)' },
        context: { type: 'string', description: 'Summary of progress so far' },
        agent: { type: 'string' },
      },
      required: ['taskId', 'name'],
    },
  },
  {
    name: 'hydra_handoffs_pending',
    description: 'Get pending (unacknowledged) handoffs for an agent (requires daemon)',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent to check handoffs for' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'hydra_handoffs_ack',
    description: 'Acknowledge a handoff (requires daemon)',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
        agent: { type: 'string' },
      },
      required: ['handoffId', 'agent'],
    },
  },
  {
    name: 'hydra_council_request',
    description: 'Request council deliberation on a prompt (requires daemon)',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt/objective for council' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'hydra_status',
    description: 'Get daemon health and summary status (requires daemon)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hydra_forge',
    description:
      'Create a specialized virtual agent using multi-model collaboration pipeline. ' +
      'Runs ANALYZE (Gemini) → DESIGN (Claude) → CRITIQUE (Gemini) → REFINE (Claude). ' +
      'Works without the daemon.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the agent should specialize in (e.g. "API testing specialist")' },
        name: { type: 'string', description: 'Optional lowercase-hyphenated name override' },
        baseAgent: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'Optional base agent override' },
        skipTest: { type: 'boolean', description: 'Skip the test phase (default: true for MCP)' },
      },
      required: ['description'],
    },
  },
  {
    name: 'hydra_forge_list',
    description: 'List all forged (custom-created) virtual agents with their specializations',
    inputSchema: { type: 'object', properties: {} },
  },
];

class HydraMCPServer {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.buffer = '';
  }

  start() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (data) => this._onData(data));
    process.stdin.on('end', () => process.exit(0));
  }

  _onData(data) {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch { /* skip */ }
    }
  }

  async _handleMessage(msg) {
    // Notification (no response needed)
    if (msg.id === undefined) return;

    try {
      const result = await this._dispatch(msg.method, msg.params || {});
      this._send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      this._send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: err.message },
      });
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hydra-orchestrator', version: '2.0.0' },
        };

      case 'tools/list':
        return { tools: TOOL_SCHEMAS };

      case 'tools/call':
        return this._callTool(params.name, params.arguments || {});

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  async _callTool(name, args) {
    const text = await this._executeTool(name, args);
    return { content: [{ type: 'text', text }] };
  }

  async _executeTool(name, args) {
    switch (name) {
      case 'hydra_ask': {
        const agent = args.agent;
        if (!agent || !['gemini', 'codex'].includes(agent)) {
          throw new Error('agent must be "gemini" or "codex"');
        }
        const prompt = args.prompt;
        if (!prompt || !prompt.trim()) {
          throw new Error('prompt is required');
        }

        // Prepend system instruction if provided
        const fullPrompt = args.system
          ? `${args.system}\n\n---\n\n${prompt}`
          : prompt;

        // Use recovery wrapper when no explicit model is specified (headless auto-fallback)
        const execOpts = {
          modelOverride: args.model || undefined,
          timeoutMs: 5 * 60 * 1000, // 5 min timeout for MCP calls
          useStdin: true,
          maxOutputBytes: 256 * 1024,
        };
        const execFn = args.model ? executeAgent : executeAgentWithRecovery;
        const result = await execFn(agent, fullPrompt, execOpts);

        if (!result.ok && !result.output.trim()) {
          throw new Error(
            `Agent ${agent} failed: ${result.error || 'unknown error'}${result.stderr ? `\nStderr: ${result.stderr.slice(0, 500)}` : ''}`
          );
        }

        // Try to extract text from claude's JSON output format
        let text = result.output;
        if (agent === 'claude') {
          try {
            const parsed = JSON.parse(text);
            text = parsed.result || parsed.content || text;
          } catch { /* use raw output */ }
        }

        return JSON.stringify({
          text: text.trim(),
          agent,
          model: args.model || 'default',
          durationMs: result.durationMs,
          ...(result.stderr ? { warnings: result.stderr.slice(0, 200) } : {}),
        });
      }

      case 'hydra_tasks_list': {
        await requireDaemon(this.baseUrl);
        const result = await request('GET', this.baseUrl, '/summary');
        let tasks = result.summary?.openTasks || [];
        if (args.status) tasks = tasks.filter((t) => t.status === args.status);
        if (args.owner) tasks = tasks.filter((t) => t.owner === args.owner);
        return JSON.stringify({ tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, type: t.type })) });
      }

      case 'hydra_tasks_claim': {
        await requireDaemon(this.baseUrl);
        const body = { agent: args.agent };
        if (args.taskId) body.taskId = args.taskId;
        if (args.title) body.title = args.title;
        if (args.notes) body.notes = args.notes;
        const result = await request('POST', this.baseUrl, '/task/claim', body);
        return JSON.stringify({ task: result.task });
      }

      case 'hydra_tasks_update': {
        await requireDaemon(this.baseUrl);
        const body = { taskId: args.taskId };
        if (args.status) body.status = args.status;
        if (args.notes) body.notes = args.notes;
        if (args.claimToken) body.claimToken = args.claimToken;
        const result = await request('POST', this.baseUrl, '/task/update', body);
        return JSON.stringify({ task: result.task });
      }

      case 'hydra_tasks_checkpoint': {
        await requireDaemon(this.baseUrl);
        const result = await request('POST', this.baseUrl, '/task/checkpoint', {
          taskId: args.taskId,
          name: args.name,
          context: args.context || '',
          agent: args.agent || '',
        });
        return JSON.stringify({ checkpoint: result.checkpoint });
      }

      case 'hydra_handoffs_pending': {
        await requireDaemon(this.baseUrl);
        const result = await request('GET', this.baseUrl, '/summary');
        const handoffs = (result.summary?.latestHandoff ? [result.summary.latestHandoff] : [])
          .filter((h) => h.to === args.agent && !h.acknowledgedAt);
        // Also check full state for all pending handoffs
        const state = await request('GET', this.baseUrl, '/state');
        const allPending = (state.state?.handoffs || [])
          .filter((h) => h.to === args.agent && !h.acknowledgedAt);
        return JSON.stringify({ handoffs: allPending });
      }

      case 'hydra_handoffs_ack': {
        await requireDaemon(this.baseUrl);
        const result = await request('POST', this.baseUrl, '/handoff/ack', {
          handoffId: args.handoffId,
          agent: args.agent,
        });
        return JSON.stringify({ handoff: result.handoff });
      }

      case 'hydra_council_request': {
        await requireDaemon(this.baseUrl);
        // Create a decision record noting the council request
        const result = await request('POST', this.baseUrl, '/decision', {
          title: `Council requested: ${(args.prompt || '').slice(0, 80)}`,
          owner: 'human',
          rationale: `Agent requested council deliberation for: ${args.prompt}`,
          impact: 'pending council review',
        });
        return JSON.stringify({
          queued: true,
          decision: result.decision,
          message: 'Council request recorded. Use the operator console to run council deliberation.',
        });
      }

      case 'hydra_status': {
        await requireDaemon(this.baseUrl);
        const health = await request('GET', this.baseUrl, '/health');
        return JSON.stringify(health);
      }

      case 'hydra_forge': {
        if (!args.description || !args.description.trim()) {
          throw new Error('description is required');
        }
        const result = await forgeAgent(args.description, {
          name: args.name || undefined,
          baseAgent: args.baseAgent || undefined,
          skipTest: args.skipTest !== false, // default true for MCP
        });
        if (!result.ok) {
          throw new Error(`Forge failed: ${result.errors?.join(', ') || 'unknown error'}`);
        }
        return JSON.stringify({
          agent: {
            name: result.spec.name,
            displayName: result.spec.displayName,
            baseAgent: result.spec.baseAgent,
            strengths: result.spec.strengths,
            tags: result.spec.tags,
            topAffinities: Object.entries(result.spec.taskAffinity)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 5)
              .map(([t, s]) => `${t}:${(s * 100).toFixed(0)}%`),
          },
          phases: result.phases,
          warnings: result.validation?.warnings || [],
        });
      }

      case 'hydra_forge_list': {
        const forged = listForgedAgents();
        return JSON.stringify({ agents: forged });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  _send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}

async function main() {
  const { options } = parseArgs(process.argv);
  const baseUrl = options.url || process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';

  // Check daemon availability on startup (non-blocking for standalone tools)
  daemonAvailable = await checkDaemon(baseUrl);

  const server = new HydraMCPServer(baseUrl);
  server.start();
}

main().catch((err) => {
  process.stderr.write(`Hydra MCP server failed: ${err.message}\n`);
  process.exit(1);
});
