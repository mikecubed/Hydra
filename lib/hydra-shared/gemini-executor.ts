/**
 * Gemini Direct API executor — OAuth token management and HTTP-based execution.
 *
 * Extracted from agent-executor.ts. Bypasses the broken Gemini CLI v0.27.x by
 * calling the Cloud Code Assist API directly with OAuth credentials.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getActiveModel } from '../hydra-agents.ts';
import { loadHydraConfig } from '../hydra-config.ts';
import { calculateBackoff } from '../hydra-model-recovery.ts';
import { recordCallStart, recordCallComplete, recordCallError } from '../hydra-metrics.ts';
import type { ExecuteResult, ProgressCallback, StatusBarCallback } from '../types.ts';

/** Options for Gemini direct API calls */
export interface GeminiDirectOpts {
  timeoutMs?: number;
  modelOverride?: string;
  phaseLabel?: string;
  onProgress?: ProgressCallback;
  onStatusBar?: StatusBarCallback;
  model?: string;
}

/** Gemini OAuth token response */
interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
}

/** Gemini generate content response */
interface GeminiContentResponse {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
}

/** Gemini load code assist response */
interface GeminiLoadResponse {
  cloudaicompanionProject?: string;
}

// ── Gemini Direct API Workaround (bypass broken CLI v0.27.x) ─────────────────

// OAuth credentials for Google Cloud Code Assist (installed-app OAuth flow).
// clientId identifies the application and is effectively public for installed apps.
// clientSecret MUST be supplied via GEMINI_OAUTH_CLIENT_SECRET environment variable —
// never hardcoded in source.  See .env.example for setup instructions.
const GEMINI_OAUTH = {
  clientId:
    process.env['GEMINI_OAUTH_CLIENT_ID'] ??
    '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: process.env['GEMINI_OAUTH_CLIENT_SECRET'] ?? '',
};
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal';

let _geminiToken: string | null = null;
let _geminiTokenExpiry = 0;
let _geminiProjectId: string | null = null;

/** Test seam: override the OAuth config without mutating process.env */
let _geminiOAuthOverride: { clientId: string; clientSecret: string } | null = null;

export function _setGeminiOAuthConfig(
  cfg: { clientId: string; clientSecret: string } | null,
): void {
  _geminiOAuthOverride = cfg;
}

/** Test seam: reset the module-level token cache for isolation between tests */
export function _resetGeminiTokenCache(): void {
  _geminiToken = null;
  _geminiTokenExpiry = 0;
  _geminiProjectId = null;
}

function getOAuthConfig(): { clientId: string; clientSecret: string } {
  return _geminiOAuthOverride ?? GEMINI_OAUTH;
}

export async function getGeminiToken(): Promise<string | null> {
  if (_geminiToken != null && Date.now() < _geminiTokenExpiry - 60_000) return _geminiToken;

  const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  if (!fs.existsSync(credsPath)) return null;

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as Record<string, unknown>;

  if (
    typeof creds['access_token'] === 'string' &&
    creds['access_token'] !== '' &&
    typeof creds['expiry_date'] === 'number' &&
    Date.now() < creds['expiry_date'] - 60_000
  ) {
    _geminiToken = creds['access_token'];
    _geminiTokenExpiry = creds['expiry_date'];
    return _geminiToken;
  }

  if (creds['refresh_token'] == null) return null;

  // Require the client secret from the environment — refuse to proceed without it.
  const oauthCfg = getOAuthConfig();
  if (oauthCfg.clientSecret === '') {
    throw new Error(
      'Gemini OAuth token refresh requires GEMINI_OAUTH_CLIENT_SECRET to be set. ' +
        'See .env.example for setup instructions.',
    );
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauthCfg.clientId,
      client_secret: oauthCfg.clientSecret,
      refresh_token: creds['refresh_token'] as string,
      grant_type: 'refresh_token',
    }),
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as OAuthTokenResponse;
  // eslint-disable-next-line require-atomic-updates -- singleton OAuth token cache; races produce identical values
  _geminiToken = data.access_token;
  // eslint-disable-next-line require-atomic-updates -- singleton OAuth token cache; races produce identical values
  _geminiTokenExpiry = Date.now() + data.expires_in * 1000;

  // Persist so Gemini CLI also benefits
  creds['access_token'] = data.access_token;
  creds['expiry_date'] = _geminiTokenExpiry;
  try {
    fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), 'utf8');
  } catch {
    /* best effort */
  }

  return _geminiToken;
}

export async function getGeminiProjectId(token: string): Promise<string | null> {
  if (_geminiProjectId != null) return _geminiProjectId;

  const resp = await fetch(`${CODE_ASSIST_ENDPOINT}:loadCodeAssist`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!resp.ok) return null;
  const data = (await resp.json()) as GeminiLoadResponse;
  // eslint-disable-next-line require-atomic-updates -- singleton OAuth token cache; races produce identical values
  _geminiProjectId = data.cloudaicompanionProject ?? null;
  return _geminiProjectId;
}

