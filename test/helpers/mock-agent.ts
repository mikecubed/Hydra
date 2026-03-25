import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HELPERS_DIR, '../fixtures/agent-responses');

interface AgentResult {
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  error: string | null;
  exitCode: number;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  [key: string]: unknown;
}

interface FixtureResponse {
  ok: boolean;
  output?: string;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  exitCode?: number;
  signal?: string | null;
  durationMs?: number;
  timedOut?: boolean;
  [key: string]: unknown;
}

interface RawFixtureEntry {
  id?: string;
  matchPattern: string | RegExp | null;
  response: FixtureResponse;
  [key: string]: unknown;
}

interface NormalizedFixtureEntry {
  id: string;
  matchPattern: RegExp | null;
  response: FixtureResponse;
  [key: string]: unknown;
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return JSON.parse(JSON.stringify(value));
}

export function makeSuccessResult(output: unknown, opts: Partial<AgentResult> = {}): AgentResult {
  const text = typeof output === 'string' ? output : '';
  return {
    ok: true,
    output: text,
    stdout: text,
    stderr: '',
    error: null,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    ...deepClone(opts),
  };
}

export function makeFailureResult(error: unknown, opts: Partial<AgentResult> = {}): AgentResult {
  const text = typeof error === 'string' ? error : 'Mock execution failed';
  return {
    ok: false,
    output: '',
    stdout: '',
    stderr: text,
    error: text,
    exitCode: 1,
    signal: null,
    durationMs: 1,
    timedOut: false,
    ...deepClone(opts),
  };
}

function normalizeFixtureEntry(
  agent: string,
  entry: RawFixtureEntry,
  index: number,
): NormalizedFixtureEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Fixture entry ${index} for ${agent} must be an object`);
  }

  const id = entry.id ?? `entry-${index}`;
  const { matchPattern } = entry;

  if (
    matchPattern !== null &&
    typeof matchPattern !== 'string' &&
    !(matchPattern instanceof RegExp)
  ) {
    throw new Error(
      `Fixture entry "${id}" for ${agent} must use a string, RegExp, or null matchPattern`,
    );
  }

  if (!entry.response || typeof entry.response !== 'object') {
    throw new Error(`Fixture entry "${id}" for ${agent} must include a response object`);
  }

  return {
    ...entry,
    id,
    response: deepClone(entry.response),
    matchPattern: (() => {
      if (matchPattern === null) return null;
      if (matchPattern instanceof RegExp) return matchPattern;
      return new RegExp(matchPattern, 'i');
    })(),
  };
}

function validateFixtures(agent: string, entries: RawFixtureEntry[]): NormalizedFixtureEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Fixture list for ${agent} must be a non-empty array`);
  }

  const normalized = entries.map((entry, index) => normalizeFixtureEntry(agent, entry, index));
  const defaultEntry = normalized.find((entry) => entry.id === 'default');
  const nullMatchEntries = normalized.filter((entry) => entry.matchPattern === null);

  if (defaultEntry?.matchPattern !== null) {
    throw new Error(
      `Fixture list for ${agent} must include a default entry with matchPattern null (id "default")`,
    );
  }

  if (nullMatchEntries.length !== 1) {
    throw new Error(
      `Fixture list for ${agent} must contain exactly one default entry with matchPattern null`,
    );
  }

  return normalized;
}

function cloneResult(result: FixtureResponse): AgentResult {
  const cloned = deepClone(result) as AgentResult;
  if (cloned.error === undefined) {
    cloned.error = cloned.ok ? null : (cloned.stderr ?? 'Mock execution failed');
  }
  return cloned;
}

function normalizeResponse(response: FixtureResponse): AgentResult {
  const output = typeof response.output === 'string' ? response.output : '';
  const error = response.error ?? response.stderr ?? 'Mock execution failed';
  const errorStr = typeof error === 'string' ? error : 'Mock execution failed';

  return cloneResult(
    response.ok
      ? makeSuccessResult(output, response as Partial<AgentResult>)
      : makeFailureResult(errorStr, response as Partial<AgentResult>),
  );
}

export async function loadAgentFixture(agent: string): Promise<NormalizedFixtureEntry[]> {
  const fixturePath = path.join(FIXTURES_DIR, `${agent}.json`);
  try {
    const raw = await fs.readFile(fixturePath, 'utf8');
    const parsed = JSON.parse(raw) as RawFixtureEntry[];
    return validateFixtures(agent, parsed);
  } catch (err: unknown) {
    throw new Error(
      `Unable to load mock fixture for ${agent} from ${fixturePath}: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }
}

export function createMockExecuteAgent(
  fixtureMap: Record<string, RawFixtureEntry[]>,
): (agent: string, prompt: string, opts?: Record<string, unknown>) => Promise<AgentResult> {
  if (!fixtureMap || typeof fixtureMap !== 'object') {
    throw new Error('createMockExecuteAgent requires a fixture map object');
  }

  const validatedMap = Object.fromEntries(
    Object.entries(fixtureMap).map(([agent, entries]) => [agent, validateFixtures(agent, entries)]),
  );

  return async function mockExecuteAgent(
    agent: string,
    prompt: string,
    opts: Record<string, unknown> = {},
  ): Promise<AgentResult> {
    void opts;

    const fixtures = validatedMap[agent];
    if (!fixtures) {
      throw new Error(`Unknown mock agent "${agent}"`);
    }

    const promptText = prompt ?? '';
    const matched = fixtures.find(
      (entry) => entry.matchPattern instanceof RegExp && entry.matchPattern.test(promptText),
    );
    const fallback = fixtures.find((entry) => entry.id === 'default');
    const selected = matched ?? fallback;

    if (!selected) {
      throw new Error(`No default fixture available for ${agent}`);
    }

    return normalizeResponse(selected.response);
  };
}
