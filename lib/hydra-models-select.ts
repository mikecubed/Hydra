/**
 * Hydra Interactive Model Selector
 *
 * Arrow-key picker to browse available models per agent and set the active one.
 * Sets global mode to 'custom' on selection.
 *
 * Usage:
 *   node lib/hydra-models-select.ts           # pick agent first
 *   node lib/hydra-models-select.ts claude     # straight to claude models
 *   node lib/hydra-models-select.ts codex
 *   node lib/hydra-models-select.ts gemini
 *
 * npm scripts:
 *   npm run models:select                       # all
 *   npm run models:select -- claude             # single
 */

import readline from 'node:readline';
import pc from 'picocolors';
import { loadHydraConfig, saveHydraConfig, invalidateConfigCache } from './hydra-config.ts';
import {
  getActiveModel,
  resolveModelId,
  getReasoningEffort,
  getEffortOptionsForModel,
  formatEffortDisplay,
  AGENTS,
  AGENT_NAMES,
  AGENT_DISPLAY_ORDER,
} from './hydra-agents.ts';
import { fetchModels } from './hydra-models.ts';
import { formatBenchmarkAnnotation } from './hydra-model-profiles.ts';

// ── ANSI helpers ────────────────────────────────────────────────────────────

const CSI = '\x1b[';
const CLEAR_LINE = `${CSI}2K`;
const CLEAR_BELOW = `${CSI}0J`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const up = (n: number): string => (n > 0 ? `${CSI}${String(n)}A` : '');

// Ensure cursor is always restored
process.on('exit', () => process.stdout.write(SHOW_CURSOR));

// ── Picker option types ────────────────────────────────────────────────────

interface PickerOpts<T> {
  title?: string;
  renderItem?: (item: T, isSelected: boolean) => string;
  filterKey?: (item: T) => string;
  pageSize?: number;
  initialIndex?: number;
}

// ── Interactive Picker ─────────────────────────────────────────────────────

class Picker<T> {
  items: T[];
  filtered: T[];
  cursor: number;
  search: string;
  title: string;
  renderItem: (item: T, isSelected: boolean) => string;
  filterKey: (item: T) => string;
  pageSize: number;
  scroll: number;
  _lines: number;
  _handler: ((str: string, key: unknown) => void) | null;
  _resolve: ((value: T | null) => void) | null;

  constructor(items: T[], opts: PickerOpts<T> = {}) {
    this.items = items;
    this.filtered = [...items];
    this.cursor = Math.min(opts.initialIndex ?? 0, Math.max(0, items.length - 1));
    this.search = '';
    this.title = opts.title ?? '';
    this.renderItem = opts.renderItem ?? ((item) => String(item));
    this.filterKey = opts.filterKey ?? ((item) => String(item));
    this.pageSize = opts.pageSize ?? 18;
    this.scroll = 0;
    this._lines = 0;
    this._handler = null;
    this._resolve = null;
  }

  run(): Promise<T | null> {
    if (!process.stdin.isTTY) return this._fallback();

    return new Promise<T | null>((resolve) => {
      this._resolve = resolve;
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write(HIDE_CURSOR);

      this._handler = (str: string, key: unknown) => {
        this._onKey(str, key as { ctrl?: boolean; name?: string } | null);
      };
      process.stdin.on('keypress', this._handler);
      this._draw();
    });
  }

  _handleSearchChar(str: string): void {
    if (str.length === 1 && str >= ' ') {
      this.search += str;
      this._filter();
    }
  }

  _handleNavKey(name: string): void {
    switch (name) {
      case 'up':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'down':
        this.cursor = Math.min(this.filtered.length - 1, this.cursor + 1);
        break;
      case 'pageup':
        this.cursor = Math.max(0, this.cursor - this.pageSize);
        break;
      case 'pagedown':
        this.cursor = Math.min(this.filtered.length - 1, this.cursor + this.pageSize);
        break;
      case 'home':
        this.cursor = 0;
        break;
      case 'end':
        this.cursor = Math.max(0, this.filtered.length - 1);
        break;
      default:
        break;
    }
    this._scrollTo();
  }

