import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url);
const serverModuleUrl = new URL('../lib/hydra-mcp-server.ts', import.meta.url).href;

const HARNESS_SOURCE = String.raw`
import { mock } from 'node:test';

const options = JSON.parse(process.env.HARNESS_OPTIONS ?? '{}');
const serverModuleUrl = process.env.SERVER_MODULE_URL;

if (!serverModuleUrl) {
  throw new Error('SERVER_MODULE_URL is required');
}

const serverInstances = [];
const state = {
  requestCalls: [],
  execCalls: [],
  forgeCalls: [],
  hubCalls: [],
};

let currentCall = null;
let nextSessionId = 1;
const sessions = [...(options.initialSessions ?? [])];

class FakeMcpServer {
  constructor(info, config) {
    this.info = info;
    this.config = config;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.connected = false;
    this.transport = null;
    serverInstances.push(this);
  }

  registerTool(name, definition, handler) {
    this.tools.push({ name, definition, handler });
  }

  registerResource(name, uri, definition, handler) {
    this.resources.push({ name, uri, definition, handler });
  }

  registerPrompt(name, definition, handler) {
    this.prompts.push({ name, definition, handler });
  }

  async connect(transport) {
    this.connected = true;
    this.transport = transport;
  }
}

class FakeTransport {}

function currentOverrides() {
  return currentCall?.mock ?? {};
}

function getResponseMap() {
  return currentOverrides().requestResponses ?? options.requestResponses ?? {};
}

function getExecResult(kind) {
  const overrides = currentOverrides();
  if (kind === 'executeAgent') {
    return (
      overrides.executeAgentResult ??
      options.executeAgentResult ?? {
        ok: true,
        output: 'default executeAgent output',
        durationMs: 17,
      }
    );
  }

  return (
    overrides.executeAgentWithRecoveryResult ??
    options.executeAgentWithRecoveryResult ?? {
      ok: true,
      output: 'default executeAgentWithRecovery output',
      durationMs: 19,
    }
  );
}

mock.module('@modelcontextprotocol/sdk/server/mcp.js', {
  namedExports: { McpServer: FakeMcpServer },
});
mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
  namedExports: { StdioServerTransport: FakeTransport },
});
mock.module('./lib/hydra-utils.ts', {
  namedExports: {
    parseArgs: () => ({ options: options.parseArgsOptions ?? {} }),
    request: async (method, baseUrl, path, body) => {
      state.requestCalls.push({ method, baseUrl, path, body: body ?? null });
      const responseMap = getResponseMap();
      if (!(path in responseMap)) {
        throw new Error('No mocked response for ' + path);
      }
      return responseMap[path];
    },
  },
});
mock.module('./lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgent: async (agent, prompt, execOpts) => {
      state.execCalls.push({ kind: 'executeAgent', agent, prompt, execOpts });
      return getExecResult('executeAgent');
    },
    executeAgentWithRecovery: async (agent, prompt, execOpts) => {
      state.execCalls.push({ kind: 'executeAgentWithRecovery', agent, prompt, execOpts });
      return getExecResult('executeAgentWithRecovery');
    },
  },
});
mock.module('./lib/hydra-agent-forge.ts', {
  namedExports: {
    forgeAgent: async (description, forgeOptions) => {
      state.forgeCalls.push({ description, forgeOptions });
      return (
        currentOverrides().forgeResult ??
        options.forgeResult ?? {
          ok: true,
          spec: {
            name: 'qa-sentinel',
            displayName: 'QA Sentinel',
            baseAgent: 'claude',
            strengths: ['testing'],
            tags: ['qa'],
          },
          phases: ['analyze', 'design'],
          validation: { warnings: [] },
        }
      );
    },
    listForgedAgents: () => currentOverrides().forgedAgents ?? options.forgedAgents ?? [],
  },
});
mock.module('./lib/hydra-config.ts', {
  namedExports: { loadHydraConfig: () => options.config ?? { mode: 'auto' } },
});
mock.module('./lib/hydra-metrics.ts', {
  namedExports: { getMetricsSummary: () => options.metrics ?? { sessions: 3 } },
});
mock.module('./lib/hydra-agents.ts', {
  namedExports: { listAgents: () => options.agents ?? [{ name: 'codex' }] },
});
mock.module('./lib/hydra-activity.ts', {
  namedExports: { getRecentActivity: (limit) => (options.activity ?? []).slice(0, limit) },
});
mock.module('./lib/hydra-self.ts', {
  namedExports: {
    buildSelfSnapshot: () =>
      options.selfSnapshot ?? {
        version: 'test',
        metrics: true,
      },
  },
});
mock.module('./lib/hydra-hub.ts', {
  namedExports: {
    hubPath: () => options.hubPath ?? '/tmp/hydra-hub.json',
    registerSession: (session) => {
      const id = session.id ?? 'sess-' + String(nextSessionId++);
      sessions.push({ id, status: 'working', ...session });
      state.hubCalls.push({ kind: 'register', session: { id, ...session } });
      return id;
    },
    updateSession: (id, updates) => {
      const session = sessions.find((entry) => entry.id === id);
      if (!session) {
        throw new Error('Unknown session ' + id);
      }
      Object.assign(session, updates);
      state.hubCalls.push({ kind: 'update', id, updates });
    },
    deregisterSession: (id) => {
      const index = sessions.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        sessions.splice(index, 1);
      }
      state.hubCalls.push({ kind: 'deregister', id });
    },
    listSessions: ({ cwd } = {}) => {
      state.hubCalls.push({ kind: 'list', cwd: cwd ?? null });
      return cwd == null ? [...sessions] : sessions.filter((entry) => entry.cwd === cwd);
    },
    checkConflicts: (files, { cwd, excludeId } = {}) => {
      state.hubCalls.push({ kind: 'conflicts', files, cwd, excludeId: excludeId ?? null });
      return sessions
        .filter((entry) => entry.cwd === cwd && entry.id !== excludeId)
        .flatMap((entry) =>
          (entry.files ?? [])
            .filter((file) => files.includes(file))
            .map((file) => ({ file, claimedBy: entry.id })),
        );
    },
  },
});

globalThis.fetch = async (url) => {
  const text = String(url);
  if (!text.endsWith('/health')) {
    throw new Error('Unexpected fetch URL: ' + text);
  }

  const healthOk = currentOverrides().healthOk ?? options.healthOk ?? true;
  const healthPayload = currentOverrides().healthPayload ?? options.healthPayload ?? { available: healthOk };
  return {
    ok: healthOk,
    async json() {
      return healthPayload;
    },
  };
};

await import(serverModuleUrl);

const server = serverInstances.at(-1);
if (!server) {
  throw new Error('Server was not instantiated');
}

function summarizeSchema(schema) {
  let current = schema;
  let required = !schema.safeParse(undefined).success;
  let defaultValue;

  while (typeof current?.unwrap === 'function' && (current.type === 'optional' || current.type === 'default')) {
    if (current.type === 'default') {
      const parsed = current.safeParse(undefined);
      if (parsed.success) {
        defaultValue = parsed.data;
      }
    }
    current = current.unwrap();
  }

  const summary = {
    required,
    type: current?.type ?? schema?.type ?? 'unknown',
  };

  if (defaultValue !== undefined) {
    summary.defaultValue = defaultValue;
  }

  if (Array.isArray(current?.options)) {
    summary.enumValues = [...current.options];
  }

  if (current?.type === 'array') {
    summary.itemType = current.element?.type ?? 'unknown';
  }

  return summary;
}

function buildSnapshot() {
  return {
    serverInfo: server.info,
    capabilities: server.config?.capabilities,
    connected: server.connected,
    transportName: server.transport?.constructor?.name ?? null,
    toolNames: server.tools.map((tool) => tool.name),
    resourceNames: server.resources.map((resource) => resource.name),
    promptNames: server.prompts.map((prompt) => prompt.name),
    tools: Object.fromEntries(
      server.tools.map((tool) => [
        tool.name,
        {
          title: tool.definition.title,
          annotations: tool.definition.annotations,
          schema: Object.fromEntries(
            Object.entries(tool.definition.inputSchema ?? {}).map(([field, fieldSchema]) => [
              field,
              summarizeSchema(fieldSchema),
            ]),
          ),
        },
      ]),
    ),
  };
}

async function invokeMany(calls) {
  const results = [];
  for (const call of calls) {
    currentCall = call;
    const tool = server.tools.find((entry) => entry.name === call.name);
    if (!tool) {
      throw new Error('Unknown tool ' + call.name);
    }

    try {
      const result = await tool.handler(call.args ?? {});
      results.push({ name: call.name, ok: true, result: structuredClone(result) });
    } catch (error) {
      results.push({
        name: call.name,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      currentCall = null;
    }
  }

  return {
    results,
    requestCalls: state.requestCalls,
    execCalls: state.execCalls,
    forgeCalls: state.forgeCalls,
    hubCalls: state.hubCalls,
    sessions,
  };
}

const command = options.command ?? 'snapshot';
const output = command === 'invokeMany' ? await invokeMany(options.calls ?? []) : buildSnapshot();
process.stdout.write(JSON.stringify(output));
`;

