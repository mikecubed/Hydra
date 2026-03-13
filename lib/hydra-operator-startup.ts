/**
 * hydra-operator-startup.ts
 *
 * Daemon auto-start helpers, agent terminal launchers, and the printWelcome screen.
 * Extracted from hydra-operator.ts to keep operator.ts focused on the interactive loop.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- startup helpers use polymorphic any for dynamic dispatch */
/* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-base-to-string -- standard JS truthiness patterns */
/* eslint-disable no-await-in-loop -- sequential health-check polling */

import path from 'node:path';
import { exec, spawnSync } from 'node:child_process';
import { spawnHydraNode } from './hydra-exec-spawn.ts';
import {
  getAgent,
  getModelSummary,
  getMode,
  formatEffortDisplay,
  AGENT_TYPE,
} from './hydra-agents.ts';
import { checkUsage, formatTokens } from './hydra-usage.ts';
import { getSessionUsage } from './hydra-metrics.ts';
import { resolveProject, HYDRA_ROOT } from './hydra-config.ts';
import { request } from './hydra-utils.ts';
import {
  hydraSplash,
  label,
  colorAgent,
  SUCCESS,
  DIM,
  WARNING,
  ACCENT,
  AGENT_COLORS,
} from './hydra-ui.ts';
import { syncHydraMd } from './hydra-sync-md.ts';
import { printNextSteps } from './hydra-operator-ui.ts';
import {
  loadProviderUsage,
  refreshExternalUsage,
  getProviderSummary,
  getExternalSummary,
} from './hydra-provider-usage.ts';
import pc from 'picocolors';

// Module-level config (same pattern as hydra-operator.ts)
const config = resolveProject();

// ── Daemon Auto-Start ────────────────────────────────────────────────────────

export async function ensureDaemon(
  baseUrl: string,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<boolean> {
  // Check if daemon is already running
  try {
    (await request('GET', baseUrl, '/health')) as any;
    return true;
  } catch {
    // Not running — try to start it
  }

  if (!quiet) {
    process.stderr.write(`  ${DIM('\u2026')} Starting daemon...\n`);
  }

  const daemonScript = path.join(HYDRA_ROOT, 'lib', 'orchestrator-daemon.mjs');
  const child = spawnHydraNode(daemonScript, ['start'], {
    cwd: config.projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Wait for health (up to 8 seconds)
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => {
      setTimeout(r, 250);
    });
    try {
      (await request('GET', baseUrl, '/health')) as any;
      if (!quiet) {
        process.stderr.write(`  ${SUCCESS('\u2713')} Daemon started\n`);
      }
      return true;
    } catch {
      // keep waiting
    }
  }

  return false;
}

// ── Agent Terminal Auto-Launch ───────────────────────────────────────────────

/**
 * Detect pwsh or powershell on Windows. Returns exe path or null.
 */
export function findPowerShell(): string | null {
  if (process.platform !== 'win32') return null;
  for (const cmd of ['pwsh', 'powershell']) {
    try {
      const result = spawnSync('where', [cmd], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      });
      const exe = (result.stdout || '').split('\n')[0].trim();
      if (exe) return exe;
    } catch {
      /* not found */
    }
  }
  return null;
}

/**
 * Detect Windows Terminal (wt.exe). Returns exe path or null.
 */