  _handleBackspace(): void {
    if (this.search.length > 0) {
      this.search = this.search.slice(0, -1);
      this._filter();
    }
  }

  // ── Key handling ──────────────────────────────────────────────────────────

  _onKey(str: string, key: { ctrl?: boolean; name?: string } | null) {
    if (!key) {
      this._handleSearchChar(str);
      this._draw();
      return;
    }
    if (key.ctrl === true && key.name === 'c') {
      this._finish(null);
      return;
    }
    switch (key.name) {
      case 'up':
      case 'down':
      case 'pageup':
      case 'pagedown':
      case 'home':
      case 'end':
        this._handleNavKey(key.name);
        break;
      case 'return':
        if (this.filtered.length > 0) this._finish(this.filtered[this.cursor]);
        return;
      case 'escape':
        this._finish(null);
        return;
      case 'backspace':
        this._handleBackspace();
        break;
      case undefined:
      default:
        this._handleSearchChar(str);
        break;
    }
    this._draw();
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  _filter() {
    this.filtered =
      this.search === ''
        ? [...this.items]
        : this.items.filter((item) =>
            this.filterKey(item).toLowerCase().includes(this.search.toLowerCase()),
          );
    this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
    this.scroll = 0;
    this._scrollTo();
  }

  _scrollTo() {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    else if (this.cursor >= this.scroll + this.pageSize) {
      this.scroll = this.cursor - this.pageSize + 1;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _draw() {
    if (this._lines > 0) process.stdout.write(up(this._lines));

    const lines = [];

    // Title
    if (this.title !== '') lines.push(`  ${pc.bold(pc.cyan(this.title))}`);

    // Search bar / hint
    if (this.search === '') {
      lines.push(`  ${pc.dim(`${String(this.items.length)} items — type to filter`)}`);
    } else {
      const cnt =
        this.filtered.length < this.items.length
          ? `${String(this.filtered.length)}/${String(this.items.length)}`
          : String(this.items.length);
      lines.push(`  ${pc.dim('Filter:')} ${this.search}${pc.dim('│')}  ${pc.dim(`(${cnt})`)}`);
    }
    lines.push('');

    // Items
    if (this.filtered.length === 0) {
      lines.push(`    ${pc.yellow('No matches')}`);
    } else {
      const start = this.scroll;
      const end = Math.min(start + this.pageSize, this.filtered.length);

      if (start > 0) lines.push(`  ${pc.dim(`  ↑ ${String(start)} more`)}`);

      for (let i = start; i < end; i++) {
        const sel = i === this.cursor;
        const text = this.renderItem(this.filtered[i], sel);
        lines.push(sel ? `  ${pc.cyan('▸')} ${text}` : `    ${text}`);
      }

      const remaining = this.filtered.length - end;
      if (remaining > 0) lines.push(`  ${pc.dim(`  ↓ ${String(remaining)} more`)}`);
    }

    // Footer
    lines.push('');
    lines.push(`  ${pc.dim('↑↓ navigate  enter select  esc cancel  type to filter')}`);

    // Write — clear each line, then clear any leftovers below
    process.stdout.write(`${lines.map((l) => `${CLEAR_LINE}${l}`).join('\n')}\n`);
    process.stdout.write(CLEAR_BELOW);
    this._lines = lines.length;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _finish(result: T | null) {
    if (this._handler) process.stdin.removeListener('keypress', this._handler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR);

    // Erase picker UI
    if (this._lines > 0) {
      process.stdout.write(up(this._lines));
      process.stdout.write(CLEAR_BELOW);
    }

    if (this._resolve) this._resolve(result);
  }

  // ── Non-TTY fallback ─────────────────────────────────────────────────────

  async _fallback(): Promise<T | null> {
    console.log('');
    if (this.title !== '') console.log(`  ${this.title}\n`);
    for (const [i, item] of this.items.entries()) {
      console.log(`  ${pc.dim(`${String(i + 1).padStart(3)})`)} ${this.renderItem(item, false)}`);
    }
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<T | null>((resolve) => {
      rl.question('  Enter number (q to cancel): ', (ans) => {
        rl.close();
        const t = ans.trim();
        if (t === '' || t === 'q') {
          resolve(null);
          return;
        }
        const idx = Number.parseInt(t, 10) - 1;
        resolve(idx >= 0 && idx < this.items.length ? (this.items[idx] ?? null) : null);
      });
    });
  }
}

// ── Agent picker ────────────────────────────────────────────────────────────

export async function pickAgent(): Promise<string | null> {
  const order = [
    ...AGENT_DISPLAY_ORDER.filter((a) => AGENT_NAMES.includes(a)),
    ...AGENT_NAMES.filter((a) => !AGENT_DISPLAY_ORDER.includes(a)),
  ];

  const items = order.map((name) => ({
    name,
    label: (AGENTS as Record<string, { label?: string }>)[name].label ?? name,
    active: getActiveModel(name) ?? 'unknown',
    effort: formatEffortDisplay(getActiveModel(name) ?? '', getReasoningEffort(name)),
  }));

  const picked = await new Picker(items, {
    title: 'Select Agent',
    filterKey: (item) => `${item.name} ${item.label} ${item.active}`,
    renderItem: (item, sel) => {
      const pad = ' '.repeat(Math.max(1, 30 - item.label.length));
      const label = sel ? pc.white(item.label) : item.label;
      const eff = item.effort === '' ? '' : pc.yellow(` [${item.effort}]`);
      return `${label}${pad}${pc.dim(item.active)}${eff}`;
    },
  }).run();

  return picked?.name ?? null;
}

function buildPresetAliasAnnotations(
  agentModels: Record<string, string>,
  aliases: Record<string, string>,
): { presetOf: Map<string, string>; aliasOf: Map<string, string[]> } {
  const presetOf = new Map<string, string>();
  for (const key of ['default', 'fast', 'cheap']) {
    if (agentModels[key] !== '') presetOf.set(agentModels[key], key);
  }
  const aliasOf = new Map<string, string[]>();
  for (const [alias, id] of Object.entries(aliases)) {
    const e = aliasOf.get(id);
    if (e) e.push(alias);
    else aliasOf.set(id, [alias]);
  }
  return { presetOf, aliasOf };
}

function buildModelPickerItems(
  models: string[],
  agentModels: Record<string, string>,
  currentModel: string | null,
): Array<{ id: string; preset: string | null; active: boolean }> {
  const seen = new Set<string>();
  const items: Array<{ id: string; preset: string | null; active: boolean }> = [];
  for (const key of ['default', 'fast', 'cheap']) {
    const id = agentModels[key];
    if (id !== '' && !seen.has(id)) {
      seen.add(id);
      items.push({ id, preset: key, active: id === currentModel });
    }
  }
  for (const id of models) {
    if (!seen.has(id)) {
      seen.add(id);
      items.push({ id, preset: null, active: id === currentModel });
    }
  }
  return items;
}

function renderModelPickerItem(
  item: { id: string; preset: string | null; active: boolean },
  sel: boolean,
  aliasOf: Map<string, string[]>,
): string {
  const tags = [];
  if (item.preset != null && item.preset !== '') tags.push(pc.magenta(item.preset));
  if (item.active) tags.push(pc.green('◀ active'));
  const als = aliasOf.get(item.id);
  if (als != null && (item.preset == null || item.preset === ''))
    tags.push(pc.dim(`(${als.join(', ')})`));
  const annotation = formatBenchmarkAnnotation(item.id);
  if (annotation !== '') tags.push(pc.dim(annotation));
  const suffix = tags.length > 0 ? `  ${tags.join(' ')}` : '';
  let name: string;
  if (item.active) name = pc.green(item.id);
  else if (sel) name = pc.white(item.id);
  else name = item.id;
  return `${name}${suffix}`;
}

function resolveSourceLabel(source: string): string {
  if (source === 'api') return 'REST API';
  if (source === 'cli') return 'CLI';
  return 'config only';
}

// ── Model picker ────────────────────────────────────────────────────────────

export async function pickModel(agentName: string): Promise<string | null> {
  const agentInfo = (AGENTS as Record<string, { label?: string }>)[agentName];
  const currentModel = getActiveModel(agentName);
  const cfg = loadHydraConfig();
  const agentModels =
    (cfg.models as Record<string, Record<string, string> | undefined>)[agentName] ?? {};
  const aliases =
    (cfg.aliases as Record<string, Record<string, string> | undefined>)[agentName] ?? {};

  process.stdout.write(`  ${pc.dim(`Fetching ${agentInfo.label ?? agentName} models...`)}`);
  const { models, source } = await fetchModels(agentName);
  process.stdout.write(`\r${CLEAR_LINE}`);

  const { aliasOf } = buildPresetAliasAnnotations(agentModels, aliases);
  const items = buildModelPickerItems(models, agentModels, currentModel);

  if (items.length === 0) {
    console.log(pc.yellow(`\n  No models found for ${agentName}.`));
    console.log(pc.dim('  Set API key: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY\n'));
    return null;
  }

  const sourceLabel = resolveSourceLabel(source);
  const currentEffort = getReasoningEffort(agentName);
  const effortTag = currentEffort != null && currentEffort !== '' ? ` effort:${currentEffort}` : '';
  const initialIdx = Math.max(
    0,
    items.findIndex((i) => i.active),
  );

  const picked = await new Picker(items, {
    title: `${agentInfo.label ?? agentName} — ${String(items.length)} models [${sourceLabel}]${effortTag}`,
    initialIndex: initialIdx,
    pageSize: 18,
    filterKey: (item) => {
      const parts = [item.id];
      if (item.preset != null && item.preset !== '') parts.push(item.preset);
      const als = aliasOf.get(item.id);
      if (als) parts.push(...als);
      return parts.join(' ');
    },
    renderItem: (item, sel) => renderModelPickerItem(item, sel, aliasOf),
  }).run();

  return picked?.id ?? null;
}

// ── Reasoning effort picker ─────────────────────────────────────────────────

interface EffortResult {
  id: string | null;
  label?: string;
  desc?: string | null;
  _skipped?: boolean;
}

interface EffortItem {
  id: string | null;
  label: string;
  desc: string | null;
}

export async function pickEffort(
  agentName: string,
  modelId?: string | null,
): Promise<EffortResult | null | undefined> {
  const current = getReasoningEffort(agentName);
  const effectiveModel = modelId ?? getActiveModel(agentName) ?? '';
  const options = getEffortOptionsForModel(effectiveModel);

  // Model doesn't support reasoning controls — skip picker
  if (options.length === 0) {
    return { id: null, _skipped: true };
  }

  // Determine picker title based on model type
  const { getModelReasoningCaps } = await import('./hydra-agents.ts');
  const caps = getModelReasoningCaps(effectiveModel);
  const TITLES = {
    effort: 'Reasoning Effort',
    thinking: 'Thinking Budget',
    'model-swap': 'Thinking Mode',
  };
  const title = (TITLES as Record<string, string>)[caps.type] ?? 'Reasoning Effort';

  const items: EffortItem[] = options.map(
    (opt: { id: string | null; label: string; hint?: string }) => ({
      id: opt.id,
      label: opt.label,
      desc: opt.hint ?? null,
    }),
  );

  const initialIdx =
    current != null && current !== ''
      ? Math.max(
          0,
          items.findIndex((i) => i.id === current),
        )
      : 0;

  const picked = await new Picker(items, {
    title,
    initialIndex: initialIdx,
    filterKey: (item) => item.label,
    renderItem: (item, sel) => {
      const active =
        item.id === current ||
        ((item.id == null || item.id === '') && (current == null || current === ''));
      let name: string;
      if (active) {
        name = pc.green(item.label);
      } else if (sel) {
        name = pc.white(item.label);
      } else {
        name = item.label;
      }
      const tags = [];
      if (active) tags.push(pc.green('◀ current'));
      if (item.desc != null && item.desc !== '') tags.push(pc.dim(item.desc));
      const suffix = tags.length > 0 ? `  ${tags.join(' ')}` : '';
      return `${name}${suffix}`;
    },
  }).run();

  return picked; // null = cancel, object = selection
}

// ── Apply selection ─────────────────────────────────────────────────────────

export function applySelection(
  agentName: string,
  modelId: string,
  effortLevel: string | null,
): string {
  invalidateConfigCache();
  const cfg = loadHydraConfig();

  cfg.mode = 'custom';

  const models = cfg.models as Record<string, Record<string, string | null> | undefined>;
  models[agentName] ??= {};
  const resolved = resolveModelId(agentName, modelId) ?? modelId;
  models[agentName]['active'] = resolved;
  models[agentName]['reasoningEffort'] = effortLevel ?? null;

  saveHydraConfig(cfg);
  return resolved;
}

async function resolveAgentName(arg: string | undefined): Promise<string | null> {
  if (arg != null && arg !== '' && AGENT_NAMES.includes(arg)) return arg;
  if (arg == null || arg === '') {
    console.log('');
    const picked = await pickAgent();
    if (picked == null || picked === '') {
      console.log(pc.dim('  Cancelled.\n'));
      return null;
    }
    return picked;
  }
  console.error(pc.red(`Unknown agent: ${arg}`));
  console.error(`Available: ${AGENT_NAMES.join(', ')}`);
  process.exitCode = 1;
  return null;
}

function buildEffortTag(resolved: string, effortLevel: string | null): string {
  const effortDisplay = formatEffortDisplay(resolved, effortLevel);
  if (effortDisplay !== '') return pc.yellow(effortDisplay);
  if (effortLevel != null && effortLevel !== '') return pc.yellow(effortLevel);
  return pc.dim('default');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2]?.toLowerCase();
  const agentName = await resolveAgentName(arg);
  if (agentName == null) return;

  console.log('');
  const modelId = await pickModel(agentName);
  if (modelId == null || modelId === '') {
    console.log(pc.dim('  Cancelled.\n'));
    return;
  }

  console.log('');
  const effortPick = await pickEffort(agentName, modelId);
  if (effortPick === null) {
    console.log(pc.dim('  Cancelled.\n'));
    return;
  }
  if (effortPick?._skipped === true) {
    console.log(pc.dim(`  (No reasoning controls for this model — skipped)\n`));
  }
  const effortLevel = effortPick?.id ?? null;

  const currentModel = getActiveModel(agentName);
  const currentEffort = getReasoningEffort(agentName);
  if (modelId === currentModel && effortLevel === currentEffort) {
    console.log(`\n  ${pc.dim('No changes — already set.')}\n`);
    return;
  }

  const resolved = applySelection(agentName, modelId, effortLevel);
  const effortTag = buildEffortTag(resolved, effortLevel);
  console.log(
    `\n  ${pc.green('✓')} ${pc.bold(agentName)} → ${pc.white(resolved)} ${effortTag}  ${pc.dim('(mode → custom)')}\n`,
  );
}

// Only run when invoked directly
import path from 'node:path';
const __self = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
if (path.resolve(process.argv[1] === '' ? '' : process.argv[1]) === path.resolve(__self)) {
  main().catch((err: unknown) => {
    process.stdout.write(SHOW_CURSOR);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`\nError: ${msg}`));
    process.exitCode = 1;
  });
}
