/**
 * Hydra Provider Usage — Per-provider token tracking (local + external APIs).
 *
 * Two-layer tracking:
 * - Local: tokens recorded from our streaming calls (hydra-openai, hydra-anthropic, hydra-google)
 * - External: provider billing APIs when admin keys are available (OpenAI, Anthropic)
 *
 * Single source of truth for COST_PER_1K pricing table (previously in hydra-concierge.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHydraConfig } from './hydra-config.ts';
import { getCostTable as _getCostTable } from './hydra-model-profiles.ts';
import { loadRpdState, getRpdState } from './hydra-rate-limits.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HYDRA_ROOT = path.resolve(__dirname, '..');

const USAGE_PATH = path.join(HYDRA_ROOT, 'docs', 'coordination', 'provider-usage.json');
const RETENTION_DAYS = 7;

// ── Interfaces ───────────────────────────────────────────────────────────────

interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
}

interface ExternalUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface ProviderUsageEntry {
  session: UsageCounters;
  today: UsageCounters;
  external: ExternalUsage | null;
}

// ── Cost per 1K tokens (input/output) for known models ──────────────────────
// Derived from hydra-model-profiles.mjs — single source of truth for pricing.

export const COST_PER_1K = _getCostTable();

/**
 * Estimate cost for a model given usage tokens.
 */
export function estimateCost(
  model: string,
  usage: {
    prompt_tokens?: number;
    inputTokens?: number;
    completion_tokens?: number;
    outputTokens?: number;
  } | null,
): number {
  if (!usage) return 0;
  const rates = (COST_PER_1K as Record<string, { input: number; output: number } | undefined>)[
    model
  ];
  if (!rates) return 0;
  const inputCost = ((usage.prompt_tokens ?? usage.inputTokens ?? 0) / 1000) * rates.input;
  const outputCost = ((usage.completion_tokens ?? usage.outputTokens ?? 0) / 1000) * rates.output;
  return inputCost + outputCost;
}

// ── In-Memory State ─────────────────────────────────────────────────────────

