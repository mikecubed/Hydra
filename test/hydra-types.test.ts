import { describe, it } from 'node:test';

// These imports verify the shape exists and exports correctly.
// satisfies validates structural compatibility at compile time.
import type {
  AgentDef,
  AgentResult,
  AgentInvoke,
  ErrorPatterns,
  HydraConfig,
  ModelProfile,
  QuotaStatus,
  TaskState,
  CopilotJsonlEvent,
  ParseOutputOpts,
} from '../lib/types.js';

describe('types compile-time validation', () => {
  it('AgentResult satisfies expected shape', () => {
    const result = {
      output: 'hello',
      tokenUsage: null,
      costUsd: null,
    } satisfies AgentResult;
    void result;
  });

  it('ErrorPatterns allows named keys only', () => {
    const ep = {
      authRequired: /unauthorized/i,
      rateLimited: /rate.limit/i,
    } satisfies ErrorPatterns;
    void ep;
  });

  it('AgentInvoke allows null methods', () => {
    const invoke = {
      nonInteractive: null,
      interactive: null,
      headless: (_prompt: string) => ['claude', ['-p', _prompt]] as [string, string[]],
    } satisfies AgentInvoke;
    void invoke;
  });

  it('QuotaStatus has correct shape', () => {
    const qs = { verified: true, status: 200 } satisfies QuotaStatus;
    void qs;
  });

  it('QuotaStatus allows unknown verified', () => {
    const qs = { verified: 'unknown' as const, reason: 'OAuth CLI auth' } satisfies QuotaStatus;
    void qs;
  });

  it('ModelProfile allows cliModelId', () => {
    const mp = {
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      agent: 'claude',
      displayName: 'Claude Sonnet 4.6',
      tier: 'mid' as const,
      contextWindow: 200_000,
      qualityScore: 85,
      cliModelId: 'claude-sonnet-4.6',
    } satisfies ModelProfile;
    void mp;
  });

  it('CopilotJsonlEvent has correct structure', () => {
    const ev = {
      type: 'assistant.message' as const,
      data: { content: 'hello', toolRequests: [] },
    } satisfies CopilotJsonlEvent;
    void ev;
  });

  it('TaskState has required fields', () => {
    const ts = {
      id: 'T001',
      title: 'Add feature',
      owner: 'codex',
      status: 'todo' as const,
      type: 'implementation',
      files: [],
      notes: '',
      blockedBy: [],
      updatedAt: new Date().toISOString(),
    } satisfies TaskState;
    void ts;
  });

  it('ParseOutputOpts allows jsonOutput flag', () => {
    const po = {
      model: 'claude-opus-4-6',
      agent: 'claude',
      jsonOutput: true,
    } satisfies ParseOutputOpts;
    void po;
  });

  // Compile-time only — runtime shape checks via type-narrowing
  it('AgentDef invoke may be null for virtual agents', () => {
    const partial: Partial<AgentDef> = { invoke: null };
    void partial;
  });

  it('HydraConfig has mode and routing', () => {
    const cfg: Partial<HydraConfig> = {
      mode: 'performance',
      routing: {
        mode: 'balanced',
        intentGate: { enabled: true, confidenceThreshold: 0.55 },
        worktreeIsolation: { enabled: false },
      },
    };
    void cfg;
  });
});