export function findWindowsTerminal(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const result = spawnSync('where', ['wt'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    const exe = (result.stdout || '').split('\n')[0].trim();
    if (exe) return exe;
  } catch {
    /* not found */
  }
  return null;
}

/**
 * Spawn visible terminal windows running hydra-head.ps1 for each agent.
 * Uses -EncodedCommand to avoid escaping issues, and exec(start ...) for
 * reliable window visibility on Windows.
 */
export function launchAgentTerminals(agentNames: string[], baseUrl: string): void {
  if (process.platform !== 'win32' || agentNames.length === 0) return;
  if ((process as any).pkg) {
    console.log(
      `  ${DIM('(standalone build: terminal launch disabled; use :workers start instead)')}`,
    );
    return;
  }

  const shell = findPowerShell();
  if (!shell) {
    console.log(`  ${DIM('(skipping terminal launch — no PowerShell found)')}`);
    return;
  }

  const wt = findWindowsTerminal();
  const headScript = path.join(HYDRA_ROOT, 'bin', 'hydra-head.ps1');
  const cwd = config.projectRoot;
  const cwdEscaped = cwd.replace(/'/g, "''");

  for (const agent of agentNames) {
    if (!getAgent(agent)) continue;
    const title = `Hydra Head - ${agent.toUpperCase()}`;
    const psCommand = [
      `Set-Location -LiteralPath '${cwdEscaped}'`,
      `& '${headScript}' -Agent ${agent} -Url '${baseUrl}'`,
    ].join('; ');

    // Encode as UTF-16LE base64 for -EncodedCommand (avoids all escaping issues)
    const encoded = Buffer.from(psCommand, 'utf16le').toString('base64');

    let cmd;
    if (wt) {
      // Windows Terminal: open a new tab in the current window
      cmd = `wt -w 0 new-tab --title "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    } else {
      // Fallback: start command reliably opens a visible console window
      cmd = `start "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    }
    exec(cmd, { cwd });

    const icon =
      ({ gemini: '\u2726', codex: '\u25B6', claude: '\u2666' } as Record<string, string>)[agent] ||
      '\u25CF';
    console.log(`  ${SUCCESS('\u2713')} ${colorAgent(agent)} ${icon} ${agent}  terminal launched`);
  }
}

/**
 * Extract unique agent names from auto/smart dispatch result.
 */
export function extractHandoffAgents(result: Record<string, unknown>): string[] {
  const handoffs = (result as any)?.published?.handoffs;
  if (!Array.isArray(handoffs) || handoffs.length === 0) return [];
  const seen = new Set<string>();
  for (const h of handoffs) {
    const name = String(h.to ?? '').toLowerCase();
    if (name && getAgent(name)) seen.add(name);
  }
  return [...seen];
}

// ── Welcome Screen ───────────────────────────────────────────────────────────

export async function printWelcome(baseUrl: string): Promise<void> {
  console.log(hydraSplash());
  console.log(label('Project', pc.white(config.projectName)));
  // Sync HYDRA.md → agent instruction files on startup
  try {
    const syncResult = syncHydraMd(config.projectRoot);
    if (syncResult.synced.length > 0) {
      console.log(label('Sync', DIM(`HYDRA.md → ${syncResult.synced.join(', ')}`)));
    }
  } catch {
    /* non-critical */
  }

  console.log(label('Daemon', DIM(baseUrl)));

  // Startup alert: check for in-progress tasks and pending handoffs
  try {
    const sessionStatus = (await request('GET', baseUrl, '/session/status')) as any;
    if (sessionStatus.activeSession?.status === 'paused') {
      const reason = sessionStatus.activeSession.pauseReason;
      console.log(
        `  ${WARNING('\u23F8')} Session paused${reason ? `: "${String(reason)}"` : ''} \u2014 type ${ACCENT(':unpause')} to resume`,
      );
    }
    const inProgressCount = (sessionStatus.inProgressTasks ?? []).length;
    const handoffCount = (sessionStatus.pendingHandoffs ?? []).length;
    const staleCount = (sessionStatus.staleTasks ?? []).length;
    const parts = [];
    if (inProgressCount > 0)
      parts.push(`${String(inProgressCount)} task${inProgressCount === 1 ? '' : 's'} in progress`);
    if (handoffCount > 0)
      parts.push(`${String(handoffCount)} handoff${handoffCount === 1 ? '' : 's'} pending`);
    if (staleCount > 0) parts.push(`${String(staleCount)} stale`);
    if (parts.length > 0) {
      console.log(
        `  ${WARNING('\u26A0')} ${parts.join(', ')} \u2014 type ${ACCENT(':resume')} for details`,
      );
    }
  } catch {
    /* daemon may not have session data yet */
  }

  // Mode & Models
  try {
    const models = getModelSummary();
    const currentMode = (models['_mode'] ?? getMode()) as string;
    console.log(label('Mode', ACCENT(currentMode)));
    const parts = [];
    for (const [agent, info] of Object.entries(models)) {
      if (agent === '_mode') continue;
      const colorFn = (AGENT_COLORS as any)[agent] ?? pc.white;
      const shortModel = ((info as any).active ?? '')
        .replace(/^claude-/, '')
        .replace(/^gemini-/, '');
      const tag = (info as any).isOverride ? pc.yellow(' *') : '';
      const effLabel = formatEffortDisplay(
        (info as any).active,
        (info as Record<string, any>)['reasoningEffort'],
      );
      const eff = effLabel ? pc.yellow(` ${effLabel}`) : '';
      parts.push(`${String(colorFn(agent))}${DIM(':')}${pc.white(shortModel)}${eff}${tag}`);
    }
    console.log(label('Models', parts.join(DIM('  '))));
  } catch {
    /* skip */
  }

  // Usage — show today's actual tokens from stats-cache
  try {
    const usage = checkUsage();
    if (usage.todayTokens > 0) {
      const modelShort = (usage.model ?? '').replace(/^claude-/, '').replace(/^gemini-/, '');
      console.log(
        label(
          'Today',
          `${pc.white(formatTokens(usage.todayTokens))} tokens ${modelShort ? DIM(`(${modelShort})`) : ''}`,
        ),
      );
    }
  } catch {
    /* skip */
  }

  // Session token usage (from real Claude JSON output)
  try {
    const session = getSessionUsage();
    if (session.callCount > 0) {
      console.log(
        label(
          'Session',
          `${pc.white(formatTokens(session.totalTokens))} tokens  ${pc.white(`$${session.costUsd.toFixed(4)}`)}  ${DIM(`(${String(session.callCount)} calls)`)}`,
        ),
      );
    }
  } catch {
    /* skip */
  }

  // Provider usage (load persisted + refresh external in background)
  try {
    loadProviderUsage();
    void refreshExternalUsage(); // non-blocking
    const providerLines = getProviderSummary();
    if (providerLines.length > 0) {
      console.log(label('Providers', providerLines.join(DIM(' │ '))));
    }
    const extLines = getExternalSummary();
    if (extLines.length > 0) {
      console.log(label('Account', extLines.join(DIM(' │ '))));
    }
  } catch {
    /* skip */
  }

  // Context-aware next steps on startup
  try {
    const sessionStatus = (await request('GET', baseUrl, '/session/status')) as any;
    printNextSteps({
      agentSuggestions: sessionStatus.agentSuggestions,
      pendingHandoffs: sessionStatus.pendingHandoffs,
      staleTasks: sessionStatus.staleTasks,
      inProgressTasks: sessionStatus.inProgressTasks,
    });
  } catch {
    console.log(`  ${DIM('Type a prompt to dispatch, or :help for commands')}`);
  }
}

// Silence unused import warning — AGENT_TYPE is re-exported for module consumers
void AGENT_TYPE;
