/**
 * hydra-persona.mjs — Unified personality layer for Hydra.
 *
 * Provides config-driven identity, voice, tone knobs, presets,
 * and an interactive editor. Human-facing interactions only —
 * autonomous pipelines (evolve/nightly/tasks) are excluded.
 */

import pc from 'picocolors';
import type { Interface as ReadlineInterface } from 'node:readline';
import { loadHydraConfig, saveHydraConfig } from './hydra-config.ts';

interface PersonaPreset {
  tone?: string;
  verbosity?: string;
  formality?: string;
  humor?: boolean;
  voice?: string;
}

interface PersonaConfig {
  enabled?: boolean;
  name?: string;
  tone?: string;
  verbosity?: string;
  formality?: string;
  humor?: boolean;
  voice?: string;
  identity?: string;
  presets?: Record<string, PersonaPreset>;
  agentFraming?: Record<string, string>;
  processLabels?: Record<string, string>;
  [key: string]: unknown;
}

// ── Cache ────────────────────────────────────────────────────────────────────

let _cache: PersonaConfig | null = null;

export function invalidatePersonaCache(): void {
  _cache = null;
}

export function getPersonaConfig(): PersonaConfig {
  if (_cache) return _cache;
  const cfg = loadHydraConfig();
  _cache = (cfg.persona as PersonaConfig | undefined) ?? {};
  return _cache;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function isPersonaEnabled(): boolean {
  return getPersonaConfig().enabled !== false;
}

export function listPresets(): string[] {
  const p = getPersonaConfig();
  return Object.keys(p.presets ?? {});
}

// ── Tone Modifiers ───────────────────────────────────────────────────────────

const TONE_MODIFIERS: Record<string, string> = {
  formal: 'Maintain professional distance and precise terminology.',
  balanced: '',
  casual: 'Be approachable and conversational.',
  terse: 'Be extremely brief. No pleasantries.',
};

const VERBOSITY_MODIFIERS: Record<string, string> = {
  minimal: 'Keep responses under 3 sentences where possible.',
  concise: '',
  detailed: 'Provide thorough explanations with examples when helpful.',
};

const FORMALITY_MODIFIERS: Record<string, string> = {
  formal: 'Address the developer formally.',
  neutral: '',
  informal: 'Use casual, relaxed language.',
};

function buildToneBlock(p: PersonaConfig): string {
  const parts: string[] = [];
  const tone = TONE_MODIFIERS[p.tone ?? ''] ?? '';
  const verb = VERBOSITY_MODIFIERS[p.verbosity ?? ''] ?? '';
  const form = FORMALITY_MODIFIERS[p.formality ?? ''] ?? '';
  if (tone !== '') parts.push(tone);
  if (verb !== '') parts.push(verb);
  if (form !== '') parts.push(form);
  if (p.humor === false) {
    parts.push('Do not use humor, wit, or personality. Stay purely functional.');
  }
  return parts.length > 0 ? parts.join(' ') : '';
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

export function getConciergeIdentity(): string | null {
  const p = getPersonaConfig();
  if (p.enabled == null) return null; // caller falls back to hardcoded text
  if (!p.enabled) return null;

  const voice = p.voice ?? '';
  const toneBlock = buildToneBlock(p);
  const voiceLine = [voice, toneBlock].filter(Boolean).join(' ');

  return [
    p.identity ?? '',
    '',
    voiceLine === '' ? '' : `Communication style: ${voiceLine}`,
    '',
    'You are the conversational interface. You answer questions directly, help think through problems, and escalate to your specialized perspectives when hands-on work is needed.',
  ].join('\n');
}

export function getAgentFraming(agentName: string): string {
  const p = getPersonaConfig();
  const name = agentName.toLowerCase();
  return p.agentFraming?.[name] ?? `You are ${p.name ?? 'Hydra'}'s ${name} perspective.`;
}

export function getProcessLabel(processKey: string): string {
  const p = getPersonaConfig();
  return p.processLabels?.[processKey] ?? processKey;
}

// ── Preset Application ───────────────────────────────────────────────────────

export function applyPreset(presetName: string): boolean {
  const cfg = loadHydraConfig();
  const persona: PersonaConfig = (cfg.persona as PersonaConfig | undefined) ?? {};
  const preset = persona.presets?.[presetName];
  if (!preset) return false;

  // Overlay preset values onto persona (voice only if preset specifies one)
  if (preset.tone != null && preset.tone !== '') persona.tone = preset.tone;
  if (preset.verbosity != null && preset.verbosity !== '') persona.verbosity = preset.verbosity;
  if (preset.formality != null && preset.formality !== '') persona.formality = preset.formality;
  if (preset.humor !== undefined) persona.humor = preset.humor;
  if (preset.voice != null && preset.voice !== '') persona.voice = preset.voice;

  cfg.persona = persona;
  saveHydraConfig(cfg);
  invalidatePersonaCache();
  return true;
}

// ── Display ──────────────────────────────────────────────────────────────────

export function showPersonaSummary(): void {
  const p = getPersonaConfig();
  const enabled = p.enabled !== false;
  const label = (v: string) => pc.white(v);
  const dim = (v: string) => pc.dim(v);

  console.log('');
  console.log(`  ${pc.bold(pc.cyan('Persona Configuration'))}`);
  console.log(`  ${dim('─'.repeat(36))}`);
  console.log(`  Enabled     ${enabled ? pc.green('on') : pc.red('off')}`);
  console.log(`  Name        ${label(p.name ?? 'Hydra')}`);
  console.log(`  Tone        ${label(p.tone ?? 'balanced')}`);
  console.log(`  Verbosity   ${label(p.verbosity ?? 'concise')}`);
  console.log(`  Formality   ${label(p.formality ?? 'neutral')}`);
  console.log(`  Humor       ${p.humor === false ? pc.dim('off') : pc.green('on')}`);
  console.log('');
}

// ── Interactive Editor ───────────────────────────────────────────────────────

interface PromptChoiceResult {
  value?: unknown;
  values?: unknown[];
  autoAcceptAll?: boolean;
  timedOut?: boolean;
}

function applyPresetFields(preset: PersonaPreset, persona: PersonaConfig): void {
  if (preset.tone != null && preset.tone !== '') persona.tone = preset.tone;
  if (preset.verbosity != null && preset.verbosity !== '') persona.verbosity = preset.verbosity;
  if (preset.formality != null && preset.formality !== '') persona.formality = preset.formality;
  if (preset.humor !== undefined) persona.humor = preset.humor;
  if (preset.voice != null && preset.voice !== '') persona.voice = preset.voice;
}

async function handlePresetChoice(
  rl: ReadlineInterface,
  persona: PersonaConfig,
  changes: string[],
  promptChoice: PromptChoiceFn,
): Promise<void> {
  const presetNames = Object.keys(persona.presets ?? {});
  if (presetNames.length === 0) {
    console.log(`  ${pc.dim('No presets available.')}`);
    return;
  }
  const pick = await promptChoice(rl, {
    title: 'Select Preset',
    choices: presetNames.map((n) => ({ label: n, value: n })),
  });
  const pickValue = typeof pick?.value === 'string' ? pick.value : '';
  if (pickValue !== '') {
    const preset = persona.presets?.[pickValue];
    if (preset) {
      applyPresetFields(preset, persona);
      changes.push(`preset → ${pickValue}`);
      console.log(`  ${pc.green('Applied preset:')} ${pickValue}`);
    }
  }
}

interface TweakResult {
  tone?: string;
  verbosity?: string;
  formality?: string;
  humor?: boolean;
}

async function collectTweakChoices(
  rl: ReadlineInterface,
  persona: PersonaConfig,
  promptChoice: PromptChoiceFn,
): Promise<TweakResult> {
  const tone = await promptChoice(rl, {
    title: 'Tone',
    context: `Current: ${persona.tone ?? 'balanced'}`,
    choices: [
      { label: 'formal', value: 'formal' },
      { label: 'balanced', value: 'balanced' },
      { label: 'casual', value: 'casual' },
      { label: 'terse', value: 'terse' },
    ],
  });

  const verb = await promptChoice(rl, {
    title: 'Verbosity',
    context: `Current: ${persona.verbosity ?? 'concise'}`,
    choices: [
      { label: 'minimal', value: 'minimal' },
      { label: 'concise', value: 'concise' },
      { label: 'detailed', value: 'detailed' },
    ],
  });

  const form = await promptChoice(rl, {
    title: 'Formality',
    context: `Current: ${persona.formality ?? 'neutral'}`,
    choices: [
      { label: 'formal', value: 'formal' },
      { label: 'neutral', value: 'neutral' },
      { label: 'informal', value: 'informal' },
    ],
  });

  const humor = await promptChoice(rl, {
    title: 'Humor',
    context: `Current: ${persona.humor === false ? 'off' : 'on'}`,
    choices: [
      { label: 'On', value: true },
      { label: 'Off', value: false },
    ],
  });

  return buildTweakResult(tone, verb, form, humor);
}

function buildTweakResult(
  tone: PromptChoiceResult | null,
  verb: PromptChoiceResult | null,
  form: PromptChoiceResult | null,
  humor: PromptChoiceResult | null,
): TweakResult {
  const result: TweakResult = {};
  const toneValue = typeof tone?.value === 'string' ? tone.value : '';
  if (toneValue !== '') result.tone = toneValue;
  const verbValue = typeof verb?.value === 'string' ? verb.value : '';
  if (verbValue !== '') result.verbosity = verbValue;
  const formValue = typeof form?.value === 'string' ? form.value : '';
  if (formValue !== '') result.formality = formValue;
  if (humor?.value !== undefined && typeof humor.value === 'boolean') result.humor = humor.value;
  return result;
}

async function handleTweakSettings(
  rl: ReadlineInterface,
  persona: PersonaConfig,
  changes: string[],
  promptChoice: PromptChoiceFn,
): Promise<void> {
  const tweaks = await collectTweakChoices(rl, persona, promptChoice);
  const p = persona;
  if (tweaks.tone !== undefined) {
    p.tone = tweaks.tone;
    changes.push(`tone → ${tweaks.tone}`);
  }
  if (tweaks.verbosity !== undefined) {
    p.verbosity = tweaks.verbosity;
    changes.push(`verbosity → ${tweaks.verbosity}`);
  }
  if (tweaks.formality !== undefined) {
    p.formality = tweaks.formality;
    changes.push(`formality → ${tweaks.formality}`);
  }
  if (tweaks.humor !== undefined) {
    p.humor = tweaks.humor;
    changes.push(`humor → ${tweaks.humor ? 'on' : 'off'}`);
  }
}

async function handleNameEdit(
  rl: ReadlineInterface,
  persona: PersonaConfig,
  changes: string[],
  promptChoice: PromptChoiceFn,
): Promise<void> {
  const nameResult = await promptChoice(rl, {
    title: 'Persona Name',
    context: `Current: ${persona.name ?? 'Hydra'}`,
    freeform: true,
    choices: [
      { label: 'Hydra', value: 'Hydra' },
      { label: 'Custom (type below)', value: '__freeform__' },
    ],
  } as Parameters<PromptChoiceFn>[1]);
  const nameValue = typeof nameResult?.value === 'string' ? nameResult.value : '';
  const localPersona = persona;
  if (nameValue !== '' && nameValue !== '__freeform__') {
    localPersona.name = nameValue;
    changes.push(`name → ${nameValue}`);
  }
}

type PromptChoiceFn = (
  rl: ReadlineInterface,
  opts?: Record<string, unknown>,
) => Promise<PromptChoiceResult | null>;

export async function runPersonaEditor(rl: ReadlineInterface): Promise<void> {
  const { promptChoice } = await import('./hydra-prompt-choice.ts');

  const cfg = loadHydraConfig();
  const persona: PersonaConfig = (cfg.persona as PersonaConfig | undefined) ?? {};
  const changes: string[] = [];

  showPersonaSummary();

  // Main menu loop
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive REPL menu; each iteration waits for one user choice before presenting the next
    const action = (await promptChoice(rl, {
      title: 'Persona Editor',
      choices: [
        { label: 'Switch preset', value: 'preset' },
        { label: 'Tweak settings', value: 'tweak' },
        { label: 'Edit name', value: 'name' },
        {
          label: persona.enabled === false ? 'Enable persona' : 'Disable persona',
          value: 'toggle',
        },
        { label: 'Done', value: 'done' },
      ],
    })) as PromptChoiceResult | null;

    if (action == null || action.value === 'done' || action.timedOut === true) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive menu handlers must complete before next iteration
    if (action.value === 'preset') await handlePresetChoice(rl, persona, changes, promptChoice);
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive menu handlers must complete before next iteration
    if (action.value === 'tweak') await handleTweakSettings(rl, persona, changes, promptChoice);
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive menu handlers must complete before next iteration
    if (action.value === 'name') await handleNameEdit(rl, persona, changes, promptChoice);

    if (action.value === 'toggle') {
      persona.enabled = persona.enabled === false;
      changes.push(`enabled → ${String(persona.enabled)}`);
      console.log(`  Persona ${persona.enabled ? pc.green('enabled') : pc.red('disabled')}`);
    }
  }

  // Save if changed
  if (changes.length > 0) {
    cfg.persona = persona;
    saveHydraConfig(cfg);
    invalidatePersonaCache();
    console.log(
      `  ${pc.green('Saved')} ${String(changes.length)} change${changes.length === 1 ? '' : 's'}: ${changes.join(', ')}`,
    );
  } else {
    console.log(`  ${pc.dim('No changes.')}`);
  }
}
