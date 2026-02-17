#!/usr/bin/env node
/**
 * Hydra MCP Server
 *
 * Exposes Hydra agent orchestration as MCP tools, resources, and prompts
 * using the official @modelcontextprotocol/sdk.
 *
 * Two modes:
 * - **Standalone** (default): Directly invokes agent CLIs via executeAgent() — no daemon required.
 *   The `hydra_ask` tool always works in this mode.
 * - **Daemon**: When the daemon is reachable, also exposes task queue/handoff/council tools.
 *   Daemon tools gracefully return an error message if the daemon is unavailable.
 *
 * Protocol: 2025-03-26 (latest SDK)
 *
 * Usage:
 *   node hydra-mcp-server.mjs [url=http://127.0.0.1:4173]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseArgs, request, short } from './hydra-utils.mjs';
import { executeAgent, executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
import { forgeAgent, listForgedAgents } from './hydra-agent-forge.mjs';
import { loadHydraConfig } from './hydra-config.mjs';
import { getMetricsSummary } from './hydra-metrics.mjs';
import { listAgents } from './hydra-agents.mjs';
import { getRecentActivity } from './hydra-activity.mjs';
import { buildSelfSnapshot } from './hydra-self.mjs';

let daemonAvailable = false;
let baseUrl = 'http://127.0.0.1:4173';

async function checkDaemon() {
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function requireDaemon() {
  if (!daemonAvailable) {
    daemonAvailable = await checkDaemon();
  }
  if (!daemonAvailable) {
    throw new Error('Hydra daemon is not running. Start it with `npm start` to use daemon tools. The `hydra_ask` tool works without the daemon.');
  }
}

// ── Server Setup ───────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'hydra-orchestrator', version: '3.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// ── Tools ──────────────────────────────────────────────────────────────────

server.tool(
  'hydra_ask',
  'Ask another AI agent (Gemini or Codex) a question and get a response. Works without the Hydra daemon. Use gemini for analysis, review, critique, research. Use codex for implementation, refactoring, code generation.',
  {
    agent: z.enum(['gemini', 'codex']).describe('Which agent to ask: "gemini" (analyst, reviewer) or "codex" (implementer)'),
    prompt: z.string().describe('The prompt to send to the agent'),
    system: z.string().optional().describe('Optional system instruction to prepend to the prompt'),
    model: z.string().optional().describe('Optional model override (defaults to config values)'),
  },
  async ({ agent, prompt, system, model }) => {
    const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    const execOpts = {
      modelOverride: model || undefined,
      timeoutMs: 5 * 60 * 1000,
      useStdin: true,
      maxOutputBytes: 256 * 1024,
    };
    const execFn = model ? executeAgent : executeAgentWithRecovery;
    const result = await execFn(agent, fullPrompt, execOpts);

    if (!result.ok && !result.output.trim()) {
      return { content: [{ type: 'text', text: `Agent ${agent} failed: ${result.error || 'unknown error'}` }], isError: true };
    }

    let text = result.output;
    if (agent === 'claude') {
      try {
        const parsed = JSON.parse(text);
        text = parsed.result || parsed.content || text;
      } catch { /* use raw output */ }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ text: text.trim(), agent, model: model || 'default', durationMs: result.durationMs }) }] };
  },
);

server.tool(
  'hydra_tasks_list',
  'List open tasks with optional filters (requires daemon)',
  {
    status: z.string().optional().describe('Filter by status (todo, in_progress, blocked, done)'),
    owner: z.string().optional().describe('Filter by owner agent'),
  },
  async ({ status, owner }) => {
    await requireDaemon();
    const result = await request('GET', baseUrl, '/summary');
    let tasks = result.summary?.openTasks || [];
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (owner) tasks = tasks.filter((t) => t.owner === owner);
    return { content: [{ type: 'text', text: JSON.stringify({ tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, type: t.type })) }) }] };
  },
);

server.tool(
  'hydra_tasks_claim',
  'Atomically claim a task for an agent (requires daemon)',
  {
    agent: z.string().describe('Agent claiming the task'),
    taskId: z.string().optional().describe('Task ID to claim'),
    title: z.string().optional().describe('Create new task with this title if no taskId'),
    notes: z.string().optional(),
  },
  async ({ agent, taskId, title, notes }) => {
    await requireDaemon();
    const body = { agent };
    if (taskId) body.taskId = taskId;
    if (title) body.title = title;
    if (notes) body.notes = notes;
    const result = await request('POST', baseUrl, '/task/claim', body);
    return { content: [{ type: 'text', text: JSON.stringify({ task: result.task }) }] };
  },
);

