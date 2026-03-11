#!/usr/bin/env node
/**
 * Hydra single-terminal dispatch runner.
 *
 * Runs one prompt across:
 * 1) Claude (coordination/delegation)
 * 2) Gemini (critique/second-opinion)
 * 3) Codex (final synthesis in read-only mode)
 *
 * Usage:
 *   node hydra-dispatch.mjs prompt="Your request"
 *   node hydra-dispatch.mjs prompt="Your request" mode=preview
 */

import './hydra-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentContext } from './hydra-context.ts';
import { getAgent, getMode, setMode } from './hydra-agents.ts';
import { resolveProject } from './hydra-config.ts';
import {
  nowIso,
  runId,
  parseArgs,
  getPrompt,
  boolFlag,
  short,
  parseJsonLoose,
  ensureDir,
} from './hydra-utils.ts';
import { executeAgent } from './hydra-shared/agent-executor.ts';
import {
  sectionHeader,
  label,
  colorAgent,
  createSpinner,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
} from './hydra-ui.ts';
import { checkUsage } from './hydra-usage.ts';
import { isPersonaEnabled, getAgentFraming } from './hydra-persona.ts';
import pc from 'picocolors';

const config = resolveProject();
const RUNS_DIR = config.runsDir;

const DEFAULT_DAEMON_URL = process.env['AI_ORCH_URL'] || 'http://127.0.0.1:4173';
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

const MODE_DOWNSHIFT = { performance: 'balanced', balanced: 'economy' };

function usageGuard(_agent: string) {
  try {
    const usage = checkUsage();
    if (usage.level === 'critical') {
      const currentMode = getMode();
      const nextMode = (MODE_DOWNSHIFT as Record<string, string>)[currentMode];
      if (nextMode) {
        console.log(
          WARNING(
            `  \u26A0 Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 downshifting mode: ${currentMode} \u2192 ${nextMode}`,
          ),
        );
        setMode(nextMode);
      } else {
        console.log(
          WARNING(
            `  \u26A0 Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 already in economy mode`,
          ),
        );
      }
    } else if (usage.level === 'warning') {
      console.log(DIM(`  \u26A0 Token usage at ${usage.percent.toFixed(1)}%`));
    }
  } catch {
    /* non-critical */
  }
}

async function callAgent(agent: string, prompt: string, timeoutMs: number) {
  usageGuard(agent);
  return executeAgent(agent, prompt, { cwd: config.projectRoot, timeoutMs });
}

