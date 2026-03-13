/**
 * CLI command handlers for the orchestrator daemon binary.
 * Handles the `status` and `stop` subcommands, plus the help text.
 */

import { requestJson } from './http-utils.ts';

const DEFAULT_HOST = process.env['AI_ORCH_HOST'] ?? '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env['AI_ORCH_PORT'] ?? '4173', 10);
const ORCH_TOKEN = process.env['AI_ORCH_TOKEN'] ?? '';

export function printHelp(): void {
  console.log(`
Hydra Orchestrator Daemon

Usage:
  node orchestrator-daemon.mjs start [host=127.0.0.1] [port=4173]
  node orchestrator-daemon.mjs status [url=http://127.0.0.1:4173]
  node orchestrator-daemon.mjs stop [url=http://127.0.0.1:4173]

Environment:
  AI_ORCH_HOST   Host bind (default: 127.0.0.1)
  AI_ORCH_PORT   Port bind (default: 4173)
  AI_ORCH_TOKEN  Optional API token for write endpoints
  HYDRA_PROJECT  Override target project directory
`);
}

export async function commandStatus(options: Record<string, string>): Promise<void> {
  const url = options['url'] ?? `http://${DEFAULT_HOST}:${String(DEFAULT_PORT)}`;
  try {
    const { response, payload } = await requestJson('GET', `${url}/health`, null, ORCH_TOKEN);
    if (!response.ok) {
      console.error(
        `Daemon status check failed (${String(response.status)}): ${((payload as Record<string, unknown>)['error'] as string | null | undefined) ?? 'unknown error'}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(`Daemon not reachable at ${url}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

export async function commandStop(options: Record<string, string>): Promise<void> {
  const url = options['url'] ?? `http://${DEFAULT_HOST}:${String(DEFAULT_PORT)}`;
  try {
    const { response, payload } = await requestJson('POST', `${url}/shutdown`, null, ORCH_TOKEN);
    if (!response.ok) {
      console.error(
        `Failed to stop daemon (${String(response.status)}): ${((payload as Record<string, unknown>)['error'] as string | null | undefined) ?? 'unknown error'}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('Stop signal sent to orchestrator daemon.');
  } catch (err) {
    console.error(`Unable to reach daemon at ${url}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
