/**
 * Daemon session helpers for the Hydra Operator Console.
 *
 * Contains executeDaemonResume — the logic behind the :resume command —
 * extracted from interactiveLoop to keep operator.ts focused on REPL wiring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */

import type { Interface as ReadlineInterface } from 'node:readline';
import pc from 'picocolors';
import { SUCCESS, ERROR, WARNING, colorAgent, DIM } from './hydra-ui.ts';
import { request as defaultRequest } from './hydra-utils.ts';
import { startAgentWorkers } from './hydra-operator-workers.ts';

/** Signature of the HTTP request helper (matches hydra-utils.request). */
type RequestFn = (
  method: string,
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Implements the :resume command.
 *
 * Fetches session status, unpauses a paused session, resets stale tasks to
 * "todo", acks pending handoffs, and starts agent workers for any agents with
 * outstanding work.
 *
 * @param resumeBaseUrl  Daemon base URL (e.g. "http://127.0.0.1:4173").
 * @param resumeAgents   Agents currently tracked by the operator.
 * @param resumeRl       Active readline interface (forwarded to startAgentWorkers).
 * @param requestFn      Override for the HTTP helper; defaults to hydra-utils.request.
 */
export async function executeDaemonResume(
  resumeBaseUrl: string,
  resumeAgents: string[],
  resumeRl: ReadlineInterface,
  requestFn: RequestFn = defaultRequest as unknown as RequestFn,
): Promise<void> {
  try {
    const sessionStatus = (await requestFn('GET', resumeBaseUrl, '/session/status')) as any;

    // Unpause if paused
    if (sessionStatus.activeSession?.status === 'paused') {
      try {
        await requestFn('POST', resumeBaseUrl, '/session/unpause');
        console.log(`  ${SUCCESS('✓')} Session unpaused`);
      } catch (err: unknown) {
        console.log(`  ${WARNING('⚠')} Could not unpause: ${(err as Error).message}`);
      }
    }

    // Reset stale tasks
    const stale = sessionStatus.staleTasks ?? [];
    if (stale.length > 0) {
      console.log('');
      for (const t of stale) {
        try {
          await requestFn('POST', resumeBaseUrl, '/task/update', {
            taskId: t.id,
            status: 'todo',
          });
          const mins = Math.round((Date.now() - new Date(t.updatedAt).getTime()) / 60_000);
          console.log(
            `  ${WARNING('↻')} ${pc.white(t.id)} ${colorAgent(t.owner)} reset to todo ${DIM(`(was stale ${String(mins)}m)`)}`,
          );
        } catch {
          /* skip */
        }
      }
    }

    // Ack pending handoffs
    const handoffs = sessionStatus.pendingHandoffs ?? [];
    const agentsToLaunch = new Set<string>();
    if (handoffs.length > 0) {
      console.log('');
      for (const h of handoffs) {
        const targetAgent = String(h.to ?? '').toLowerCase();
        try {
          await requestFn('POST', resumeBaseUrl, '/handoff/ack', {
            handoffId: h.id,
            agent: targetAgent,
          });
          if (targetAgent) agentsToLaunch.add(targetAgent);
        } catch (err: unknown) {
          console.log(`  ${ERROR('✗')} ${pc.white(h.id)} ${(err as Error).message}`);
        }
      }
    }

    // Collect in-progress agent owners
    for (const t of sessionStatus.inProgressTasks ?? []) {
      const owner = String(t.owner ?? '').toLowerCase();
      if (owner) agentsToLaunch.add(owner);
    }

    // Agent suggestions
    for (const [agent, suggestion] of Object.entries(sessionStatus.agentSuggestions ?? {})) {
      if (
        (suggestion as any)?.action &&
        (suggestion as any).action !== 'idle' &&
        (suggestion as any).action !== 'unknown'
      ) {
        agentsToLaunch.add(agent);
      }
    }

    // Launch workers for agents that have work to do
    const launchList = ([...agentsToLaunch] as string[]).filter((a) => resumeAgents.includes(a));
    if (launchList.length > 0) {
      console.log('');
      startAgentWorkers(launchList, resumeBaseUrl, { rl: resumeRl });
    }

    // Summary line
    const actions: string[] = [];
    if (stale.length > 0)
      actions.push(`${String(stale.length)} stale task${stale.length > 1 ? 's' : ''} reset`);
    if (handoffs.length > 0)
      actions.push(`${String(handoffs.length)} handoff${handoffs.length > 1 ? 's' : ''} acked`);
    if (launchList.length > 0)
      actions.push(
        `${String(launchList.length)} agent${launchList.length > 1 ? 's' : ''} launched`,
      );
    if (actions.length > 0) {
      console.log('');
      console.log(`  ${SUCCESS('✓')} ${actions.join(', ')}`);
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
}