async function fetchDaemonSummary(baseUrl: string) {
  try {
    const response = await fetch(`${baseUrl}/summary`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return (payload as Record<string, unknown>)?.['summary'] ?? null;
  } catch {
    return null;
  }
}

function buildClaudeCoordinatorPrompt(userPrompt: string, daemonSummary: unknown) {
  const agentConfig = getAgent('claude');
  const schemaHint = {
    understanding: 'string',
    delegation: {
      gemini_prompt: 'string',
      codex_prompt: 'string',
      task_splits: [
        {
          owner: 'gemini|codex|claude|human',
          title: 'string',
          definition_of_done: 'string',
        },
      ],
    },
    risks: ['string'],
    next_actions: ['string'],
  };

  return [
    `${isPersonaEnabled() ? getAgentFraming('claude') : `You are ${agentConfig!.label}`} Acting as coordinator for ${config.projectName}.`,
    '',
    agentConfig!.rolePrompt,
    '',
    buildAgentContext('claude', {}, config, userPrompt),
    '',
    'Create a high-quality delegation plan for Gemini, Codex, and Claude.',
    'Return ONLY JSON (no markdown) matching this shape:',
    JSON.stringify(schemaHint, null, 2),
    '',
    `User request: ${userPrompt}`,
    '',
    'Current Hydra summary (may be null):',
    JSON.stringify(daemonSummary, null, 2),
    '',
    'Requirements:',
    '1) Generate specific prompts for Gemini and Codex.',
    '2) Split work into concrete, non-overlapping tasks.',
    '3) Include risk checks and execution order.',
    '4) Create detailed task specs for Codex (file paths, signatures, DoD).',
  ].join('\n');
}

function buildGeminiPrompt(userPrompt: string, claudePlan: unknown, daemonSummary: unknown) {
  const agentConfig = getAgent('gemini');

  return [
    `${isPersonaEnabled() ? getAgentFraming('gemini') : `You are ${agentConfig!.label}`} Triage mode for ${config.projectName}.`,
    '',
    agentConfig!.rolePrompt,
    '',
    buildAgentContext('gemini', {}, config, userPrompt),
    '',
    "Critique and improve Claude's delegation plan.",
    'Return JSON only with keys: critique, improvements, revised_codex_prompt, revised_risks.',
    'Cite specific file paths and line numbers.',
    '',
    `User request: ${userPrompt}`,
    '',
    'Claude plan JSON:',
    JSON.stringify(claudePlan, null, 2),
    '',
    'Hydra summary:',
    JSON.stringify(daemonSummary, null, 2),
    '',
    'Focus on gaps, regressions, edge cases, and stronger sequencing.',
  ].join('\n');
}

function buildCodexPrompt(
  userPrompt: string,
  claudePlan: unknown,
  geminiReview: unknown,
  daemonSummary: unknown,
) {
  const agentConfig = getAgent('codex');

  return [
    `${isPersonaEnabled() ? getAgentFraming('codex') : `You are ${agentConfig!.label}`} Generating the final execution packet.`,
    '',
    agentConfig!.rolePrompt,
    '',
    buildAgentContext('codex', { files: [] }, config, userPrompt),
    '',
    'Do NOT modify files. Produce a concise execution plan and concrete commands.',
    'Return markdown with sections:',
    '- Final Delegation',
    '- Ordered Steps',
    '- Task Updates to record in Hydra',
    '- Handoff chain',
    '',
    `User request: ${userPrompt}`,
    '',
    'Claude coordinator output:',
    JSON.stringify(claudePlan, null, 2),
    '',
    'Gemini critique output:',
    JSON.stringify(geminiReview, null, 2),
    '',
    'Hydra summary:',
    JSON.stringify(daemonSummary, null, 2),
  ].join('\n');
}

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const prompt = getPrompt(options, positionals);

  if (!prompt) {
    console.error(
      'Missing prompt. Example: node hydra-dispatch.mjs prompt="Plan offline sync rollout"',
    );
    process.exit(1);
  }

  const mode = String(options['mode'] || 'live').toLowerCase();
  const isPreview = mode === 'preview' || boolFlag(options['preview'], false);
  const save = boolFlag(options['save'], true);
  const daemonUrl = String(options['url'] || DEFAULT_DAEMON_URL);
  const timeoutMs = Number.parseInt(String(options['timeoutMs'] || DEFAULT_TIMEOUT_MS), 10);

  const id = runId('HYDRA_RUN');
  const startedAt = nowIso();

  const report = {
    id,
    startedAt,
    finishedAt: null as string | null,
    mode: isPreview ? 'preview' : 'live',
    prompt,
    project: config.projectName,
    daemonUrl,
    daemonSummary: null as unknown | null,
    claude: null as {
      ok?: boolean;
      preview?: boolean;
      command?: unknown;
      parsed?: unknown;
      stdout?: string;
      lastMessage?: string;
    } | null,
    gemini: null as {
      ok?: boolean;
      preview?: boolean;
      command?: unknown;
      parsed?: unknown;
      stdout?: string;
    } | null,
    codex: null as {
      ok?: boolean;
      preview?: boolean;
      command?: unknown;
      parsed?: unknown;
      stdout?: string;
      lastMessage?: string;
    } | null,
    outputSummary: null as {
      claudeOk: boolean;
      geminiOk: boolean;
      codexOk: boolean;
      claudeSnippet: string;
      geminiSnippet: string;
      codexSnippet: string;
    } | null,
  };

  report.daemonSummary = await fetchDaemonSummary(daemonUrl);

  const claudePrompt = buildClaudeCoordinatorPrompt(prompt, report.daemonSummary);

  if (isPreview) {
    const claudeConfig = getAgent('claude');
    const geminiConfig = getAgent('gemini');
    const codexConfig = getAgent('codex');
    report.claude = {
      ok: true,
      preview: true,
      command: claudeConfig!.invoke!.nonInteractive!('<coordinator-prompt>'),
    };
    report.gemini = {
      ok: true,
      preview: true,
      command: geminiConfig!.invoke!.nonInteractive!('<gemini-prompt>'),
    };
    report.codex = {
      ok: true,
      preview: true,
      command: codexConfig!.invoke!.nonInteractive!('<codex-prompt>', {
        outputPath: '<tempfile>',
        cwd: config.projectRoot,
      }),
    };
  } else {
    const spinClaude = createSpinner(`${colorAgent('claude')} ${DIM('coordinating...')}`, {
      style: 'solar',
    });
    spinClaude.start();
    const claudeResult = await callAgent('claude', claudePrompt, timeoutMs);
    const claudeParsed = parseJsonLoose(claudeResult.stdout);
    report.claude = {
      ...claudeResult,
      parsed: claudeParsed,
    };
    claudeResult.ok
      ? spinClaude.succeed(`${colorAgent('claude')} coordination complete`)
      : spinClaude.fail(`${colorAgent('claude')} coordination failed`);

    const geminiPrompt = buildGeminiPrompt(
      prompt,
      claudeParsed || claudeResult.stdout,
      report.daemonSummary,
    );
    const spinGemini = createSpinner(`${colorAgent('gemini')} ${DIM('critiquing...')}`, {
      style: 'solar',
    });
    spinGemini.start();
    const geminiResult = await callAgent('gemini', geminiPrompt, timeoutMs);
    const geminiParsed = parseJsonLoose(geminiResult.stdout);
    report.gemini = {
      ...geminiResult,
      parsed: geminiParsed,
    };
    geminiResult.ok
      ? spinGemini.succeed(`${colorAgent('gemini')} critique complete`)
      : spinGemini.fail(`${colorAgent('gemini')} critique failed`);

    const codexPrompt = buildCodexPrompt(
      prompt,
      claudeParsed || claudeResult.stdout,
      geminiParsed || geminiResult.stdout,
      report.daemonSummary,
    );
    const spinCodex = createSpinner(`${colorAgent('codex')} ${DIM('synthesizing...')}`, {
      style: 'solar',
    });
    spinCodex.start();
    const codexResult = await callAgent('codex', codexPrompt, timeoutMs);
    report.codex = {
      ...codexResult,
      lastMessage: codexResult.stdout,
    };
    codexResult.ok
      ? spinCodex.succeed(`${colorAgent('codex')} synthesis complete`)
      : spinCodex.fail(`${colorAgent('codex')} synthesis failed`);
  }

  report.finishedAt = nowIso();
  report.outputSummary = {
    claudeOk: Boolean(report.claude?.ok),
    geminiOk: Boolean(report.gemini?.ok),
    codexOk: Boolean(report.codex?.ok),
    claudeSnippet: short(report.claude?.stdout || JSON.stringify(report.claude?.parsed || {}), 280),
    geminiSnippet: short(report.gemini?.stdout || JSON.stringify(report.gemini?.parsed || {}), 280),
    codexSnippet: short(report.codex?.lastMessage || report.codex?.stdout || '', 280),
  };

  if (save) {
    ensureDir(RUNS_DIR);
    const outPath = path.join(RUNS_DIR, `${id}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Hydra dispatch report saved: ${path.relative(config.projectRoot, outPath)}`);
  }

  console.log(sectionHeader('Hydra Dispatch Summary'));
  console.log(label('Run ID', DIM(id)));
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Mode', pc.white(report.mode)));
  console.log(label('Claude', report.outputSummary!.claudeOk ? SUCCESS('ok') : ERROR('failed')));
  console.log(label('Gemini', report.outputSummary!.geminiOk ? SUCCESS('ok') : ERROR('failed')));
  console.log(label('Codex', report.outputSummary!.codexOk ? SUCCESS('ok') : ERROR('failed')));
  console.log(label('Claude snippet', DIM(report.outputSummary!.claudeSnippet)));
  console.log(label('Gemini snippet', DIM(report.outputSummary!.geminiSnippet)));
  console.log(label('Codex snippet', DIM(report.outputSummary!.codexSnippet)));
}

main().catch((err) => {
  console.error(`Hydra dispatch failed: ${err.message}`);
  process.exit(1);
});
