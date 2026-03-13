import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HYDRA_EMBEDDED_ROOT,
  HYDRA_STANDALONE,
  HYDRA_INTERNAL_FLAG,
  toHydraModuleId,
  rewriteNodeInvocation,
  spawnHydraNode,
  spawnHydraNodeSync,
} from './hydra-exec-spawn.ts';

// Re-export spawn utilities so existing importers of hydra-exec.ts keep working.
export {
  HYDRA_EMBEDDED_ROOT,
  HYDRA_STANDALONE,
  HYDRA_INTERNAL_FLAG,
  toHydraModuleId,
  rewriteNodeInvocation,
  spawnHydraNode,
  spawnHydraNodeSync,
};

// INTERNAL_MODULE_LOADERS uses dynamic imports so standalone bundlers can
// statically include every internal module. hydra-operator.ts is safe here
// because it imports from hydra-exec-spawn.ts (not hydra-exec.ts), which
// breaks the circular dependency.
const INTERNAL_MODULE_LOADERS: Partial<Record<string, () => Promise<unknown>>> = {
  'lib/hydra-operator.ts': () => import('./hydra-operator.ts'),
  'lib/orchestrator-daemon.ts': () => import('./orchestrator-daemon.ts'),
  'lib/orchestrator-client.ts': () => import('./orchestrator-client.ts'),
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
  if (normalized === '') return '';
  if (normalized.includes('..')) return '';
  return normalized;
}

export async function runHydraInternalModule(
  moduleId: unknown,
  moduleArgs: string[] = [],
  hydraRoot = HYDRA_EMBEDDED_ROOT,
): Promise<void> {
  const normalized = normalizeModuleId(moduleId);
  if (normalized === '') {
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