function emptyCounters(): UsageCounters {
  return { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
}

const _usage: Record<string, ProviderUsageEntry> = {
  openai: { session: emptyCounters(), today: emptyCounters(), external: null },
  anthropic: { session: emptyCounters(), today: emptyCounters(), external: null },
  google: { session: emptyCounters(), today: emptyCounters(), external: null },
};

const _externalCache = { ts: 0, ttlMs: 10 * 60 * 1000 };

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Record usage from a streaming API call.
 */
export function recordProviderUsage(
  provider: string,
  data: { inputTokens?: number; outputTokens?: number; cost?: number; model?: string },
): void {
  const entry = (_usage as Record<string, ProviderUsageEntry | undefined>)[provider];
  if (!entry) return;

  const input = data.inputTokens ?? 0;
  const output = data.outputTokens ?? 0;
  const cost =
    data.cost ??
    (data.model
      ? estimateCost(data.model, {
          prompt_tokens: input,
          completion_tokens: output,
        })
      : 0);

  entry.session.inputTokens += input;
  entry.session.outputTokens += output;
  entry.session.cost += cost;
  entry.session.calls++;

  entry.today.inputTokens += input;
  entry.today.outputTokens += output;
  entry.today.cost += cost;
  entry.today.calls++;
}

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Get full usage snapshot for all providers.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- complex return type
export function getProviderUsage() {
  return {
    openai: {
      session: { ..._usage['openai'].session },
      today: { ..._usage['openai'].today },
      external: _usage['openai'].external,
    },
    anthropic: {
      session: { ..._usage['anthropic'].session },
      today: { ..._usage['anthropic'].today },
      external: _usage['anthropic'].external,
    },
    google: {
      session: { ..._usage['google'].session },
      today: { ..._usage['google'].today },
      external: _usage['google'].external,
    },
  };
}

/**
 * Get a formatted one-liner per provider for display.
 */
export function getProviderSummary(): string[] {
  const lines: string[] = [];
  for (const [name, data] of Object.entries(_usage)) {
    const s = data.session;
    if (s.calls === 0) continue;
    const totalTokens = s.inputTokens + s.outputTokens;
    let tokenStr: string;
    if (totalTokens >= 1_000_000) {
      tokenStr = `${(totalTokens / 1_000_000).toFixed(1)}M`;
    } else if (totalTokens >= 1_000) {
      tokenStr = `${(totalTokens / 1_000).toFixed(0)}K`;
    } else {
      tokenStr = String(totalTokens);
    }
    const costStr = s.cost > 0 ? `$${s.cost.toFixed(2)}` : '~';
    lines.push(`${name}: ${tokenStr} (${costStr})`);
  }
  return lines;
}

/**
 * Get external account usage summary lines.
 */
export function getExternalSummary(): string[] {
  const lines: string[] = [];
  for (const [name, data] of Object.entries(_usage)) {
    if (!data.external) continue;
    const e = data.external;
    const totalTokens = (e.inputTokens || 0) + (e.outputTokens || 0);
    let tokenStr: string;
    if (totalTokens >= 1_000_000) {
      tokenStr = `${(totalTokens / 1_000_000).toFixed(1)}M`;
    } else if (totalTokens >= 1_000) {
      tokenStr = `${(totalTokens / 1_000).toFixed(0)}K`;
    } else {
      tokenStr = String(totalTokens);
    }
    const costStr = e.cost > 0 ? `$${e.cost.toFixed(2)} today` : '~';
    lines.push(`${name}: ${tokenStr} (${costStr})`);
  }
  return lines;
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Reset session counters (call at startup).
 */
export function resetSessionUsage(): void {
  for (const entry of Object.values(_usage)) {
    entry.session = emptyCounters();
  }
}

// ── Persistence (daily rollup) ──────────────────────────────────────────────

function todayKey(): string {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Load persisted daily counters from JSON.
 */
export function loadProviderUsage(): void {
  try {
    if (!fs.existsSync(USAGE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    const key = todayKey();
    const today = raw[key];
    if (!today) return;

    for (const provider of ['openai', 'anthropic', 'google']) {
      if (today[provider]) {
        _usage[provider].today = { ...emptyCounters(), ...today[provider] };
      }
    }

    loadRpdState(raw);
  } catch {
    // Best effort
  }
}

/**
 * Persist daily counters to JSON. Keeps last RETENTION_DAYS days.
 */
export function saveProviderUsage(): void {
  try {
    const dir = path.dirname(USAGE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(USAGE_PATH)) {
        existing = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
      }
    } catch {
      /* start fresh */
    }

    const key = todayKey();
    existing[key] = {
      openai: { ..._usage['openai'].today },
      anthropic: { ..._usage['anthropic'].today },
      google: { ..._usage['google'].today },
    };

    existing['rpd'] = getRpdState();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffKey = `${String(cutoff.getFullYear())}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    const prunedExisting = Object.fromEntries(
      Object.entries(existing).filter(([k]) => k >= cutoffKey),
    );

    fs.writeFileSync(USAGE_PATH, `${JSON.stringify(prunedExisting, null, 2)}\n`, 'utf8');
  } catch {
    // Best effort
  }
}

// ── External API Integration ────────────────────────────────────────────────

function getAdminKeys() {
  const cfg = loadHydraConfig() as any;
  const providers = (cfg.providers as { openai?: { adminKey?: string }; anthropic?: { adminKey?: string } } | undefined) ?? {};
  return {
    openai: process.env['OPENAI_ADMIN_KEY'] ?? providers.openai?.adminKey ?? null,
    anthropic: process.env['ANTHROPIC_ADMIN_KEY'] ?? providers.anthropic?.adminKey ?? null,
  };
}

/**
 * Query external billing APIs for account-wide usage (cached, non-blocking).
 */
export async function refreshExternalUsage(): Promise<void> {
  const now = Date.now();
  if (now - _externalCache.ts < _externalCache.ttlMs) return;
  _externalCache.ts = now;

  const keys = getAdminKeys();
  const tasks: Promise<void>[] = [];

  if (keys.openai) tasks.push(fetchOpenAIUsage(keys.openai));
  if (keys.anthropic) tasks.push(fetchAnthropicUsage(keys.anthropic));

  if (tasks.length === 0) return;

  try {
    await Promise.allSettled(tasks);
  } catch {
    // Never block on external API failures
  }
}

async function fetchOpenAIUsage(adminKey: string): Promise<void> {
  try {
    const today = todayKey();
    const url = `https://api.openai.com/v1/organization/usage/completions?start_date=${today}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${adminKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as any;
    let inputTokens = 0,
      outputTokens = 0;
    for (const bucket of (data.data as unknown[] | undefined) ?? []) {
      for (const result of (bucket as { results?: unknown[] }).results ?? []) {
        inputTokens += (result as { input_tokens?: number }).input_tokens ?? 0;
        outputTokens += (result as { output_tokens?: number }).output_tokens ?? 0;
      }
    }
    const cost = estimateCostGeneric('openai', inputTokens, outputTokens);
    _usage['openai'].external = { inputTokens, outputTokens, cost };
  } catch {
    // Silently skip
  }
}

async function fetchAnthropicUsage(adminKey: string): Promise<void> {
  try {
    const today = todayKey();
    const url = `https://api.anthropic.com/v1/organizations/usage_report/messages?start_date=${today}`;
    const res = await fetch(url, {
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as any;
    let inputTokens = 0,
      outputTokens = 0;
    for (const entry of (data.data as unknown[] | undefined) ?? []) {
      inputTokens += (entry as { input_tokens?: number }).input_tokens ?? 0;
      outputTokens += (entry as { output_tokens?: number }).output_tokens ?? 0;
    }
    const cost = estimateCostGeneric('anthropic', inputTokens, outputTokens);
    _usage['anthropic'].external = { inputTokens, outputTokens, cost };
  } catch {
    // Silently skip
  }
}

export function estimateCostGeneric(
  provider: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const avgRates: Record<string, { input: number; output: number } | undefined> = {
    openai: { input: 0.002, output: 0.008 },
    anthropic: { input: 0.005, output: 0.025 },
  };
  const rates = avgRates[provider];
  if (!rates) return 0;
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}
