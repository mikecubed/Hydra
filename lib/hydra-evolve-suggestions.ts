/**
 * Hydra Evolve Suggestions — Persistent backlog of improvement ideas.
 *
 * Stores improvement suggestions from failed/deferred evolve rounds, user input,
 * and review sessions. Presents pending suggestions at the start of each new
 * evolve session so the user can pick one to explore, enter their own, or let
 * agents discover something new.
 *
 * Storage: docs/coordination/evolve/SUGGESTIONS.json
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ensureDir } from './hydra-utils.ts';
import pc from 'picocolors';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SuggestionEntry {
  id?: string;
  createdAt?: string;
  source?: string;
  sourceRef?: string | null;
  area?: string;
  title?: string;
  description?: string;
  specPath?: string | null;
  priority?: string;
  status?: string;
  attempts?: number;
  maxAttempts?: number;
  lastAttemptDate?: string | null;
  lastAttemptVerdict?: string | null;
  lastAttemptScore?: number | null;
  lastAttemptLearnings?: string | null;
  tags?: string[];
  notes?: string;
}

interface Suggestions {
  version?: number;
  entries: SuggestionEntry[];
  stats?: Record<string, unknown>;
}

interface EvolveRoundResult {
  verdict?: string;
  score?: number;
  area?: string;
  round?: number | string;
  investigations?: { diagnoses?: Array<{ diagnosis: string }> };
}

interface EvolveDeliberation {
  selectedImprovement?: string;
}

interface CreateFromRoundOpts {
  source?: string;
  sessionId?: string;
  specPath?: string | null;
  notes?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const SUGGESTIONS_FILENAME = 'SUGGESTIONS.json';

function suggestionsPath(evolveDir: string) {
  return path.join(evolveDir, SUGGESTIONS_FILENAME);
}

const EMPTY_SUGGESTIONS = {
  version: 1,
  entries: [],
  stats: {
    totalPending: 0,
    totalCompleted: 0,
    totalRejected: 0,
    totalAbandoned: 0,
  },
};

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ── Load / Save ─────────────────────────────────────────────────────────────

/**
 * Load the suggestions backlog from disk.
 * Returns a fresh empty object if the file doesn't exist or is invalid.
 *
 * @param {string} evolveDir - Path to docs/coordination/evolve/
 * @returns {object} Suggestions object
 */
export function loadSuggestions(evolveDir: string): Suggestions {
  const filePath = suggestionsPath(evolveDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Suggestions;
    if (!Array.isArray(parsed.entries)) {
      return { ...EMPTY_SUGGESTIONS, entries: [], stats: { ...EMPTY_SUGGESTIONS.stats } };
    }
    return parsed;
  } catch {
    return { ...EMPTY_SUGGESTIONS, entries: [], stats: { ...EMPTY_SUGGESTIONS.stats } };
  }
}

/**
 * Save the suggestions backlog to disk. Recalculates stats before writing.
 *
 * @param {string} evolveDir - Path to docs/coordination/evolve/
 * @param {object} sg - Suggestions object
 */
export function saveSuggestions(evolveDir: string, sg: Suggestions): void {
  ensureDir(evolveDir);
  sg.stats = computeStats(sg.entries);
  const filePath = suggestionsPath(evolveDir);
  fs.writeFileSync(filePath, `${JSON.stringify(sg, null, 2)}\n`, 'utf8');
}

// ── Entry Management ────────────────────────────────────────────────────────

/**
 * Generate the next suggestion ID based on existing entries.
 */
