#!/usr/bin/env node
/**
 * Hydra MCP Server
 *
 * Exposes Hydra daemon functionality as MCP tools via JSON-RPC over stdio.
 * Agents can self-coordinate by querying tasks, reporting progress,
 * and requesting council deliberation.
 *
 * Usage:
 *   node hydra-mcp-server.mjs [url=http://127.0.0.1:4173]
 */

import { parseArgs, request } from './hydra-utils.mjs';

const TOOL_SCHEMAS = [
  {
    name: 'hydra_tasks_list',
    description: 'List open tasks with optional filters',
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
    description: 'Atomically claim a task for an agent',
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
    description: 'Update a task status or notes',
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
    description: 'Save a checkpoint for a task',
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
    description: 'Get pending (unacknowledged) handoffs for an agent',
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
    description: 'Acknowledge a handoff',
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
    description: 'Request council deliberation on a prompt',
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
    description: 'Get daemon health and summary status',
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
          serverInfo: { name: 'hydra-orchestrator', version: '1.0.0' },
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
      case 'hydra_tasks_list': {
        const result = await request('GET', this.baseUrl, '/summary');
        let tasks = result.summary?.openTasks || [];
        if (args.status) tasks = tasks.filter((t) => t.status === args.status);
        if (args.owner) tasks = tasks.filter((t) => t.owner === args.owner);
        return JSON.stringify({ tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, type: t.type })) });
      }

      case 'hydra_tasks_claim': {
        const body = { agent: args.agent };
        if (args.taskId) body.taskId = args.taskId;
        if (args.title) body.title = args.title;
        if (args.notes) body.notes = args.notes;
        const result = await request('POST', this.baseUrl, '/task/claim', body);
        return JSON.stringify({ task: result.task });
      }

      case 'hydra_tasks_update': {
        const body = { taskId: args.taskId };
        if (args.status) body.status = args.status;
        if (args.notes) body.notes = args.notes;
        if (args.claimToken) body.claimToken = args.claimToken;
        const result = await request('POST', this.baseUrl, '/task/update', body);
        return JSON.stringify({ task: result.task });
      }

      case 'hydra_tasks_checkpoint': {
        const result = await request('POST', this.baseUrl, '/task/checkpoint', {
          taskId: args.taskId,
          name: args.name,
          context: args.context || '',
          agent: args.agent || '',
        });
        return JSON.stringify({ checkpoint: result.checkpoint });
      }

      case 'hydra_handoffs_pending': {
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
        const result = await request('POST', this.baseUrl, '/handoff/ack', {
          handoffId: args.handoffId,
          agent: args.agent,
        });
        return JSON.stringify({ handoff: result.handoff });
      }

      case 'hydra_council_request': {
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
        const health = await request('GET', this.baseUrl, '/health');
        return JSON.stringify(health);
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

  const server = new HydraMCPServer(baseUrl);
  server.start();
}

main().catch((err) => {
  process.stderr.write(`Hydra MCP server failed: ${err.message}\n`);
  process.exit(1);
});