type ToolResult = {
  name: string;
  ok: boolean;
  result?: {
    content: Array<{ type: string; text: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { name: string; message: string };
};

type HarnessOutput = {
  toolNames?: string[];
  resourceNames?: string[];
  promptNames?: string[];
  tools?: Record<string, unknown>;
  results?: ToolResult[];
  requestCalls?: Array<Record<string, unknown>>;
  execCalls?: Array<Record<string, unknown>>;
  forgeCalls?: Array<Record<string, unknown>>;
  hubCalls?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  connected?: boolean;
  transportName?: string | null;
  serverInfo?: Record<string, unknown>;
};

function runHarness(options: Record<string, unknown>): HarnessOutput {
  const proc = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-'],
    {
      cwd: repoRoot,
      input: HARNESS_SOURCE,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HARNESS_OPTIONS: JSON.stringify(options),
        SERVER_MODULE_URL: serverModuleUrl,
      },
    },
  );

  assert.equal(proc.status, 0, proc.stderr || proc.stdout || 'Harness process failed');
  assert.notEqual(proc.stdout, '', 'Harness process did not produce JSON output');
  return JSON.parse(proc.stdout) as HarnessOutput;
}

function getResult(output: HarnessOutput, name: string): ToolResult {
  const result = output.results?.find((entry) => entry.name === name);
  assert.ok(result, `Expected result for ${name}`);
  return result;
}

