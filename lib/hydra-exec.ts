#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HYDRA_EMBEDDED_ROOT = path.resolve(__dirname, '..');
export const HYDRA_STANDALONE = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
export const HYDRA_INTERNAL_FLAG = '--hydra-internal';

const INTERNAL_MODULE_LOADERS: Record<string, () => Promise<unknown>> = {
  'lib/hydra-operator.mjs': () => import('./hydra-operator.mjs'),
  'lib/orchestrator-daemon.mjs': () => import('./orchestrator-daemon.mjs'),
  'lib/orchestrator-client.mjs': () => import('./orchestrator-client.mjs'),
  'lib/hydra-council.mjs': () => import('./hydra-council.ts'),
  'lib/hydra-dispatch.mjs': () => import('./hydra-dispatch.ts'),
  'lib/hydra-models-select.ts': () => import('./hydra-models-select.ts'),
  'lib/hydra-tasks.mjs': () => import('./hydra-tasks.mjs'),
  'lib/hydra-tasks-review.mjs': () => import('./hydra-tasks-review.mjs'),
  'lib/hydra-nightly.mjs': () => import('./hydra-nightly.mjs'),
  'lib/hydra-nightly-review.mjs': () => import('./hydra-nightly-review.mjs'),
  'lib/hydra-evolve.mjs': () => import('./hydra-evolve.mjs'),
  'lib/hydra-evolve-review.mjs': () => import('./hydra-evolve-review.mjs'),
  'lib/sync.mjs': () => import('./sync.mjs'),
  'lib/hydra-setup.ts': () => import('./hydra-setup.ts'),
};

function normalizeModuleId(moduleId: unknown): string {
  const normalized = String(moduleId || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
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

export function rewriteNodeInvocation(command: string, args: string[] = [], hydraRoot = HYDRA_EMBEDDED_ROOT) {
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
  options: import('node:child_process').SpawnOptions = {},
  hydraRoot = HYDRA_EMBEDDED_ROOT,
) {
  const invocation = rewriteNodeInvocation('node', [scriptPath, ...scriptArgs], hydraRoot);
  return spawn(invocation.command, invocation.args, options);
}

export function spawnHydraNodeSync(
  scriptPath: string,
  scriptArgs: string[] = [],
  options: import('node:child_process').SpawnSyncOptions = {},
  hydraRoot = HYDRA_EMBEDDED_ROOT,
) {
  const invocation = rewriteNodeInvocation('node', [scriptPath, ...scriptArgs], hydraRoot);
  return spawnSync(invocation.command, invocation.args, options);
}

export async function runHydraInternalModule(
  moduleId: unknown,
  moduleArgs: string[] = [],
  hydraRoot = HYDRA_EMBEDDED_ROOT,
) {
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