server.tool(
  'hydra_tasks_update',
  'Update a task status or notes (requires daemon)',
  {
    taskId: z.string().describe('Task ID to update'),
    status: z.string().optional(),
    notes: z.string().optional(),
    claimToken: z.string().optional().describe('Claim token for atomic updates'),
  },
  async ({ taskId, status, notes, claimToken }) => {
    await requireDaemon();
    const body = { taskId };
    if (status) body.status = status;
    if (notes) body.notes = notes;
    if (claimToken) body.claimToken = claimToken;
    const result = await request('POST', baseUrl, '/task/update', body);
    return { content: [{ type: 'text', text: JSON.stringify({ task: result.task }) }] };
  },
);

server.tool(
  'hydra_tasks_checkpoint',
  'Save a checkpoint for a task (requires daemon)',
  {
    taskId: z.string(),
    name: z.string().describe('Checkpoint name (e.g. proposal_complete)'),
    context: z.string().optional().describe('Summary of progress so far'),
    agent: z.string().optional(),
  },
  async ({ taskId, name, context, agent }) => {
    await requireDaemon();
    const result = await request('POST', baseUrl, '/task/checkpoint', { taskId, name, context: context || '', agent: agent || '' });
    return { content: [{ type: 'text', text: JSON.stringify({ checkpoint: result.checkpoint }) }] };
  },
);

server.tool(
  'hydra_handoffs_pending',
  'Get pending (unacknowledged) handoffs for an agent (requires daemon)',
  {
    agent: z.string().describe('Agent to check handoffs for'),
  },
  async ({ agent }) => {
    await requireDaemon();
    const state = await request('GET', baseUrl, '/state');
    const allPending = (state.state?.handoffs || []).filter((h) => h.to === agent && !h.acknowledgedAt);
    return { content: [{ type: 'text', text: JSON.stringify({ handoffs: allPending }) }] };
  },
);

server.tool(
  'hydra_handoffs_ack',
  'Acknowledge a handoff (requires daemon)',
  {
    handoffId: z.string(),
    agent: z.string(),
  },
  async ({ handoffId, agent }) => {
    await requireDaemon();
    const result = await request('POST', baseUrl, '/handoff/ack', { handoffId, agent });
    return { content: [{ type: 'text', text: JSON.stringify({ handoff: result.handoff }) }] };
  },
);

server.tool(
  'hydra_council_request',
  'Request council deliberation on a prompt (requires daemon)',
  {
    prompt: z.string().describe('The prompt/objective for council'),
  },
  async ({ prompt }) => {
    await requireDaemon();
    const result = await request('POST', baseUrl, '/decision', {
      title: `Council requested: ${(prompt || '').slice(0, 80)}`,
      owner: 'human',
      rationale: `Agent requested council deliberation for: ${prompt}`,
      impact: 'pending council review',
    });
    return { content: [{ type: 'text', text: JSON.stringify({ queued: true, decision: result.decision, message: 'Council request recorded. Use the operator console to run council deliberation.' }) }] };
  },
);

server.tool(
  'hydra_status',
  'Get daemon health and summary status (requires daemon)',
  {},
  async () => {
    await requireDaemon();
    const health = await request('GET', baseUrl, '/health');
    return { content: [{ type: 'text', text: JSON.stringify(health) }] };
  },
);

