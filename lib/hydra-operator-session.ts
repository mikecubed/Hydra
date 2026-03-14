/**
 * Daemon session helpers for the Hydra Operator Console.
 *
 * Contains executeDaemonResume — the logic behind the :resume command —
 * extracted from interactiveLoop to keep operator.ts focused on REPL wiring.
 */

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
  body?: unknown,
) => Promise<unknown>;

/** Signature of the worker launcher (matches hydra-operator-workers.startAgentWorkers). */
type StartWorkersFn = (agents: string[], baseUrl: string, opts: { rl: ReadlineInterface }) => void;

interface SessionStatus {
  activeSession?: { status?: string };
  staleTasks?: Array<{ id: string; owner: string; updatedAt: string }>;
  pendingHandoffs?: Array<{ id: string; to?: string; summary?: string }>;
  inProgressTasks?: Array<{ owner?: string }>;
  agentSuggestions?: Record<string, { action?: string }>;
}

async function resetStaleTasks(
  stale: SessionStatus['staleTasks'],
  resumeBaseUrl: string,
  requestFn: RequestFn,
): Promise<void> {
  if (stale == null || stale.length === 0) return;
  console.log('');
  await Promise.all(
    stale.map(async (t) => {
      try {
        await requestFn('POST', resumeBaseUrl, '/task/update', { taskId: t.id, status: 'todo' });
        const mins = Math.round((Date.now() - new Date(t.updatedAt).getTime()) / 60_000);
        console.log(
          `  ${WARNING('↻')} ${pc.white(t.id)} ${colorAgent(t.owner)} reset to todo ${DIM(`(was stale ${String(mins)}m)`)}`,
        );
      } catch {
        /* skip */
      }
    }),
  );
}

async function ackPendingHandoffs(
  handoffs: SessionStatus['pendingHandoffs'],
  resumeBaseUrl: string,
  requestFn: RequestFn,
  agentsToLaunch: Set<string>,
): Promise<void> {
  if (handoffs == null || handoffs.length === 0) return;
  console.log('');
  await Promise.all(
    handoffs.map(async (h) => {
      const targetAgent = (h.to ?? '').toLowerCase();
      try {
        await requestFn('POST', resumeBaseUrl, '/handoff/ack', {
          handoffId: h.id,
          agent: targetAgent,
        });
        if (targetAgent !== '') agentsToLaunch.add(targetAgent);
      } catch (err: unknown) {
        console.log(`  ${ERROR('✗')} ${pc.white(h.id)} ${(err as Error).message}`);
      }
    }),
  );
}

function collectAgentsToLaunch(sessionStatus: SessionStatus): Set<string> {
  const agentsToLaunch = new Set<string>();
  for (const t of sessionStatus.inProgressTasks ?? []) {
    const owner = (t.owner ?? '').toLowerCase();
    if (owner !== '') agentsToLaunch.add(owner);
  }
  for (const [agent, suggestion] of Object.entries(sessionStatus.agentSuggestions ?? {})) {
    const action = suggestion.action;
    if (action != null && action !== '' && action !== 'idle' && action !== 'unknown') {
      agentsToLaunch.add(agent);
    }
  }
  return agentsToLaunch;
}

function buildResumeSummary(
  staleCount: number,
  handoffCount: number,
  launchCount: number,
): string[] {
  const actions: string[] = [];
  if (staleCount > 0)
    actions.push(`${String(staleCount)} stale task${staleCount > 1 ? 's' : ''} reset`);
  if (handoffCount > 0)
    actions.push(`${String(handoffCount)} handoff${handoffCount > 1 ? 's' : ''} acked`);
  if (launchCount > 0)
    actions.push(`${String(launchCount)} agent${launchCount > 1 ? 's' : ''} launched`);
  return actions;
}

/**
 * Implements the :resume command.
 *
 * Fetches session status, unpauses a paused session, resets stale tasks to
 * "todo", acks pending handoffs, and starts agent workers for any agents with
 * outstanding work.
 */
export async function executeDaemonResume(
  resumeBaseUrl: string,
  resumeAgents: string[],
  resumeRl: ReadlineInterface,
  requestFn: RequestFn = defaultRequest,
  startWorkersFn: StartWorkersFn = startAgentWorkers,
): Promise<void> {
  try {
    const sessionStatus = (await requestFn(
      'GET',
      resumeBaseUrl,
      '/session/status',
    )) as SessionStatus;

    if (sessionStatus.activeSession?.status === 'paused') {
      try {
        await requestFn('POST', resumeBaseUrl, '/session/unpause');
        console.log(`  ${SUCCESS('✓')} Session unpaused`);
      } catch (err: unknown) {
        console.log(`  ${WARNING('⚠')} Could not unpause: ${(err as Error).message}`);
      }
    }

    const stale = sessionStatus.staleTasks ?? [];
    await resetStaleTasks(stale, resumeBaseUrl, requestFn);

    const handoffs = sessionStatus.pendingHandoffs ?? [];
    const agentsToLaunch = collectAgentsToLaunch(sessionStatus);
    await ackPendingHandoffs(handoffs, resumeBaseUrl, requestFn, agentsToLaunch);

    const launchList = ([...agentsToLaunch] as string[]).filter((a) => resumeAgents.includes(a));
    if (launchList.length > 0) {
      console.log('');
      startWorkersFn(launchList, resumeBaseUrl, { rl: resumeRl });
    }

    const actions = buildResumeSummary(stale.length, handoffs.length, launchList.length);
    if (actions.length > 0) {
      console.log('');
      console.log(`  ${SUCCESS('✓')} ${actions.join(', ')}`);
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
}
