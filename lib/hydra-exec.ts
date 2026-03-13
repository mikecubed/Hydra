import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import type {
  SpawnOptions,
  SpawnSyncOptions,
  ChildProcess,
  SpawnSyncReturns,
} from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HYDRA_EMBEDDED_ROOT = path.resolve(__dirname, '..');
export const HYDRA_STANDALONE = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
export const HYDRA_INTERNAL_FLAG = '--hydra-internal';

const INTERNAL_MODULE_LOADERS: Partial<Record<string, () => Promise<unknown>>> = {
  'lib/hydra-operator.ts': () => import('./hydra-operator.ts'),
  'lib/orchestrator-daemon.ts': () => import('./orchestrator-daemon.ts'),
  'lib/hydra-council.ts': () => import('./hydra-council.ts'),
  'lib/hydra-dispatch.ts': () => import('./hydra-dispatch.ts'),
  'lib/hydra-models-select.ts': () => import('./hydra-models-select.ts'),
  'lib/hydra-tasks.ts': () => import('./hydra-tasks.ts'),
  'lib/hydra-tasks-review.ts': () => import('./hydra-tasks-review.ts'),
  'lib/hydra-nightly.ts': () => import('./hydra-nightly.ts'),
  'lib/hydra-nightly-review.ts': () => import('./hydra-nightly-review.ts'),
  'lib/hydra-evolve.ts': () => import('./hydra-evolve.ts'),
  'lib/hydra-evolve-review.ts': () => import('./hydra-evolve-review.ts'),
  'lib/sync.ts': () => import('./sync.ts'),
  'lib/hydra-setup.ts': () => import('./hydra-setup.ts'),
};

function normalizeModuleId(moduleId: unknown): string {
  const normalized = (typeof moduleId === 'string' ? moduleId : '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\.mjs$/, '.ts'); // normalize legacy .mjs IDs to .ts
  if (!normalized) return '';
  if (normalized.includes('..')) return '';
  return normalized;
}

export function toHydraModuleId(scriptPath: string, hydraRoot = HYDRA_EMBEDDED_ROOT): string {
  const absolute = path.resolve(scriptPath);
  const rel = path.relative(hydraRoot, absolute).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) {
    return '';
  }
  return normalizeModuleId(rel);
}

export function rewriteNodeInvocation(
  command: string,
  args: string[] = [],
  hydraRoot = HYDRA_EMBEDDED_ROOT,
): { command: string; args: string[] } {
  if (!HYDRA_STANDALONE || command !== 'node' || !Array.isArray(args) || args.length === 0) {
    return { command, args };
  }

  const [scriptPath, ...scriptArgs] = args;
  const moduleId = toHydraModuleId(scriptPath, hydraRoot);
  if (!moduleId) {
    throw new Error(`Standalone Hydra cannot execute external script: ${scriptPath}`);
  }

  return {
    command: process.execPath,
    args: [HYDRA_INTERNAL_FLAG, moduleId, ...scriptArgs],
  };
}

export function spawnHydraNode(
  scriptPath: string,
  scriptArgs: string[] = [],
  options: SpawnOptions = {},
  hydraRoot = HYDRA_EMBEDDED_ROOT,
): ChildProcess {
  const invocation = rewriteNodeInvocation('node', [scriptPath, ...scriptArgs], hydraRoot);
  return spawn(invocation.command, invocation.args, options);
}

export function spawnHydraNodeSync(
  scriptPath: string,
  scriptArgs: string[] = [],
  options: SpawnSyncOptions = {},
  hydraRoot = HYDRA_EMBEDDED_ROOT,
): SpawnSyncReturns<Buffer | string> {
  const invocation = rewriteNodeInvocation('node', [scriptPath, ...scriptArgs], hydraRoot);
  return spawnSync(invocation.command, invocation.args, options);
}

export async function runHydraInternalModule(
  moduleId: unknown,
  moduleArgs: string[] = [],
  hydraRoot = HYDRA_EMBEDDED_ROOT,
): Promise<void> {
  const normalized = normalizeModuleId(moduleId);
  if (!normalized) {
    throw new Error('Missing or invalid Hydra internal module id.');
  }

  // Standalone executables route through a static import map so bundlers can include modules.
  if (HYDRA_STANDALONE) {
    const loader = INTERNAL_MODULE_LOADERS[normalized];
    if (!loader) {
      throw new Error(`Standalone build does not include internal module: ${normalized}`);
    }
    process.argv = [process.execPath, normalized, ...moduleArgs];
    await loader();
    return;
  }

  const modulePath = path.join(hydraRoot, normalized);
  const moduleUrl = pathToFileURL(modulePath).href;
  process.argv = [process.execPath, modulePath, ...moduleArgs];
  await import(moduleUrl);
}