function nextId(entries: SuggestionEntry[]) {
  if (entries.length === 0) return 'SUG_001';
  const maxNum = entries.reduce((max: number, e: SuggestionEntry) => {
    const m = (e.id ?? '').match(/^SUG_(\d+)$/);
    return m ? Math.max(max, Number.parseInt(m[1], 10)) : max;
  }, 0);
  return `SUG_${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * Check if a title+description is too similar to an existing suggestion.
 * Uses Jaccard similarity on word sets.
 */
function isTooSimilar(existingEntries: SuggestionEntry[], newText: string, threshold = 0.7) {
  const newWords = new Set(
    newText
      .toLowerCase()
      .split(/\s+/)
      .filter((w: string) => w.length > 3),
  );
  if (newWords.size === 0) return false;

  for (const entry of existingEntries) {
    // Only dedup against non-terminal entries
    if (entry.status === 'abandoned') continue;

    const existingText = `${entry.title ?? ''} ${entry.description ?? ''}`;
    const existingWords = new Set(
      existingText
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 3),
    );
    if (existingWords.size === 0) continue;

    const intersection = new Set([...newWords].filter((w: string) => existingWords.has(w)));
    const union = new Set([...newWords, ...existingWords]);
    const similarity = intersection.size / union.size;

    if (similarity >= threshold) return true;
  }
  return false;
}

/**
 * Add a suggestion to the backlog with dedup.
 * Returns the added entry (with generated ID) or null if deduplicated.
 *
 * @param {object} sg - Suggestions object
 * @param {object} entry - Suggestion data (without id)
 * @returns {object|null} The added entry or null if deduped
 */
function buildEntryCoreFields(entry: SuggestionEntry, id: string): Partial<SuggestionEntry> {
  return {
    id,
    createdAt: entry.createdAt ?? new Date().toISOString().split('T')[0],
    source: entry.source ?? 'user:manual',
    sourceRef: entry.sourceRef ?? null,
    area: entry.area ?? 'general',
    title: entry.title ?? '',
    description: entry.description ?? '',
    specPath: entry.specPath ?? null,
  };
}

function buildEntryTrackingFields(entry: SuggestionEntry): Partial<SuggestionEntry> {
  return {
    priority: entry.priority ?? 'medium',
    status: 'pending',
    attempts: entry.attempts ?? 0,
    maxAttempts: entry.maxAttempts ?? 3,
    lastAttemptDate: entry.lastAttemptDate ?? null,
    lastAttemptVerdict: entry.lastAttemptVerdict ?? null,
    lastAttemptScore: entry.lastAttemptScore ?? null,
    lastAttemptLearnings: entry.lastAttemptLearnings ?? null,
    tags: entry.tags ?? [],
    notes: entry.notes ?? '',
  };
}

export function addSuggestion(sg: Suggestions, entry: SuggestionEntry): SuggestionEntry | null {
  const dedupText = `${entry.title ?? ''} ${entry.description ?? ''}`;
  if (dedupText.trim() !== '' && isTooSimilar(sg.entries, dedupText)) {
    return null;
  }

  const id = nextId(sg.entries);
  const fullEntry = {
    ...buildEntryCoreFields(entry, id),
    ...buildEntryTrackingFields(entry),
  } as SuggestionEntry;

  sg.entries.push(fullEntry);
  return fullEntry;
}

/**
 * Update an existing suggestion by ID.
 *
 * @param {object} sg - Suggestions object
 * @param {string} id - Suggestion ID (e.g., 'SUG_001')
 * @param {object} updates - Fields to merge
 * @returns {object|null} Updated entry or null if not found
 */
export function updateSuggestion(
  sg: Suggestions,
  id: string,
  updates: Partial<SuggestionEntry>,
): SuggestionEntry | null {
  const entry = sg.entries.find((e: SuggestionEntry) => e.id === id);
  if (!entry) return null;
  Object.assign(entry, updates);
  return entry;
}

/**
 * Set a suggestion's status to 'abandoned'.
 *
 * @param {object} sg - Suggestions object
 * @param {string} id - Suggestion ID
 * @returns {object|null} Updated entry or null if not found
 */
export function removeSuggestion(sg: Suggestions, id: string): SuggestionEntry | null {
  return updateSuggestion(sg, id, { status: 'abandoned' });
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Get all pending suggestions, sorted by priority then date.
 *
 * @param {object} sg - Suggestions object
 * @returns {object[]} Pending entries
 */
export function getPendingSuggestions(sg: Suggestions): SuggestionEntry[] {
  return sg.entries
    .filter((e: SuggestionEntry) => e.status === 'pending')
    .sort((a: SuggestionEntry, b: SuggestionEntry) => {
      const pa = PRIORITY_ORDER[a.priority ?? ''] ?? 1;
      const pb = PRIORITY_ORDER[b.priority ?? ''] ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    });
}

/**
 * Lookup a suggestion by ID.
 *
 * @param {object} sg - Suggestions object
 * @param {string} id - Suggestion ID
 * @returns {object|null} Entry or null
 */
export function getSuggestionById(sg: Suggestions, id: string): SuggestionEntry | null {
  return sg.entries.find((e: SuggestionEntry) => e.id === id) ?? null;
}

/**
 * Search suggestions by query text and optional filters.
 *
 * @param {object} sg - Suggestions object
 * @param {string} [query] - Text to search in title, description, area, tags
 * @param {object} [opts] - Filters: { status, area }
 * @returns {object[]} Matching entries
 */
export function searchSuggestions(
  sg: Suggestions,
  query?: string,
  opts: { status?: string; area?: string } = {},
): SuggestionEntry[] {
  let results = [...sg.entries];

  if (opts.status != null && opts.status !== '') {
    results = results.filter((e: SuggestionEntry) => e.status === opts.status);
  }

  if (opts.area != null && opts.area !== '') {
    results = results.filter((e: SuggestionEntry) => e.area === opts.area);
  }

  if (query != null && query !== '') {
    const q = query.toLowerCase();
    results = results.filter(
      (e) =>
        (e.title ?? '').toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q) ||
        (e.area ?? '').toLowerCase().includes(q) ||
        (e.tags ?? []).some((t: string) => t.toLowerCase().includes(q)),
    );
  }

  return results.sort((a: SuggestionEntry, b: SuggestionEntry) => {
    const pa = PRIORITY_ORDER[a.priority ?? ''] ?? 1;
    const pb = PRIORITY_ORDER[b.priority ?? ''] ?? 1;
    if (pa !== pb) return pa - pb;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}

// ── Auto-Population ─────────────────────────────────────────────────────────

/**
 * Create a suggestion from a rejected/deferred evolve round.
 * Only creates if the round had a valid improvement and no similar suggestion exists.
 *
 * @param {object} sg - Suggestions object
 * @param {object} roundResult - The round result object from evolve
 * @param {object} deliberation - The deliberation object (has selectedImprovement)
 * @param {object} [opts] - { sessionId, specPath, notes, source }
 * @returns {object|null} The created suggestion or null if deduped/invalid
 */
function determineRoundSource(roundResult: EvolveRoundResult, opts: CreateFromRoundOpts): string {
  if (opts.source != null) return opts.source;
  if (roundResult.verdict === 'skipped') return 'auto:deferred';
  return 'auto:rejected-round';
}

function determineRoundPriority(roundResult: EvolveRoundResult): string {
  if ((roundResult.score ?? 0) >= 5) return 'high';
  if (
    (roundResult.score ?? 0) <= 1 &&
    roundResult.investigations?.diagnoses?.every((d) => d.diagnosis === 'transient') === true
  ) {
    return 'high';
  }
  return 'medium';
}

function buildRoundSourceRef(
  opts: CreateFromRoundOpts,
  roundResult: EvolveRoundResult,
): string | null {
  return opts.sessionId != null && opts.sessionId !== ''
    ? `${opts.sessionId}/round-${String(roundResult.round ?? '')}`
    : null;
}

function buildRoundTags(roundResult: EvolveRoundResult, source: string): string[] {
  return [
    roundResult.area ?? '',
    source.split(':')[1] === '' ? source : source.split(':')[1],
    ...(roundResult.verdict != null && roundResult.verdict !== '' ? [roundResult.verdict] : []),
  ];
}

export function createSuggestionFromRound(
  sg: Suggestions,
  roundResult: EvolveRoundResult,
  deliberation: EvolveDeliberation,
  opts: CreateFromRoundOpts = {},
): SuggestionEntry | null {
  const improvement = deliberation.selectedImprovement;
  if (
    improvement == null ||
    improvement === '' ||
    improvement === 'No improvement selected' ||
    improvement.length < 10
  ) {
    return null;
  }

  const title = improvement.length > 100 ? `${improvement.slice(0, 97)}...` : improvement;
  const source = determineRoundSource(roundResult, opts);
  const priority = determineRoundPriority(roundResult);

  return addSuggestion(sg, {
    source,
    sourceRef: buildRoundSourceRef(opts, roundResult),
    area: roundResult.area,
    title,
    description: improvement,
    specPath: opts.specPath ?? null,
    priority,
    tags: buildRoundTags(roundResult, source),
    notes: opts.notes ?? '',
  });
}

// ── Interactive Picker ──────────────────────────────────────────────────────

/**
 * Create a readline interface for the picker (same pattern as review-common).
 */
function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

/**
 * Ask a question and return the trimmed answer.
 */
function askRaw(
  rl: ReturnType<typeof readline.createInterface>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Present pending suggestions to the user and let them pick one,
 * skip, enter freeform text, or let agents discover.
 *
 * @param {object[]} pending - Array of pending suggestion entries
 * @param {object} [opts] - { maxDisplay: 5 }
 * @returns {Promise<{ action: string, suggestion?: object, text?: string }>}
 */
function formatAttemptInfo(s: SuggestionEntry): string[] {
  if ((s.attempts ?? 0) === 0) return [];
  return [
    `Last: ${s.lastAttemptVerdict ?? '?'} (${s.lastAttemptScore == null ? '?' : String(s.lastAttemptScore)}/10)`,
    `Attempts: ${String(s.attempts ?? 0)}/${String(s.maxAttempts ?? 0)}`,
  ];
}

function displaySuggestionItem(s: SuggestionEntry, i: number): void {
  const num = pc.bold(pc.white(`  ${String(i + 1)}.`));
  const idTag = pc.dim(`[${s.id ?? ''}]`);
  const areaTag = pc.yellow(s.area);
  const titleText =
    (s.title ?? '').length > 60 ? `${(s.title ?? '').slice(0, 57)}...` : (s.title ?? '');

  console.error(`${num} ${idTag} ${areaTag}: ${titleText} ${pc.dim(`(${s.priority ?? ''})`)}`);

  const parts = formatAttemptInfo(s);
  if (s.specPath != null && s.specPath !== '') parts.push('has spec');
  if (parts.length > 0) {
    console.error(`     ${pc.dim(parts.join(' | '))}`);
  }
  console.error('');
}

function displaySuggestionList(
  displayed: SuggestionEntry[],
  pending: SuggestionEntry[],
  maxDisplay: number,
): void {
  for (const [i, s] of displayed.entries()) {
    displaySuggestionItem(s, i);
  }
  if (pending.length > maxDisplay) {
    console.error(pc.dim(`     ... and ${String(pending.length - maxDisplay)} more`));
    console.error('');
  }
}

export async function promptSuggestionPicker(
  pending: SuggestionEntry[],
  opts: { maxDisplay?: number } = {},
): Promise<{ action: string; suggestion?: SuggestionEntry; text?: string }> {
  const maxDisplay = opts.maxDisplay ?? 5;
  const displayed = pending.slice(0, maxDisplay);

  const rl = createRL();

  try {
    console.error('');
    console.error(pc.bold(pc.cyan(`  Pending Suggestions (${String(pending.length)}):`)));
    console.error('');

    displaySuggestionList(displayed, pending, maxDisplay);

    const prompt = `${pc.cyan(
      `  [1-${String(displayed.length)}]`,
    )} pick, ${pc.dim('[s]')}kip, ${pc.dim('[f]')}reeform, ${pc.dim('[d]')}iscover: `;

    const answer = await askRaw(rl, prompt);
    const lower = answer.toLowerCase();

    const num = Number.parseInt(answer, 10);
    if (num >= 1 && num <= displayed.length) {
      return { action: 'pick', suggestion: displayed[num - 1] };
    }

    if (lower === 'f' || lower === 'freeform') {
      const text = await askRaw(rl, pc.cyan('  Describe your improvement idea: '));
      if (text.length > 0) {
        return { action: 'freeform', text };
      }
      return { action: 'discover' };
    }

    if (lower === 'd' || lower === 'discover') {
      return { action: 'discover' };
    }

    return { action: 'skip' };
  } finally {
    rl.close();
  }
}
// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Compute stats from entries.
 */
function computeStats(entries: SuggestionEntry[]) {
  return {
    totalPending: entries.filter((e: SuggestionEntry) => e.status === 'pending').length,
    totalExploring: entries.filter((e: SuggestionEntry) => e.status === 'exploring').length,
    totalCompleted: entries.filter((e: SuggestionEntry) => e.status === 'completed').length,
    totalRejected: entries.filter((e: SuggestionEntry) => e.status === 'rejected').length,
    totalAbandoned: entries.filter((e: SuggestionEntry) => e.status === 'abandoned').length,
  };
}

/**
 * Get suggestion stats.
 *
 * @param {object} sg - Suggestions object
 * @returns {object} Stats summary
 */
export function getSuggestionStats(sg: Suggestions): {
  totalPending: number;
  totalExploring: number;
  totalCompleted: number;
  totalRejected: number;
  totalAbandoned: number;
} {
  return computeStats(sg.entries);
}

/**
 * Format stats as a concise text block for agent prompts.
 *
 * @param {object} sg - Suggestions object
 * @returns {string} Formatted one-liner
 */
export function formatSuggestionsForPrompt(sg: Suggestions): string {
  const stats = computeStats(sg.entries);
  return `Suggestions Backlog: ${String(stats.totalPending)} pending, ${String(stats.totalCompleted)} completed, ${String(stats.totalRejected)} rejected`;
}
