/**
 * Hydra CLI Detection — lightweight helpers for checking whether AI agent CLIs
 * are accessible on PATH.
 *
 * Extracted from hydra-setup.ts so that runtime modules (hydra-dispatch,
 * hydra-actualize) can import only these utilities without pulling in the
 * heavier CLI/MCP-registration logic from hydra-setup.
 */

import { spawnSync } from 'node:child_process';
import { listAgents } from './hydra-agents.ts';

/**
 * Returns true when the named binary can be found on PATH.
 * Uses `which` (Unix) or `where` (Windows) via spawnSync.
 */
export function commandExists(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(cmd, [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 && Boolean(result.stdout?.trim());
  } catch {
    return false;
  }
}

/**
 * Detect which agent CLIs are installed and accessible on PATH.
 * Enumerates all registered physical agents with executeMode:'spawn' and checks
 * whether their CLI binary exists on PATH. New agents are picked up automatically
 * once registered — no manual edits required.
 *
 * Results per binary name are cached within a single call to avoid redundant
 * PATH lookups when multiple agents share the same CLI binary.
 *
 * @returns agent name → installed
 */
export function detectInstalledCLIs(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const binaryCache = new Map<string, boolean>();
  for (const agentDef of listAgents({ type: 'physical' })) {
    if (agentDef.features.executeMode !== 'spawn') continue;
    const binaryName = agentDef.cli ?? agentDef.name;
    let isInstalled = binaryCache.get(binaryName);
    if (isInstalled === undefined) {
      isInstalled = commandExists(binaryName);
      binaryCache.set(binaryName, isInstalled);
    }
    result[agentDef.name] = isInstalled;
  }
  return result;
}