function assertStructuredJsonResult(result: ToolResult) {
  assert.equal(result.ok, true, result.error?.message ?? `${result.name} should succeed`);
  assert.ok(result.result);
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(
    JSON.parse(result.result.content[0]?.text ?? 'null'),
    result.result.structuredContent,
  );
}

test('hydra-mcp-server registers the expected tool, resource, and prompt contracts', () => {
  const snapshot = runHarness({
    command: 'snapshot',
    parseArgsOptions: { url: 'http://daemon.test:4173' },
  });

  assert.deepEqual(snapshot.serverInfo, { name: 'hydra-orchestrator', version: '3.0.0' });
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.transportName, 'FakeTransport');
  assert.deepEqual(snapshot.toolNames, [
    'hydra_ask',
    'hydra_tasks_list',
    'hydra_tasks_claim',
    'hydra_tasks_update',
    'hydra_tasks_checkpoint',
    'hydra_handoffs_pending',
    'hydra_handoffs_ack',
    'hydra_council_request',
    'hydra_status',
    'hydra_forge',
    'hydra_forge_list',
    'hydra_hub_list',
    'hydra_hub_register',
    'hydra_hub_update',
    'hydra_hub_deregister',
    'hydra_hub_conflicts',
  ]);
  assert.deepEqual(snapshot.resourceNames, [
    'config',
    'metrics',
    'agents',
    'activity',
    'status',
    'self',
  ]);
  assert.deepEqual(snapshot.promptNames, ['hydra_council', 'hydra_review', 'hydra_analyze']);
  assert.deepEqual(snapshot.tools, {
    hydra_ask: {
      title: 'Ask Agent',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      schema: {
        agent: { required: true, type: 'enum', enumValues: ['gemini', 'codex'] },
        prompt: { required: true, type: 'string' },
        system: { required: false, type: 'string' },
        model: { required: false, type: 'string' },
      },
    },
    hydra_tasks_list: {
      title: 'List Tasks',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        status: { required: false, type: 'string' },
        owner: { required: false, type: 'string' },
        limit: { required: false, type: 'number', defaultValue: 50 },
        offset: { required: false, type: 'number', defaultValue: 0 },
      },
    },
    hydra_tasks_claim: {
      title: 'Claim Task',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      schema: {
        agent: { required: true, type: 'string' },
        taskId: { required: false, type: 'string' },
        title: { required: false, type: 'string' },
        notes: { required: false, type: 'string' },
      },
    },
    hydra_tasks_update: {
      title: 'Update Task',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        taskId: { required: true, type: 'string' },
        status: { required: false, type: 'string' },
        notes: { required: false, type: 'string' },
        claimToken: { required: false, type: 'string' },
      },
    },
    hydra_tasks_checkpoint: {
      title: 'Save Task Checkpoint',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      schema: {
        taskId: { required: true, type: 'string' },
        name: { required: true, type: 'string' },
        context: { required: false, type: 'string' },
        agent: { required: false, type: 'string' },
      },
    },
    hydra_handoffs_pending: {
      title: 'Get Pending Handoffs',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        agent: { required: true, type: 'string' },
      },
    },
    hydra_handoffs_ack: {
      title: 'Acknowledge Handoff',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {
        handoffId: { required: true, type: 'string' },
        agent: { required: true, type: 'string' },
      },
    },
    hydra_council_request: {
      title: 'Request Council Deliberation',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      schema: {
        prompt: { required: true, type: 'string' },
      },
    },
    hydra_status: {
      title: 'Get Daemon Status',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      schema: {},
    },
    hydra_forge: {
      title: 'Forge Virtual Agent',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      schema: {
        description: { required: true, type: 'string' },
        name: { required: false, type: 'string' },
        baseAgent: { required: false, type: 'enum', enumValues: ['claude', 'gemini', 'codex'] },
        skipTest: { required: false, type: 'boolean' },
      },
    },
    hydra_forge_list: {
      title: 'List Forged Agents',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      schema: {},
    },
    hydra_hub_list: {
      title: 'Hub List',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      schema: {
        cwd: { required: false, type: 'string' },
      },
    },
    hydra_hub_register: {
      title: 'Hub Register',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      schema: {
        agent: { required: true, type: 'string' },
        cwd: { required: true, type: 'string' },
        project: { required: true, type: 'string' },
        focus: { required: true, type: 'string' },
        files: { required: false, type: 'array', itemType: 'string' },
        taskId: { required: false, type: 'string' },
      },
    },
    hydra_hub_update: {
      title: 'Hub Update',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      schema: {
        id: { required: true, type: 'string' },
        files: { required: false, type: 'array', itemType: 'string' },
        status: { required: false, type: 'string' },
        focus: { required: false, type: 'string' },
      },
    },
    hydra_hub_deregister: {
      title: 'Hub Deregister',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      schema: {
        id: { required: true, type: 'string' },
      },
    },
    hydra_hub_conflicts: {
      title: 'Hub Check Conflicts',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      schema: {
        files: { required: true, type: 'array', itemType: 'string' },
        cwd: { required: true, type: 'string' },
        excludeId: { required: false, type: 'string' },
      },
    },
  });
});

