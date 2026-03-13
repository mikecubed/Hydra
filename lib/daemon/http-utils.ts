/**
 * Shared HTTP utility helpers for the orchestrator daemon.
 *
 * All five helpers are pure-ish: `isAuthorized` and `requestJson` accept
 * the auth token as an explicit parameter so they remain unit-testable
 * without touching process.env.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  details: unknown = null,
): void {
  sendJson(res, statusCode, {
    ok: false,
    error: message,
    details,
  });
}

export function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (token === '') {
    return true;
  }
  return req.headers['x-ai-orch-token'] === token;
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  const maxSize = 1024 * 1024;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxSize) {
      throw new Error('Payload too large.');
    }
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function requestJson(
  method: string,
  url: string,
  body: unknown = null,
  orchToken = '',
): Promise<{ response: globalThis.Response; payload: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (orchToken !== '') {
    headers['x-ai-orch-token'] = orchToken;
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  return { response, payload };
}
