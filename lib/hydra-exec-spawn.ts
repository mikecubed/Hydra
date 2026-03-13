/**
 * Spawn utilities for launching Hydra sub-processes.
 *
 * Extracted from hydra-exec.ts so that modules like hydra-operator.ts can import
 * these helpers without pulling in INTERNAL_MODULE_LOADERS (which imports
 * hydra-operator.ts back, creating a circular dependency).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

export function toHydraModuleId(scriptPath: string, hydraRoot = HYDRA_EMBEDDED_ROOT): string {
  const absolute = path.resolve(scriptPath);
  const rel = path.relative(hydraRoot, absolute).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('..')) {
    return '';
  }
  const normalized = rel
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\.mjs$/, '.ts');
  return normalized !== '' && !normalized.includes('..') ? normalized : '';
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
  if (moduleId === '') {
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