test('standalone MCP tool handlers return stable structured responses', () => {
  const output = runHarness({
    command: 'invokeMany',
    healthOk: false,
    forgedAgents: [
      { name: 'qa-sentinel', displayName: 'QA Sentinel' },
      { name: 'review-bot', displayName: 'Review Bot' },
    ],
    calls: [
      {
        name: 'hydra_ask',
        args: {
          agent: 'gemini',
          prompt: 'Review this patch',
          system: 'Return a concise review',
        },
        mock: {
          executeAgentWithRecoveryResult: {
            ok: true,
            output: 'analysis ready',
            durationMs: 321,
          },
        },
      },
      {
        name: 'hydra_ask',
        args: {
          agent: 'codex',
          prompt: 'Generate tests',
          model: 'gpt-5.4',
        },
        mock: {
          executeAgentResult: {
            ok: true,
            output: 'x'.repeat(25_010),
            durationMs: 99,
          },
        },
      },
      {
        name: 'hydra_ask',
        args: {
          agent: 'gemini',
          prompt: 'Will this fail?',
        },
        mock: {
          executeAgentWithRecoveryResult: {
            ok: false,
            output: '',
            error: 'missing CLI',
            durationMs: 12,
          },
        },
      },
      {
        name: 'hydra_forge',
        args: {
          description: 'Regression testing specialist',
          name: 'regression-sentinel',
          baseAgent: 'codex',
          skipTest: false,
        },
        mock: {
          forgeResult: {
            ok: true,
            spec: {
              name: 'regression-sentinel',
              displayName: 'Regression Sentinel',
              baseAgent: 'codex',
              strengths: ['regression'],
              tags: ['tests', 'safety'],
            },
            phases: ['analyze', 'design', 'critique', 'refine'],
            validation: { warnings: ['experimental'] },
          },
        },
      },
      {
        name: 'hydra_forge',
        args: { description: 'Broken forge request' },
        mock: {
          forgeResult: { ok: false, errors: ['gemini unavailable'] },
        },
      },
      { name: 'hydra_forge_list', args: {} },
      {
        name: 'hydra_hub_register',
        args: {
          agent: 'claude-code',
          cwd: '/repo',
          project: 'Hydra',
          focus: 'Add MCP server tests',
          files: ['lib/hydra-mcp-server.ts'],
          taskId: 'rf-sn11',
        },
      },
      { name: 'hydra_hub_list', args: { cwd: '/repo' } },
      {
        name: 'hydra_hub_conflicts',
        args: {
          cwd: '/repo',
          files: ['lib/hydra-mcp-server.ts', 'README.md'],
        },
      },
      {
        name: 'hydra_hub_update',
        args: {
          id: 'sess-1',
          status: 'blocked',
          focus: 'Waiting on review',
          files: ['test/hydra-mcp-server.test.ts'],
        },
      },
      { name: 'hydra_hub_deregister', args: { id: 'sess-1' } },
      { name: 'hydra_hub_list', args: { cwd: '/repo' } },
    ],
  });

  const askResult = getResult(output, 'hydra_ask');
  assertStructuredJsonResult(askResult);
  assert.deepEqual(askResult.result?.structuredContent, {
    text: 'analysis ready',
    agent: 'gemini',
    model: 'default',
    durationMs: 321,
    truncated: false,
  });

  const truncatedAskResult = output.results?.filter((entry) => entry.name === 'hydra_ask')[1];
  assert.ok(truncatedAskResult);
  assertStructuredJsonResult(truncatedAskResult);
  const truncatedContent = truncatedAskResult.result?.structuredContent as Record<string, unknown>;
  assert.equal(truncatedContent['agent'], 'codex');
  assert.equal(truncatedContent['model'], 'gpt-5.4');
  assert.equal(truncatedContent['truncated'], true);
  assert.match(String(truncatedContent['text']), /Output truncated at 25000 chars/);

  const failedAskResult = output.results?.filter((entry) => entry.name === 'hydra_ask')[2];
  assert.ok(failedAskResult);
  assert.equal(failedAskResult.ok, true);
  assert.deepEqual(failedAskResult.result, {
    content: [
      {
        type: 'text',
        text: 'Agent gemini failed: missing CLI. Try a different agent or check agent availability with hydra_status.',
      },
    ],
    isError: true,
  });

  const forgeResult = output.results?.find(
    (entry) => entry.name === 'hydra_forge' && entry.result?.isError !== true,
  );
  assert.ok(forgeResult);
  assertStructuredJsonResult(forgeResult);
  assert.deepEqual(forgeResult.result?.structuredContent, {
    agent: {
      name: 'regression-sentinel',
      displayName: 'Regression Sentinel',
      baseAgent: 'codex',
      strengths: ['regression'],
      tags: ['tests', 'safety'],
    },
    phases: ['analyze', 'design', 'critique', 'refine'],
    warnings: ['experimental'],
  });

  const forgeErrorResult = output.results?.find(
    (entry) => entry.name === 'hydra_forge' && entry.result?.isError === true,
  );
  assert.ok(forgeErrorResult);
  assert.deepEqual(forgeErrorResult.result, {
    content: [
      {
        type: 'text',
        text: 'Forge failed: gemini unavailable. Check that Gemini and Claude agents are available and configured.',
      },
    ],
    isError: true,
  });

  const forgeListResult = getResult(output, 'hydra_forge_list');
  assertStructuredJsonResult(forgeListResult);
  assert.deepEqual(forgeListResult.result?.structuredContent, {
    agents: [
      { name: 'qa-sentinel', displayName: 'QA Sentinel' },
      { name: 'review-bot', displayName: 'Review Bot' },
    ],
    count: 2,
  });

  const registerResult = getResult(output, 'hydra_hub_register');
  assertStructuredJsonResult(registerResult);
  assert.deepEqual(registerResult.result?.structuredContent, {
    id: 'sess-1',
    hubPath: '/tmp/hydra-hub.json',
  });

  const listedSessions = output.results?.filter((entry) => entry.name === 'hydra_hub_list') ?? [];
  assert.equal(listedSessions.length, 2);
  assertStructuredJsonResult(listedSessions[0]);
  assert.deepEqual(listedSessions[0].result?.structuredContent, {
    sessions: [
      {
        id: 'sess-1',
        status: 'working',
        agent: 'claude-code',
        cwd: '/repo',
        project: 'Hydra',
        focus: 'Add MCP server tests',
        files: ['lib/hydra-mcp-server.ts'],
        taskId: 'rf-sn11',
      },
    ],
    count: 1,
    hubPath: '/tmp/hydra-hub.json',
  });
  assertStructuredJsonResult(listedSessions[1]);
  assert.deepEqual(listedSessions[1].result?.structuredContent, {
    sessions: [],
    count: 0,
    hubPath: '/tmp/hydra-hub.json',
  });

  const conflictsResult = getResult(output, 'hydra_hub_conflicts');
  assertStructuredJsonResult(conflictsResult);
  assert.deepEqual(conflictsResult.result?.structuredContent, {
    conflicts: [{ file: 'lib/hydra-mcp-server.ts', claimedBy: 'sess-1' }],
  });

  const updateResult = getResult(output, 'hydra_hub_update');
  assertStructuredJsonResult(updateResult);
  assert.deepEqual(updateResult.result?.structuredContent, { ok: true });

  const deregisterResult = getResult(output, 'hydra_hub_deregister');
  assertStructuredJsonResult(deregisterResult);
  assert.deepEqual(deregisterResult.result?.structuredContent, { ok: true });

  assert.deepEqual(output.execCalls, [
    {
      kind: 'executeAgentWithRecovery',
      agent: 'gemini',
      prompt: 'Return a concise review\n\n---\n\nReview this patch',
      execOpts: {
        timeoutMs: 300000,
        useStdin: true,
        maxOutputBytes: 262144,
      },
    },
    {
      kind: 'executeAgent',
      agent: 'codex',
      prompt: 'Generate tests',
      execOpts: {
        modelOverride: 'gpt-5.4',
        timeoutMs: 300000,
        useStdin: true,
        maxOutputBytes: 262144,
      },
    },
    {
      kind: 'executeAgentWithRecovery',
      agent: 'gemini',
      prompt: 'Will this fail?',
      execOpts: {
        timeoutMs: 300000,
        useStdin: true,
        maxOutputBytes: 262144,
      },
    },
  ]);
  assert.deepEqual(output.forgeCalls, [
    {
      description: 'Regression testing specialist',
      forgeOptions: {
        name: 'regression-sentinel',
        baseAgent: 'codex',
        skipTest: false,
      },
    },
    {
      description: 'Broken forge request',
      forgeOptions: {
        skipTest: true,
      },
    },
  ]);
  assert.deepEqual(output.sessions, []);
});