server.tool(
  'hydra_forge',
  'Create a specialized virtual agent using multi-model collaboration pipeline. Runs ANALYZE (Gemini) -> DESIGN (Claude) -> CRITIQUE (Gemini) -> REFINE (Claude). Works without the daemon.',
  {
    description: z.string().describe('What the agent should specialize in (e.g. "API testing specialist")'),
    name: z.string().optional().describe('Optional lowercase-hyphenated name override'),
    baseAgent: z.enum(['claude', 'gemini', 'codex']).optional().describe('Optional base agent override'),
    skipTest: z.boolean().optional().describe('Skip the test phase (default: true for MCP)'),
  },
  async ({ description, name, baseAgent, skipTest }) => {
    const result = await forgeAgent(description, {
      name: name || undefined,
      baseAgent: baseAgent || undefined,
      skipTest: skipTest !== false,
    });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Forge failed: ${result.errors?.join(', ') || 'unknown error'}` }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          agent: { name: result.spec.name, displayName: result.spec.displayName, baseAgent: result.spec.baseAgent, strengths: result.spec.strengths, tags: result.spec.tags },
          phases: result.phases,
          warnings: result.validation?.warnings || [],
        }),
      }],
    };
  },
);

server.tool(
  'hydra_forge_list',
  'List all forged (custom-created) virtual agents with their specializations',
  {},
  async () => {
    const forged = listForgedAgents();
    return { content: [{ type: 'text', text: JSON.stringify({ agents: forged }) }] };
  },
);

// ── Resources ──────────────────────────────────────────────────────────────

server.resource(
  'config',
  'hydra://config',
  { description: 'Current Hydra configuration' },
  async () => ({
    contents: [{
      uri: 'hydra://config',
      mimeType: 'application/json',
      text: JSON.stringify(loadHydraConfig(), null, 2),
    }],
  }),
);

server.resource(
  'metrics',
  'hydra://metrics',
  { description: 'Session metrics and SLO status' },
  async () => ({
    contents: [{
      uri: 'hydra://metrics',
      mimeType: 'application/json',
      text: JSON.stringify(getMetricsSummary(), null, 2),
    }],
  }),
);

server.resource(
  'agents',
  'hydra://agents',
  { description: 'Agent registry with models and affinities' },
  async () => ({
    contents: [{
      uri: 'hydra://agents',
      mimeType: 'application/json',
      text: JSON.stringify(listAgents(), null, 2),
    }],
  }),
);

server.resource(
  'activity',
  'hydra://activity',
  { description: 'Recent activity digest' },
  async () => ({
    contents: [{
      uri: 'hydra://activity',
      mimeType: 'application/json',
      text: JSON.stringify(getRecentActivity(20), null, 2),
    }],
  }),
);

server.resource(
  'status',
  'hydra://status',
  { description: 'Daemon status (if available)' },
  async () => {
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      const data = health.ok ? await health.json() : { available: false };
      return { contents: [{ uri: 'hydra://status', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    } catch {
      return { contents: [{ uri: 'hydra://status', mimeType: 'application/json', text: JSON.stringify({ available: false }) }] };
    }
  },
);

server.resource(
  'self',
  'hydra://self',
  { description: 'Hydra self snapshot (version, git, models, config, metrics)' },
  async () => ({
    contents: [{
      uri: 'hydra://self',
      mimeType: 'application/json',
      text: JSON.stringify(buildSelfSnapshot({ includeAgents: false, includeConfig: true, includeMetrics: true }), null, 2),
    }],
  }),
);

// ── Prompts ────────────────────────────────────────────────────────────────

server.prompt(
  'hydra_council',
  'Council deliberation template with role assignments',
  { objective: z.string().describe('The objective for council deliberation') },
  ({ objective }) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `# Council Deliberation\n\n## Objective\n${objective}\n\n## Process\n1. **Architect** (Claude): Propose a comprehensive approach with trade-offs\n2. **Analyst** (Gemini): Critique the proposal — identify risks, gaps, edge cases\n3. **Architect** (Claude): Refine based on critique, produce final specification\n4. **Implementer** (Codex): Execute the specification with precision\n\n## Guidelines\n- Consider security implications\n- Evaluate performance trade-offs\n- Check for backward compatibility\n- Ensure testability` } },
    ],
  }),
);

server.prompt(
  'hydra_review',
  'Code review prompt optimized for multi-agent review',
  {
    code: z.string().describe('The code or diff to review'),
    focus: z.string().optional().describe('Specific areas to focus on (security, performance, etc.)'),
  },
  ({ code, focus }) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `# Multi-Agent Code Review\n\n${focus ? `## Focus Areas\n${focus}\n\n` : ''}## Code\n\`\`\`\n${code}\n\`\`\`\n\n## Review Checklist\n- [ ] Security: injection, XSS, OWASP top 10\n- [ ] Error handling: edge cases, graceful degradation\n- [ ] Performance: hot paths, memory allocation\n- [ ] Correctness: logic bugs, off-by-one, race conditions\n- [ ] Maintainability: naming, structure, complexity` } },
    ],
  }),
);

server.prompt(
  'hydra_analyze',
  'Architecture analysis prompt',
  { topic: z.string().describe('Architecture topic or question to analyze') },
  ({ topic }) => ({
    messages: [
      { role: 'user', content: { type: 'text', text: `# Architecture Analysis\n\n## Topic\n${topic}\n\n## Analysis Framework\n1. **Current State**: What exists today?\n2. **Problem**: What's the gap or issue?\n3. **Options**: What are the possible approaches? (minimum 3)\n4. **Trade-offs**: Compare each option on: complexity, performance, maintainability, risk\n5. **Recommendation**: Which option and why?\n6. **Migration Plan**: How to get there incrementally?` } },
    ],
  }),
);

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  baseUrl = options.url || process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';

  // Check daemon availability on startup (non-blocking for standalone tools)
  daemonAvailable = await checkDaemon();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Hydra MCP server failed: ${err.message}\n`);
  process.exit(1);
});
