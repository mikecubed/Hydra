/**
 * Hydra Model Profiles — Single source of truth for model data.
 *
 * Encodes MODEL_PROFILES.md benchmark, pricing, speed, and recommendation data
 * as a JS data module. Drives all model-related defaults, recommendations,
 * pricing, and UI annotations across the system.
 *
 * IMPORTANT: Zero Hydra imports — this module sits at the very bottom of the
 * import tree. hydra-config.ts imports it, and hydra-config is imported by
 * nearly everything else.
 */

import type { ModelProfile } from './types.ts';

// ── MODEL_PROFILES ──────────────────────────────────────────────────────────
// Keyed by exact model ID. Each entry contains benchmark, pricing, speed,
// and capability data sourced from docs/MODEL_PROFILES.md.

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Opus 4.6',
    shortName: 'opus',
    tier: 'flagship',
    contextWindow: 200_000,
    maxOutput: 128_000,
    pricePer1M: { input: 5.0, output: 25.0 },
    costPer1K: { input: 0.005, output: 0.025 },
    tokPerSec: 66,
    ttft: 1.52,
    reasoning: {
      type: 'thinking',
      levels: ['off', 'light', 'standard', 'deep'],
      budgets: { light: 4096, standard: 16384, deep: 65536 },
      default: 'off',
    },
    benchmarks: {
      sweBench: 80.8,
      terminalBench: 65.4,
      gpqaDiamond: 91.3,
      arcAgi2: 68.8,
      aime2025: 100,
      humanEval: 97.6,
      liveCodeBench: 76,
      aiderPolyglot: 89.4,
    },
    qualityScore: 95,
    valueScore: 40,
    speedScore: 25,
    strengths: ['abstract-reasoning', 'agentic', 'code-quality', 'long-context'],
    bestFor: ['planning', 'architecture', 'review', 'security'],
    // Opus 4.x shared limit (across Opus 4.6, 4.5, 4.1, 4)
    rateLimits: {
      1: { rpm: 50, itpm: 30_000, otpm: 8_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 800_000, otpm: 160_000 },
      4: { rpm: 4_000, itpm: 2_000_000, otpm: 400_000 },
    },
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Sonnet 4.6',
    shortName: 'sonnet',
    tier: 'mid',
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricePer1M: { input: 3.0, output: 15.0 },
    costPer1K: { input: 0.003, output: 0.015 },
    tokPerSec: 82,
    ttft: 1.5,
    reasoning: {
      type: 'thinking',
      levels: ['off', 'light', 'standard', 'deep'],
      budgets: { light: 4096, standard: 16384, deep: 65536 },
      default: 'off',
    },
    benchmarks: { sweBench: 79.2, gpqaDiamond: 87.4, liveCodeBench: 72 },
    qualityScore: 85,
    valueScore: 62,
    speedScore: 30,
    strengths: ['price-performance', 'coding', 'balanced', 'agentic'],
    bestFor: ['implementation', 'review', 'documentation'],
    // Sonnet 4.x shared limit
    rateLimits: {
      1: { rpm: 50, itpm: 30_000, otpm: 8_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 800_000, otpm: 160_000 },
      4: { rpm: 4_000, itpm: 2_000_000, otpm: 400_000 },
    },
  },
  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Sonnet 4.5',
    shortName: 'sonnet-4.5',
    tier: 'mid',
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricePer1M: { input: 3.0, output: 15.0 },
    costPer1K: { input: 0.003, output: 0.015 },
    tokPerSec: 67,
    ttft: 1.8,
    reasoning: {
      type: 'thinking',
      levels: ['off', 'light', 'standard', 'deep'],
      budgets: { light: 4096, standard: 16384, deep: 65536 },
      default: 'off',
    },
    benchmarks: {
      sweBench: 77.2,
      gpqaDiamond: 83.4,
      terminalBench: 50.5,
      liveCodeBench: 68,
      aiderPolyglot: 78.8,
    },
    qualityScore: 80,
    valueScore: 60,
    speedScore: 25,
    strengths: ['price-performance', 'coding', 'balanced'],
    bestFor: ['implementation', 'documentation', 'review'],
    // Sonnet 4.x shared limit (across Sonnet 4.5 and 4)
    rateLimits: {
      1: { rpm: 50, itpm: 30_000, otpm: 8_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 800_000, otpm: 160_000 },
      4: { rpm: 4_000, itpm: 2_000_000, otpm: 400_000 },
    },
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    agent: 'claude',
    displayName: 'Claude Haiku 4.5',
    shortName: 'haiku',
    tier: 'economy',
    contextWindow: 200_000,
    maxOutput: 64_000,
    pricePer1M: { input: 1.0, output: 5.0 },
    costPer1K: { input: 0.001, output: 0.005 },
    tokPerSec: 150,
    ttft: 0.5,
    reasoning: { type: 'none' },
    benchmarks: { sweBench: 73.3, terminalBench: 41.0 },
    qualityScore: 65,
    valueScore: 85,
    speedScore: 65,
    strengths: ['speed', 'cost', 'volume'],
    bestFor: ['implementation', 'testing'],
    rateLimits: {
      1: { rpm: 50, itpm: 50_000, otpm: 10_000 },
      2: { rpm: 1_000, itpm: 450_000, otpm: 90_000 },
      3: { rpm: 2_000, itpm: 1_000_000, otpm: 200_000 },
      4: { rpm: 4_000, itpm: 4_000_000, otpm: 800_000 },
    },
  },

  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.2 Codex',
    shortName: 'gpt-5.2c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.0 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 339,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 88,
    valueScore: 65,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation', 'sandboxed'],
    bestFor: ['implementation', 'refactor', 'testing'],
    // Uses GPT-5.2 limits (same API family)
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.2',
    shortName: 'gpt-5.2',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.0 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 50,
    ttft: null,
    reasoning: {
      type: 'effort',
      levels: ['none', 'low', 'medium', 'high', 'xhigh'],
      default: 'medium',
    },
    benchmarks: { sweBench: 80.0, gpqaDiamond: 93.2, aime2025: 100, arcAgi2: 54.2 },
    qualityScore: 90,
    valueScore: 55,
    speedScore: 20,
    strengths: ['deep-reasoning', 'science', 'math', 'long-context'],
    bestFor: ['analysis', 'research', 'security'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'gpt-5': {
    id: 'gpt-5',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5',
    shortName: 'gpt-5',
    tier: 'mid',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.25, output: 10.0 },
    costPer1K: { input: 0.00125, output: 0.01 },
    tokPerSec: 50,
    ttft: 0.2,
    reasoning: { type: 'effort', levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
    benchmarks: { sweBench: 74.9, gpqaDiamond: 88.4, aime2025: 94.6, aiderPolyglot: 88 },
    qualityScore: 75,
    valueScore: 70,
    speedScore: 20,
    strengths: ['streaming', 'broad-knowledge', 'unified-reasoning'],
    bestFor: ['implementation', 'documentation'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'o4-mini': {
    id: 'o4-mini',
    provider: 'openai',
    agent: 'codex',
    displayName: 'o4-mini',
    shortName: 'o4-mini',
    tier: 'economy',
    contextWindow: 200_000,
    maxOutput: 100_000,
    pricePer1M: { input: 1.1, output: 4.4 },
    costPer1K: { input: 0.0011, output: 0.0044 },
    tokPerSec: null,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' },
    benchmarks: { sweBench: 68.1, aime2025: 99.5, gpqaDiamond: 81.4 },
    qualityScore: 60,
    valueScore: 80,
    speedScore: 50,
    strengths: ['math', 'budget-reasoning', 'throughput'],
    bestFor: ['implementation', 'testing'],
    rateLimits: {
      1: { rpm: 1_000, tpm: 100_000 },
      2: { rpm: 2_000, tpm: 200_000 },
      3: { rpm: 5_000, tpm: 4_000_000 },
      4: { rpm: 10_000, tpm: 10_000_000 },
      5: { rpm: 30_000, tpm: 150_000_000 },
    },
  },
  'gpt-4.1-mini': {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-4.1 Mini',
    shortName: 'gpt-4.1m',
    tier: 'economy',
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    pricePer1M: { input: 0.4, output: 1.6 },
    costPer1K: { input: 0.0004, output: 0.0016 },
    tokPerSec: null,
    ttft: null,
    reasoning: { type: 'none' },
    benchmarks: {},
    qualityScore: 45,
    valueScore: 90,
    speedScore: 60,
    strengths: ['cost', 'long-context', 'speed'],
    bestFor: ['documentation'],
    rateLimits: {
      1: { rpm: 500, tpm: 200_000, rpd: 10_000 },
      2: { rpm: 5_000, tpm: 2_000_000 },
      3: { rpm: 5_000, tpm: 4_000_000 },
      4: { rpm: 10_000, tpm: 10_000_000 },
      5: { rpm: 30_000, tpm: 150_000_000 },
    },
  },

  'gemini-3-pro-preview': {
    id: 'gemini-3-pro-preview',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 3 Pro',
    shortName: 'pro',
    tier: 'flagship',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 2.0, output: 12.0 },
    costPer1K: { input: 0.002, output: 0.012 },
    tokPerSec: 130,
    ttft: null,
    reasoning: {
      type: 'model-swap',
      variants: { standard: 'gemini-3-pro-preview', deep: 'gemini-3-pro-deep-think' },
      default: 'standard',
    },
    benchmarks: {
      sweBench: 76.2,
      gpqaDiamond: 91.9,
      aime2025: 95,
      liveCodeBench: 91.7,
      aiderPolyglot: 82.2,
      terminalBench: 54.2,
    },
    qualityScore: 85,
    valueScore: 60,
    speedScore: 55,
    strengths: ['algorithmic-coding', 'analysis', 'long-context', 'multimodal'],
    bestFor: ['analysis', 'review', 'research'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 100 },
      1: { rpm: 150, tpm: 1_000_000, rpd: 1_000 },
      2: { rpm: 1_000, tpm: 2_000_000, rpd: 10_000 },
    },
  },
  'gemini-3-flash-preview': {
    id: 'gemini-3-flash-preview',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 3 Flash',
    shortName: 'flash',
    tier: 'economy',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 0.5, output: 3.0 },
    costPer1K: { input: 0.0005, output: 0.003 },
    tokPerSec: 218,
    ttft: null,
    reasoning: { type: 'none' },
    benchmarks: { sweBench: 78.0, gpqaDiamond: 90.4, aiderPolyglot: 95.2 },
    qualityScore: 72,
    valueScore: 95,
    speedScore: 85,
    strengths: ['value', 'speed', 'code-editing', 'long-context'],
    bestFor: ['implementation', 'review', 'testing'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 250 },
      1: { rpm: 300, tpm: 2_000_000, rpd: 1_500 },
      2: { rpm: 2_000, tpm: 4_000_000, rpd: 10_000 },
    },
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 2.5 Pro',
    shortName: '2.5-pro',
    tier: 'mid',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 1.25, output: 10.0 },
    costPer1K: { input: 0.00125, output: 0.01 },
    tokPerSec: 150,
    ttft: null,
    reasoning: { type: 'none' },
    benchmarks: { sweBench: 63.8, gpqaDiamond: 84.0 },
    qualityScore: 65,
    valueScore: 65,
    speedScore: 65,
    strengths: ['stability', 'long-context'],
    bestFor: ['analysis', 'review'],
    rateLimits: {
      free: { rpm: 5, tpm: 250_000, rpd: 100 },
      1: { rpm: 150, tpm: 1_000_000, rpd: 1_000 },
      2: { rpm: 1_000, tpm: 2_000_000, rpd: 10_000 },
    },
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 2.5 Flash',
    shortName: '2.5-flash',
    tier: 'economy',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 0.3, output: 2.5 },
    costPer1K: { input: 0.0003, output: 0.0025 },
    tokPerSec: 237,
    ttft: 0.3,
    reasoning: { type: 'none' },
    benchmarks: {},
    qualityScore: 50,
    valueScore: 90,
    speedScore: 90,
    strengths: ['speed', 'cost', 'stability'],
    bestFor: ['implementation'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 250 },
      1: { rpm: 300, tpm: 2_000_000, rpd: 1_500 },
      2: { rpm: 2_000, tpm: 4_000_000, rpd: 10_000 },
    },
  },

  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.3 Codex',
    shortName: 'gpt-5.3c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.0 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 424,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 92,
    valueScore: 68,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation', 'sandboxed', 'code-generation'],
    bestFor: ['implementation', 'refactor', 'testing'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'gpt-5.4': {
    id: 'gpt-5.4',
    provider: 'openai',
    agent: 'codex',
    displayName: 'GPT-5.4',
    shortName: 'gpt-5.4',
    tier: 'flagship',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    pricePer1M: { input: 2.5, output: 15.0 },
    costPer1K: { input: 0.0025, output: 0.015 },
    tokPerSec: 78,
    ttft: null,
    reasoning: {
      type: 'effort',
      levels: ['none', 'low', 'medium', 'high', 'xhigh'],
      default: 'none',
    },
    benchmarks: { sweBenchPro: 57.7, gpqaDiamond: 84.2, aime2025: 100 },
    qualityScore: 93,
    valueScore: 62,
    speedScore: 45,
    strengths: ['reasoning', 'long-context', 'implementation', 'computer-use', 'code-generation'],
    bestFor: ['implementation', 'refactor', 'analysis'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },

  'gemini-3.1-pro-preview': {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    agent: 'gemini',
    displayName: 'Gemini 3.1 Pro',
    shortName: '3.1-pro',
    tier: 'flagship',
    contextWindow: 1_000_000,
    maxOutput: 65_000,
    pricePer1M: { input: 2.0, output: 12.0 },
    costPer1K: { input: 0.002, output: 0.012 },
    tokPerSec: 140,
    ttft: null,
    reasoning: {
      type: 'model-swap',
      variants: { standard: 'gemini-3.1-pro-preview', deep: 'gemini-3.1-pro-deep-think' },
      default: 'standard',
    },
    benchmarks: {
      sweBench: 76.2,
      gpqaDiamond: 91.9,
      aime2025: 95,
      liveCodeBench: 91.7,
      aiderPolyglot: 82.2,
      terminalBench: 54.2,
    },
    qualityScore: 88,
    valueScore: 62,
    speedScore: 58,
    strengths: ['reasoning', 'algorithmic-coding', 'analysis', 'long-context', 'multimodal'],
    bestFor: ['analysis', 'review', 'research'],
    rateLimits: {
      free: { rpm: 10, tpm: 250_000, rpd: 100 },
      1: { rpm: 150, tpm: 1_000_000, rpd: 1_000 },
      2: { rpm: 1_000, tpm: 2_000_000, rpd: 10_000 },
    },
  },

  // Additional aliases that map to the same cost structure
  'codex-5.3': {
    id: 'codex-5.3',
    provider: 'openai',
    agent: 'codex',
    displayName: 'Codex 5.3 (alias)',
    shortName: 'gpt-5.3c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.0 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 424,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 92,
    valueScore: 68,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation'],
    bestFor: ['implementation', 'refactor', 'testing'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
  'codex-5.2': {
    id: 'codex-5.2',
    provider: 'openai',
    agent: 'codex',
    displayName: 'Codex 5.2 (alias)',
    shortName: 'gpt-5.2c',
    tier: 'flagship',
    contextWindow: 400_000,
    maxOutput: 128_000,
    pricePer1M: { input: 1.75, output: 14.0 },
    costPer1K: { input: 0.00175, output: 0.014 },
    tokPerSec: 339,
    ttft: null,
    reasoning: { type: 'effort', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
    benchmarks: { terminalBench: 77.3, sweBenchPro: 56.8 },
    qualityScore: 88,
    valueScore: 65,
    speedScore: 100,
    strengths: ['speed', 'terminal-ops', 'implementation'],
    bestFor: ['implementation', 'refactor', 'testing'],
    rateLimits: {
      1: { rpm: 500, tpm: 500_000 },
      2: { rpm: 5_000, tpm: 1_000_000 },
      3: { rpm: 5_000, tpm: 2_000_000 },
      4: { rpm: 10_000, tpm: 4_000_000 },
      5: { rpm: 15_000, tpm: 40_000_000 },
    },
  },
};

// ── ROLE_DEFAULTS ───────────────────────────────────────────────────────────
// Per-role recommended assignments with benchmark-backed rationale.

export const ROLE_DEFAULTS = {
  architect: {
    agent: 'claude',
    model: null, // uses agent default (claude-sonnet-4-6)
    reasoningEffort: null,
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-5.4'],
    note: 'Strong coding + agentic at 40% lower cost than Opus; Opus available for highest-complexity tasks',
  },
  analyst: {
    agent: 'gemini',
    model: null, // uses agent default (gemini-3.1-pro-preview)
    reasoningEffort: null,
    models: ['gemini-3.1-pro-preview', 'claude-opus-4-6'],
    note: 'Latest SOTA reasoning model, GPQA 91.9%, 1M native context',
  },
  implementer: {
    agent: 'codex',
    model: null, // uses agent default (gpt-5.4)
    reasoningEffort: null,
    models: ['gpt-5.4', 'gpt-5.3-codex', 'claude-sonnet-4-5-20250929'],
    note: 'SWE-Bench Pro 57.7%, 1.05M context, reasoning effort control (none→xhigh)',
  },
  concierge: {
    agent: 'codex',
    model: 'gpt-5',
    reasoningEffort: null,
    models: ['gpt-5', 'claude-sonnet-4-5-20250929'],
    note: 'Fast streaming, broad knowledge, $1.25/$10 (GPT-5 has no reasoning control)',
  },
  investigator: {
    agent: 'codex',
    model: 'gpt-5.2',
    reasoningEffort: null,
    models: ['gpt-5.2', 'gpt-5'],
    note: 'Best deep reasoning (GPQA 93.2%, FrontierMath 40.3%)',
  },
  nightlyHandoff: {
    agent: 'codex',
    model: 'o4-mini',
    reasoningEffort: 'low',
    models: ['o4-mini', 'gpt-5'],
    note: 'Budget-friendly, SWE-bench 68.1%, o4-mini supports low/medium/high effort',
  },
};

// ── AGENT_PRESETS ───────────────────────────────────────────────────────────
// Per-agent default/fast/cheap model mappings.

export const AGENT_PRESETS = {
  claude: {
    default: 'claude-sonnet-4-6',
    fast: 'claude-sonnet-4-5-20250929',
    cheap: 'claude-haiku-4-5-20251001',
  },
  codex: { default: 'gpt-5.4', fast: 'o4-mini', cheap: 'o4-mini' },
  gemini: {
    default: 'gemini-3.1-pro-preview',
    fast: 'gemini-3-flash-preview',
    cheap: 'gemini-3-flash-preview',
  },
};

// ── Query Functions ─────────────────────────────────────────────────────────

/**
 * Get a single model profile by exact ID.
 */
export function getProfile(modelId: string): ModelProfile | null {
  if (modelId === '') return null;
  return MODEL_PROFILES[modelId] ?? null;
}

/**
 * Get all profiles for a specific agent.
 */
export function getProfilesForAgent(agent: string): ModelProfile[] {
  if (agent === '') return [];
  return Object.values(MODEL_PROFILES).filter((p) => p.agent === agent);
}

/**
 * Get agent presets (default/fast/cheap model IDs).
 */
export function getAgentPresets(
  agent: string,
): { default: string; fast: string; cheap: string } | null {
  return (
    (AGENT_PRESETS as Record<string, { default: string; fast: string; cheap: string }>)[agent] ??
    null
  );
}

/**
 * Get role recommendation data.
 */
export function getRoleRecommendation(role: string): {
  agent: string;
  model: string | null;
  reasoningEffort: string | null;
  models: string[];
  note: string;
} | null {
  return (
    (
      ROLE_DEFAULTS as Record<
        string,
        {
          agent: string;
          model: string | null;
          reasoningEffort: string | null;
          models: string[];
          note: string;
        }
      >
    )[role] ?? null
  );
}

/**
 * Get fallback candidates for an agent, sorted by qualityScore descending.
 * Excludes the specified model ID.
 */
export function getFallbackOrder(
  agent: string,
  excludeId: string,
): Array<{ id: string; qualityScore: number; displayName: string }> {
  const profiles = getProfilesForAgent(agent);
  const exclude = excludeId.toLowerCase();
  return profiles
    .filter((p) => p.id.toLowerCase() !== exclude)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .map((p) => ({ id: p.id, qualityScore: p.qualityScore, displayName: p.displayName }));
}

/**
 * Format a compact benchmark annotation for display.
 * e.g. "SWE 80.8% | 66 tok/s | $5/$25"
 */
export function formatBenchmarkAnnotation(
  modelId: string,
  opts: { includePrice?: boolean; includeSpeed?: boolean; includeSwe?: boolean } = {},
): string {
  const profile = getProfile(modelId);
  if (!profile) return '';

  const parts: string[] = [];
  const { includePrice = true, includeSpeed = true, includeSwe = true } = opts;

  if (includeSwe && profile.benchmarks?.['sweBench'] != null) {
    parts.push(`SWE ${String(profile.benchmarks['sweBench'])}%`);
  }

  if (includeSpeed && profile.tokPerSec != null) {
    parts.push(`${String(profile.tokPerSec)} tok/s`);
  }

  if (includePrice && profile.pricePer1M) {
    const inp = profile.pricePer1M.input;
    const out = profile.pricePer1M.output;
    const fmt = (v: number) => (v >= 1 ? `$${String(v)}` : `$${v.toFixed(2)}`);
    parts.push(`${fmt(inp)}/${fmt(out)}`);
  }

  return parts.join(' | ');
}

/**
 * Get all role defaults as an object.
 * Returns { roles, recommendations } suitable for DEFAULT_CONFIG.
 */
export function getDefaultRoles(): {
  roles: Record<string, { agent: string; model: string | null; reasoningEffort: string | null }>;
  recommendations: Record<
    string,
    { models: string[]; reasoningEffort: string | null; note: string }
  >;
} {
  const roles: Record<
    string,
    { agent: string; model: string | null; reasoningEffort: string | null }
  > = {};
  const recommendations: Record<
    string,
    { models: string[]; reasoningEffort: string | null; note: string }
  > = {};

  for (const [role, rd] of Object.entries(ROLE_DEFAULTS)) {
    roles[role] = {
      agent: rd.agent,
      model: rd.model,
      reasoningEffort: rd.reasoningEffort,
    };
    recommendations[role] = {
      models: rd.models,
      reasoningEffort: rd.reasoningEffort,
      note: rd.note,
    };
  }

  return { roles, recommendations };
}

/**
 * Get cost table in COST_PER_1K format (model ID → { input, output }).
 * Compatible with hydra-provider-usage.mjs.
 */
export function getCostTable(): Record<string, { input: number; output: number }> {
  const table: Record<string, { input: number; output: number }> = {};
  for (const profile of Object.values(MODEL_PROFILES)) {
    if (profile.costPer1K) table[profile.id] = { ...profile.costPer1K };
  }
  return table;
}

/**
 * Get reasoning capabilities map in MODEL_REASONING_CAPS format.
 * Uses longest-prefix matching keys, same shape as hydra-agents.ts.
 */
export function getReasoningCapsMap(): Record<
  string,
  {
    type: string;
    levels?: string[];
    budgets?: Record<string, number>;
    variants?: Record<string, unknown>;
    default?: string;
  }
> {
  // Build prefix-based map from profiles, same key style as the old hardcoded map.
  // Deduplicate by prefix — use the primary model for each prefix.
  type ReasoningEntry = {
    type: string;
    levels?: string[];
    budgets?: Record<string, number>;
    variants?: Record<string, unknown>;
    default?: string;
  };
  const map: Record<string, ReasoningEntry> = {};

  // OpenAI o-series
  map['o1'] = { type: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' };
  map['o3'] = { type: 'effort', levels: ['low', 'medium', 'high'], default: 'medium' };

  // Derive from profiles
  const o4 = MODEL_PROFILES['o4-mini'];
  if (o4.reasoning)
    map['o4-mini'] = {
      type: o4.reasoning.type,
      levels: o4.reasoning.levels,
      default: o4.reasoning.default,
    };

  map['gpt-5'] = { type: 'none' };

  const opus = MODEL_PROFILES['claude-opus-4-6'];
  if (opus.reasoning) map['claude-opus'] = { ...opus.reasoning };

  const sonnet46 = MODEL_PROFILES['claude-sonnet-4-6'];
  if (sonnet46.reasoning) map['claude-sonnet-4-6'] = { ...sonnet46.reasoning };

  const sonnet = MODEL_PROFILES['claude-sonnet-4-5-20250929'];
  if (sonnet.reasoning) map['claude-sonnet'] = { ...sonnet.reasoning };

  map['claude-haiku'] = { type: 'none' };

  const gem31pro = MODEL_PROFILES['gemini-3.1-pro-preview'];
  if (gem31pro.reasoning) map['gemini-3.1-pro'] = { ...gem31pro.reasoning };

  const gem3pro = MODEL_PROFILES['gemini-3-pro-preview'];
  if (gem3pro.reasoning) map['gemini-3-pro'] = { ...gem3pro.reasoning };

  map['gemini-3-flash'] = { type: 'none' };
  map['gemini-2.5'] = { type: 'none' };

  return map;
}

/**
 * Get short display name for a model ID.
 */
export function getShortName(modelId: string): string | null {
  const profile = getProfile(modelId);
  return profile ? (profile.shortName ?? null) : null;
}

/**
 * Get the concierge fallback chain derived from ROLE_DEFAULTS.
 */
export function getConciergeFallbackChain(): Array<{ provider: string; model: string }> {
  const concierge = ROLE_DEFAULTS.concierge;

  // Primary: concierge model
  const chain: Array<{ provider: string; model: string }> = [];
  const primaryProfile = getProfile(concierge.model);
  if (primaryProfile !== null) {
    chain.push({ provider: primaryProfile.provider, model: primaryProfile.id });
  }

  // Fallback: recommended models (skip primary)
  for (const modelId of concierge.models) {
    if (modelId === concierge.model) continue;
    const p = getProfile(modelId);
    if (p !== null) chain.push({ provider: p.provider, model: p.id });
  }

  // Final fallback: cheapest flash model
  const flash = getProfile('gemini-3-flash-preview');
  if (flash !== null && !chain.some((c) => c.model === flash.id)) {
    chain.push({ provider: flash.provider, model: flash.id });
  }

  return chain;
}

/**
 * Get rate limits for a model at a specific provider tier.
 */
export function getRateLimits(
  modelId: string,
  tier: string | number,
): { rpm: number; tpm?: number; itpm?: number; otpm?: number; rpd?: number } | null {
  const profile = getProfile(modelId);
  if (profile?.rateLimits === undefined) return null;
  // Cast to allow undefined for runtime key misses (noUncheckedIndexedAccess is off)
  type RateLimitEntry = { rpm: number; tpm?: number; itpm?: number; otpm?: number; rpd?: number };
  const limits = profile.rateLimits as Record<string | number, RateLimitEntry | undefined>;
  const entry = limits[tier] ?? limits[String(tier)];
  if (entry !== undefined) return entry;
  // Fallback: return lowest tier limits (most conservative)
  const keys = Object.keys(profile.rateLimits);
  return keys.length > 0 ? (limits[keys[0]] ?? null) : null;
}

/**
 * Get smart mode tier mappings derived from agent presets.
 */
export function getModeTiers(): {
  performance: Record<string, string>;
  balanced: Record<string, string>;
  economy: Record<string, string>;
  custom: Record<string, string>;
} {
  return {
    performance: { gemini: 'default', codex: 'default', claude: 'default' },
    balanced: { gemini: 'fast', codex: 'fast', claude: 'fast' },
    economy: { gemini: 'cheap', codex: 'cheap', claude: 'cheap' },
    custom: { gemini: 'default', codex: 'default', claude: 'default' },
  };
}

/**
 * Resolves a Hydra-internal model ID to the CLI-specific model ID string.
 * Used when invoking agent CLIs that have different model ID formats.
 * Falls back to the input modelId if no override is registered.
 */
export function resolveCliModelId(modelId: string, agent?: string): string {
  // Check agent-specific profile first (agent match narrows lookup)
  if (agent !== undefined && agent !== '') {
    const agentProfile = Object.values(MODEL_PROFILES).find(
      (p) => p.agent === agent && p.id === modelId,
    );
    if (agentProfile?.cliModelId !== undefined && agentProfile.cliModelId !== '') {
      return agentProfile.cliModelId;
    }
  }
  // Global lookup — use getProfile() to safely handle unknown model IDs
  const profile = getProfile(modelId);
  return profile?.cliModelId ?? modelId;
}