test('daemon-backed MCP tool handlers document request and error contracts', () => {
  const output = runHarness({
    command: 'invokeMany',
    parseArgsOptions: { url: 'http://daemon.test:4173' },
    healthOk: true,
    healthPayload: { available: true, uptimeMs: 1234 },
    requestResponses: {
      '/summary': {
        summary: {
          openTasks: [
            { id: 'task-1', title: 'Write tests', status: 'todo', owner: 'codex', type: 'test' },
            {
              id: 'task-2',
              title: 'Review tests',
              status: 'done',
              owner: 'gemini',
              type: 'review',
            },
            { id: 'task-3', title: 'Ship tests', status: 'done', owner: 'codex', type: 'deploy' },
          ],
        },
      },
      '/task/claim': {
        task: {
          id: 'task-9',
          title: 'Characterize MCP server',
          status: 'in_progress',
          owner: 'codex',
        },
      },
      '/task/update': {
        task: {
          id: 'task-9',
          status: 'done',
          notes: 'Finished characterization',
          claimToken: 'claim-1',
        },
      },
      '/task/checkpoint': {
        checkpoint: { id: 'cp-1', taskId: 'task-9', name: 'tests-green' },
      },
      '/state': {
        state: {
          handoffs: [
            { id: 'handoff-1', to: 'codex', acknowledgedAt: null },
            { id: 'handoff-2', to: 'codex', acknowledgedAt: '2026-01-01T00:00:00Z' },
            { id: 'handoff-3', to: 'gemini', acknowledgedAt: null },
          ],
        },
      },
      '/handoff/ack': {
        handoff: { id: 'handoff-1', acknowledgedAt: '2026-01-02T00:00:00Z', by: 'codex' },
      },
      '/decision': {
        decision: { id: 'decision-1', title: 'Council requested: Should we refactor?' },
      },
      '/health': { available: true, uptimeMs: 1234 },
    },
    calls: [
      { name: 'hydra_tasks_list', args: { status: 'done', owner: 'codex', limit: 1, offset: 0 } },
      {
        name: 'hydra_tasks_claim',
        args: { agent: 'codex', title: 'Characterize MCP server', notes: 'rf-sn11' },
      },
      { name: 'hydra_tasks_claim', args: { agent: 'codex' } },
      {
        name: 'hydra_tasks_update',
        args: {
          taskId: 'task-9',
          status: 'done',
          notes: 'Finished characterization',
          claimToken: 'claim-1',
        },
      },
      {
        name: 'hydra_tasks_checkpoint',
        args: {
          taskId: 'task-9',
          name: 'tests-green',
          context: 'All checks passed',
          agent: 'codex',
        },
      },
      { name: 'hydra_handoffs_pending', args: { agent: 'codex' } },
      { name: 'hydra_handoffs_ack', args: { handoffId: 'handoff-1', agent: 'codex' } },
      { name: 'hydra_council_request', args: { prompt: 'Should we refactor?' } },
      { name: 'hydra_status', args: {} },
    ],
  });

  const tasksListResult = getResult(output, 'hydra_tasks_list');
  assertStructuredJsonResult(tasksListResult);
  assert.deepEqual(tasksListResult.result?.structuredContent, {
    tasks: [{ id: 'task-3', title: 'Ship tests', status: 'done', owner: 'codex', type: 'deploy' }],
    total: 1,
    count: 1,
    offset: 0,
    has_more: false,
  });

  const taskClaimResults =
    output.results?.filter((entry) => entry.name === 'hydra_tasks_claim') ?? [];
  assert.equal(taskClaimResults.length, 2);
  assertStructuredJsonResult(taskClaimResults[0]);
  assert.deepEqual(taskClaimResults[0].result?.structuredContent, {
    task: { id: 'task-9', title: 'Characterize MCP server', status: 'in_progress', owner: 'codex' },
  });
  assert.deepEqual(taskClaimResults[1].result, {
    content: [
      {
        type: 'text',
        text: 'Error: Either taskId or title is required. Provide taskId to claim an existing task (use hydra_tasks_list to find one), or title to create a new task.',
      },
    ],
    isError: true,
  });

  const taskUpdateResult = getResult(output, 'hydra_tasks_update');
  assertStructuredJsonResult(taskUpdateResult);
  assert.deepEqual(taskUpdateResult.result?.structuredContent, {
    task: {
      id: 'task-9',
      status: 'done',
      notes: 'Finished characterization',
      claimToken: 'claim-1',
    },
  });

  const checkpointResult = getResult(output, 'hydra_tasks_checkpoint');
  assertStructuredJsonResult(checkpointResult);
  assert.deepEqual(checkpointResult.result?.structuredContent, {
    checkpoint: { id: 'cp-1', taskId: 'task-9', name: 'tests-green' },
  });

  const handoffsPendingResult = getResult(output, 'hydra_handoffs_pending');
  assertStructuredJsonResult(handoffsPendingResult);
  assert.deepEqual(handoffsPendingResult.result?.structuredContent, {
    handoffs: [{ id: 'handoff-1', to: 'codex', acknowledgedAt: null }],
    count: 1,
  });

  const handoffsAckResult = getResult(output, 'hydra_handoffs_ack');
  assertStructuredJsonResult(handoffsAckResult);
  assert.deepEqual(handoffsAckResult.result?.structuredContent, {
    handoff: { id: 'handoff-1', acknowledgedAt: '2026-01-02T00:00:00Z', by: 'codex' },
  });

  const councilResult = getResult(output, 'hydra_council_request');
  assertStructuredJsonResult(councilResult);
  assert.deepEqual(councilResult.result?.structuredContent, {
    queued: true,
    decision: { id: 'decision-1', title: 'Council requested: Should we refactor?' },
    message:
      'Council request recorded. Open the Hydra operator console (`npm run go`) and run `:council` to begin deliberation.',
  });

  const statusResult = getResult(output, 'hydra_status');
  assertStructuredJsonResult(statusResult);
  assert.deepEqual(statusResult.result?.structuredContent, { available: true, uptimeMs: 1234 });

  assert.deepEqual(output.requestCalls, [
    { method: 'GET', baseUrl: 'http://daemon.test:4173', path: '/summary', body: null },
    {
      method: 'POST',
      baseUrl: 'http://daemon.test:4173',
      path: '/task/claim',
      body: { agent: 'codex', title: 'Characterize MCP server', notes: 'rf-sn11' },
    },
    {
      method: 'POST',
      baseUrl: 'http://daemon.test:4173',
      path: '/task/update',
      body: {
        taskId: 'task-9',
        status: 'done',
        notes: 'Finished characterization',
        claimToken: 'claim-1',
      },
    },
    {
      method: 'POST',
      baseUrl: 'http://daemon.test:4173',
      path: '/task/checkpoint',
      body: {
        taskId: 'task-9',
        name: 'tests-green',
        context: 'All checks passed',
        agent: 'codex',
      },
    },
    { method: 'GET', baseUrl: 'http://daemon.test:4173', path: '/state', body: null },
    {
      method: 'POST',
      baseUrl: 'http://daemon.test:4173',
      path: '/handoff/ack',
      body: { handoffId: 'handoff-1', agent: 'codex' },
    },
    {
      method: 'POST',
      baseUrl: 'http://daemon.test:4173',
      path: '/decision',
      body: {
        title: 'Council requested: Should we refactor?',
        owner: 'human',
        rationale: 'Agent requested council deliberation for: Should we refactor?',
        impact: 'pending council review',
      },
    },
    { method: 'GET', baseUrl: 'http://daemon.test:4173', path: '/health', body: null },
  ]);
});

test('daemon-backed tools surface a consistent offline error', () => {
  const output = runHarness({
    command: 'invokeMany',
    healthOk: false,
    calls: [
      { name: 'hydra_tasks_list', args: {} },
      { name: 'hydra_status', args: {} },
    ],
  });

  for (const result of output.results ?? []) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      name: 'Error',
      message:
        'Hydra daemon is not running. Start it with `npm start` to use daemon tools. The `hydra_ask` tool works without the daemon.',
    });
  }
});