export async function executeGeminiDirect(
  prompt: string,
  opts: GeminiDirectOpts = {},
): Promise<ExecuteResult> {
  const { timeoutMs = 300_000, modelOverride, phaseLabel, onProgress, onStatusBar } = opts;

  const startTime = Date.now();
  const model = modelOverride ?? getActiveModel('gemini');
  const metricsHandle = recordCallStart('gemini', model ?? undefined);
  if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel ?? 'executing', step: 'running' });

  try {
    const token = await getGeminiToken();
    if (token == null) {
      const durationMs = Date.now() - startTime;
      const err = 'No Gemini OAuth credentials (~/.gemini/oauth_creds.json)';
      recordCallError(metricsHandle, err);
      if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel ?? 'error', step: 'idle' });
      return {
        ok: false,
        output: '',
        stderr: '',
        error: err,
        exitCode: null,
        signal: null,
        durationMs,
        timedOut: false,
      };
    }

    const projectId = await getGeminiProjectId(token);
    if (projectId == null) {
      const durationMs = Date.now() - startTime;
      const err = 'Could not resolve Gemini project ID';
      recordCallError(metricsHandle, err);
      if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel ?? 'error', step: 'idle' });
      return {
        ok: false,
        output: '',
        stderr: '',
        error: err,
        exitCode: null,
        signal: null,
        durationMs,
        timedOut: false,
      };
    }

    const cfg = loadHydraConfig();
    const rlCfg = (cfg.rateLimits ?? {}) as Record<string, number>;
    const maxRetries = rlCfg['maxRetries'] ?? 3;
    const baseDelayMs = rlCfg['baseDelayMs'] ?? 5000;
    const maxDelayMs = rlCfg['maxDelayMs'] ?? 60_000;

    let lastError: string | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // sequential: each iteration depends on previous response (retry loop)
      // eslint-disable-next-line no-await-in-loop
      const resp = await fetch(`${CODE_ASSIST_ENDPOINT}:generateContent`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          project: projectId,
          user_prompt_id: crypto.randomUUID(),
          request: {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (resp.ok) {
        // eslint-disable-next-line no-await-in-loop
        const data = (await resp.json()) as GeminiContentResponse;
        const text =
          data.response?.candidates?.[0]?.content?.parts
            ?.map((p: { text?: string }) => p.text)
            .join('') ?? '';
        const durationMs = Date.now() - startTime;
        recordCallComplete(metricsHandle, { output: text, stderr: '' });
        if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel ?? 'done', step: 'idle' });
        return {
          ok: true,
          output: text,
          stderr: '',
          error: null,
          exitCode: null,
          signal: null,
          durationMs,
          timedOut: false,
        };
      }

      // eslint-disable-next-line no-await-in-loop
      const errText = await resp.text().catch(() => '');

      if (resp.status === 429 || /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/i.test(errText)) {
        if (attempt < maxRetries) {
          const serverRetryAfter = resp.headers.get('retry-after');
          const retryAfterMs =
            serverRetryAfter == null ? null : Number.parseInt(serverRetryAfter, 10) * 1000;
          const delay = calculateBackoff(attempt, {
            baseDelayMs,
            maxDelayMs,
            retryAfterMs: retryAfterMs ?? undefined,
          });
          if (onProgress)
            onProgress(
              Date.now() - startTime,
              0,
              `Rate limited, retrying in ${(delay / 1000).toFixed(0)}s`,
            );
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((r) => {
            setTimeout(r, delay);
          });
          continue;
        }
        lastError = `Gemini API 429 (exhausted ${String(maxRetries)} retries)`;
      } else {
        const durationMs = Date.now() - startTime;
        recordCallError(metricsHandle, `Gemini API ${String(resp.status)}`);
        if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel ?? 'error', step: 'idle' });
        return {
          ok: false,
          output: '',
          stderr: errText,
          error: `Gemini API ${String(resp.status)}`,
          exitCode: null,
          signal: null,
          durationMs,
          timedOut: false,
        };
      }
    }

    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, lastError ?? 'Gemini API 429');
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel ?? 'error', step: 'idle' });
    return {
      ok: false,
      output: '',
      stderr: '',
      error: lastError ?? 'Gemini API 429',
      exitCode: null,
      signal: null,
      durationMs,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, e.message);
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel ?? 'error', step: 'idle' });
    return {
      ok: false,
      output: '',
      stderr: '',
      error: e.name === 'TimeoutError' ? 'Gemini API timeout' : e.message,
      exitCode: null,
      signal: null,
      durationMs,
      timedOut: e.name === 'TimeoutError',
    };
  }
}
