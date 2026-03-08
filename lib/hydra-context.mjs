#!/usr/bin/env node
/**
 * Project context builder for Hydra agent prompts.
 *
 * Auto-detects project details from CLAUDE.md, package.json, and git.
 * All SideQuest-specific strings have been replaced with dynamic detection.
 *
 * Tiered context strategy:
 * - minimal (~500-800 tokens): Task-specific only — for Codex
 * - medium  (~1500 tokens):    Summary + priorities — for Claude (has tool access)
 * - large   (~5000-8000 tokens): Summary + file contents + recent changes — for Gemini
 */

import fs from 'fs';
import path from 'path';
import { getAgent } from './hydra-agents.mjs';
import { loadHydraConfig, resolveProject } from './hydra-config.mjs';
import { getCurrentBranch, git } from './hydra-shared/git-ops.mjs';

const CACHE_TTL_MS = 60 * 1000;
let cachedMedium = null;
let cachedMediumAt = 0;
let cachedMediumKey = '';
let cachedLarge = null;
let cachedLargeAt = 0;
let cachedLargeKey = '';

function readFileSafe(filePath, maxLines = 0) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (maxLines > 0) {
      return content.split(/\r?\n/).slice(0, maxLines).join('\n');
    }
    return content;
  } catch {
    return '';
  }
}

/** Read HYDRA.md first; fall back to CLAUDE.md. */
function readInstructionFile(projectRoot, maxLines = 0) {
  return readFileSafe(path.join(projectRoot, 'HYDRA.md'), maxLines)
      || readFileSafe(path.join(projectRoot, 'CLAUDE.md'), maxLines);
}

function getRecentGitDiff(cwd, maxLines = 100) {
  const r = git(['diff', '--stat', 'HEAD~3..HEAD'], cwd);
  if (r.status !== 0) return '';
  const diff = (r.stdout || '').trim();
  const lines = diff.split(/\r?\n/);
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
  }
  return diff;
}

function extractSection(content, heading) {
  const pattern = new RegExp(`^##\\s+${heading}[^\\n]*\\n`, 'm');
  const match = content.match(pattern);
  if (!match) {
    return '';
  }
  const start = match.index + match[0].length;
  const nextSection = content.indexOf('\n## ', start);
  const end = nextSection === -1 ? content.length : nextSection;
  return content.slice(start, end).trim();
}

function extractPriorities(todoContent) {
  const lines = todoContent.split(/\r?\n/);
  const priorities = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- [ ] **') || trimmed.startsWith('- [x] **')) {
      const cleaned = trimmed.replace(/^- \[.\] \*\*/, '').replace(/\*\*.*/, '').trim();
      if (cleaned) {
        priorities.push(cleaned);
      }
    }
    if (priorities.length >= 8) {
      break;
    }
  }
  return priorities;
}

// ── Auto-detect project metadata ─────────────────────────────────────────────

function detectTechStack(projectRoot) {
  const parts = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['react-native']) parts.push(`React Native ${deps['react-native']}`);
    if (deps['expo']) parts.push(`Expo ${deps['expo']}`);
    if (deps['next']) parts.push(`Next.js ${deps['next']}`);
    if (deps['react'] && !deps['react-native'] && !deps['next']) parts.push(`React ${deps['react']}`);
    if (deps['vue']) parts.push(`Vue ${deps['vue']}`);
    if (deps['@supabase/supabase-js']) parts.push('Supabase');
    if (deps['prisma'] || deps['@prisma/client']) parts.push('Prisma');
    if (deps['typescript'] || deps['ts-node']) parts.push('TypeScript');
  } catch { /* ignore */ }

  if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) parts.push('Rust');
  if (fs.existsSync(path.join(projectRoot, 'go.mod'))) parts.push('Go');
  if (fs.existsSync(path.join(projectRoot, 'pyproject.toml'))) parts.push('Python');

  return parts.length > 0 ? parts.join(', ') : 'unknown stack';
}

function detectKeyFiles(projectRoot) {
  // Try to extract from HYDRA.md / CLAUDE.md "Code Entry Points" section
  const claudeMd = readInstructionFile(projectRoot);
  if (claudeMd) {
    const entryPointsSection = extractSection(claudeMd, 'Code Entry Points');
    if (entryPointsSection) {
      const lines = entryPointsSection.split(/\r?\n/).filter((l) => l.includes('|') && !l.includes('---'));
      const files = lines
        .map((l) => {
          const cells = l.split('|').map((c) => c.trim()).filter(Boolean);
          return cells.length >= 2 ? `${cells[1]} (${cells[0]})` : null;
        })
        .filter(Boolean)
        .slice(0, 6);
      if (files.length > 0) return files.join(', ');
    }
  }
  return '';
}

function detectGitRules(projectRoot) {
  const claudeMd = readInstructionFile(projectRoot);
  if (!claudeMd) return '';

  // Look for branch strategy
  const gitSection = extractSection(claudeMd, 'Git Branching');
  if (gitSection) {
    // Extract key rules
    const rules = [];
    if (/only commit to.*dev/i.test(gitSection)) rules.push('ONLY commit to dev branch');
    if (/never.*main/i.test(gitSection)) rules.push('Never push main without approval');
    return rules.join('. ');
  }
  return '';
}

// ── Context Builders ─────────────────────────────────────────────────────────

/**
 * Minimal context (~500-800 tokens) for Codex.
 * Only task-specific: file paths, relevant type definitions, function signatures.
 */
function buildMinimalContext(projectConfig, taskContext = {}) {
  const branch = getCurrentBranch(projectConfig.projectRoot);
  const techStack = detectTechStack(projectConfig.projectRoot);
  const gitRules = detectGitRules(projectConfig.projectRoot);
  const lines = [
    '--- PROJECT CONTEXT (minimal) ---',
    `Project: ${projectConfig.projectName} (${techStack})`,
    `Branch: ${branch}${gitRules ? ` — ${gitRules}` : ''}`,
  ];

  const keyFiles = detectKeyFiles(projectConfig.projectRoot);
  if (keyFiles) {
    lines.push(`Key files: ${keyFiles}`);
  }

  if (taskContext.files && taskContext.files.length > 0) {
    lines.push(`Task files: ${taskContext.files.join(', ')}`);
  }

  if (taskContext.types) {
    lines.push('Relevant types:');
    lines.push(taskContext.types);
  }

  if (taskContext.signatures) {
    lines.push('Function signatures:');
    lines.push(taskContext.signatures);
  }

  lines.push('--- END PROJECT CONTEXT ---');
  return lines.join('\n');
}

/**
 * Medium context (~1500 tokens) for Claude.
 * Claude has full tool access to read files, so summary + priorities is enough.
 */
function buildMediumContext(projectConfig) {
  const now = Date.now();
  const cacheKey = projectConfig.projectRoot;
  if (cachedMedium && now - cachedMediumAt < CACHE_TTL_MS && cachedMediumKey === cacheKey) {
    return cachedMedium;
  }

  const branch = getCurrentBranch(projectConfig.projectRoot);
  const techStack = detectTechStack(projectConfig.projectRoot);
  const gitRules = detectGitRules(projectConfig.projectRoot);
  const todoContent = readFileSafe(path.join(projectConfig.projectRoot, 'docs', 'TODO.md'), 50);
  const priorities = extractPriorities(todoContent);

  const lines = [
    '--- PROJECT CONTEXT ---',
    `Project: ${projectConfig.projectName}`,
    `Tech: ${techStack}`,
    `Branch: ${branch}`,
  ];

  if (gitRules) {
    lines.push(`Git: ${gitRules}`);
  }

  const keyFiles = detectKeyFiles(projectConfig.projectRoot);
  if (keyFiles) {
    lines.push(`Key files: ${keyFiles}`);
  }

  // Extract additional context from HYDRA.md / CLAUDE.md if available
  const claudeMd = readInstructionFile(projectConfig.projectRoot, 200);
  if (claudeMd) {
    const overview = extractSection(claudeMd, 'Project Overview');
    if (overview) {
      const firstParagraph = overview.split(/\n\n/)[0]?.trim();
      if (firstParagraph && firstParagraph.length < 200) {
        lines.push(`Description: ${firstParagraph}`);
      }
    }
  }

  if (priorities.length > 0) {
    lines.push(`Priorities: ${priorities.join(', ')}`);
  }

  lines.push('--- END PROJECT CONTEXT ---');

  cachedMedium = lines.join('\n');
  cachedMediumAt = now;
  cachedMediumKey = cacheKey;
  return cachedMedium;
}

/**
 * Large context (~5000-8000 tokens) for Gemini.
 * Leverages Gemini's massive context window with additional file contents and git history.
 */
function buildLargeContext(projectConfig, taskContext = {}) {
  const now = Date.now();
  const cacheKey = projectConfig.projectRoot;
  if (cachedLarge && now - cachedLargeAt < CACHE_TTL_MS && cachedLargeKey === cacheKey && !taskContext.files) {
    return cachedLarge;
  }

  const medium = buildMediumContext(projectConfig);
  const extraLines = [medium];

  // Add recent git changes
  const diff = getRecentGitDiff(projectConfig.projectRoot, 60);
  if (diff) {
    extraLines.push('');
    extraLines.push('--- RECENT CHANGES (last 3 commits) ---');
    extraLines.push(diff);
    extraLines.push('--- END RECENT CHANGES ---');
  }

  // Add TODO priorities (full section, not just titles)
  const todoContent = readFileSafe(path.join(projectConfig.projectRoot, 'docs', 'TODO.md'), 80);
  if (todoContent) {
    extraLines.push('');
    extraLines.push('--- CURRENT TODO (top 80 lines) ---');
    extraLines.push(todoContent);
    extraLines.push('--- END TODO ---');
  }

  // Add task-specific file contents if provided
  if (taskContext.files && taskContext.files.length > 0) {
    extraLines.push('');
    extraLines.push('--- TASK-RELEVANT FILES ---');
    for (const filePath of taskContext.files.slice(0, 5)) {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectConfig.projectRoot, filePath);
      const content = readFileSafe(fullPath, 100);
      if (content) {
        extraLines.push(`\n// ${filePath} (first 100 lines)`);
        extraLines.push(content);
      }
    }
    extraLines.push('--- END TASK-RELEVANT FILES ---');
  }

  const result = extraLines.join('\n');

  // Only cache if no task-specific files (those are unique per call)
  if (!taskContext.files || taskContext.files.length === 0) {
    cachedLarge = result;
    cachedLargeAt = now;
    cachedLargeKey = cacheKey;
  }

  return result;
}

// ── Hierarchical Context Helpers ──────────────────────────────────────────────

/**
 * Extract file paths mentioned in a prompt string.
 *
 * Matches:
 *  - Relative paths with separators: src/foo/bar.ts, ./config.json
 *  - Plain filenames with extensions: hydra-config.mjs, README.md
 *
 * @param {string} text - Prompt text to scan
 * @returns {string[]} Unique candidate paths (deduplicated)
 */
export function extractPathsFromPrompt(text) {
  if (!text) return [];
  const regex = /(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[\w]+/g;
  const matches = text.match(regex);
  if (!matches) return [];
  // Deduplicate while preserving first-occurrence order
  return [...new Set(matches)];
}

/**
 * Find scoped HYDRA.md files relevant to paths mentioned in a prompt.
 *
 * For each path extracted from promptText, walks up the directory tree from
 * that path (stopping at rootDir) and collects any HYDRA.md files found.
 * Does NOT include the root-level HYDRA.md (compiled separately by existing code).
 *
 * @param {string} promptText - The user prompt to extract paths from
 * @param {string} rootDir    - Project root (walk stops here)
 * @param {{ maxFiles?: number }} [opts] - Options: maxFiles caps results (default 3)
 * @returns {string[]} Absolute paths to scoped HYDRA.md files, deepest first
 */
export function findScopedContextFiles(promptText, rootDir, opts = {}) {
  const { maxFiles = 3 } = opts;
  const candidates = extractPathsFromPrompt(promptText);
  if (candidates.length === 0) return [];

  const absRoot = path.resolve(rootDir);
  // Use a Map keyed by depth (negative, so higher depth = deeper dir) for ordering
  const found = new Map(); // absPath → depth (number of segments below rootDir)

  for (const candidate of candidates) {
    // Resolve the candidate relative to rootDir
    const absCandidate = path.resolve(absRoot, candidate);

    // Security: ensure the candidate resolves within rootDir
    if (!absCandidate.startsWith(absRoot + path.sep) && absCandidate !== absRoot) {
      continue;
    }

    // Walk up from the candidate's directory (not including rootDir itself)
    let dir = path.dirname(absCandidate);
    while (true) {
      // Stop if we've reached or passed the root
      if (!dir.startsWith(absRoot + path.sep) && dir !== absRoot) break;
      if (dir === absRoot) break; // skip root-level HYDRA.md

      const hydraFile = path.join(dir, 'HYDRA.md');
      if (fs.existsSync(hydraFile) && !found.has(hydraFile)) {
        // Depth = number of path segments below rootDir
        const rel = path.relative(absRoot, dir);
        const depth = rel.split(path.sep).length;
        found.set(hydraFile, depth);
      }

      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  }

  if (found.size === 0) return [];

  // Sort deepest first (highest depth value first)
  const sorted = [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([absPath]) => absPath);

  return sorted.slice(0, maxFiles);
}

/**
 * Compile a set of HYDRA.md files into a single hierarchical context string.
 *
 * Each file is wrapped in a header using its path relative to rootDir:
 *   --- [src/database/HYDRA.md] ---
 *   <contents>
 *
 * @param {string[]} files   - Absolute paths to HYDRA.md files
 * @param {string}   rootDir - Project root for computing relative display paths
 * @returns {string} Combined context string, or '' if files is empty
 */
export function compileHierarchicalContext(files, rootDir) {
  if (!files || files.length === 0) return '';

  const absRoot = path.resolve(rootDir);
  const sections = [];

  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const relPath = path.relative(absRoot, f).replace(/\\/g, '/');
      sections.push(`--- [${relPath}] ---\n${content}`);
    } catch {
      // Silently skip unreadable files
    }
  }

  return sections.join('\n\n');
}

/**
 * Main export: get project context tailored to agent capabilities.
 *
 * @param {string} agentName - 'gemini', 'codex', 'claude', or undefined (defaults to medium)
 * @param {object} [taskContext] - Optional task-specific context { files, types, signatures }
 * @param {object} [projectConfig] - Optional project config from resolveProject(). If omitted, auto-resolves.
 */
export function getProjectContext(agentName = 'claude', taskContext = {}, projectConfig = null) {
  if (!projectConfig) {
    projectConfig = resolveProject({ skipValidation: true });
  }

  const agent = getAgent(agentName);
  const tier = agent?.contextTier || 'medium';

  switch (tier) {
    case 'minimal':
      return buildMinimalContext(projectConfig, taskContext);
    case 'large':
      return buildLargeContext(projectConfig, taskContext);
    case 'medium':
    default:
      return buildMediumContext(projectConfig);
  }
}

/**
 * Build agent context with optional hierarchical scoped HYDRA.md injection.
 *
 * Wraps `getProjectContext()` and, when `promptText` is provided and
 * `config.context.hierarchical.enabled` is true, prepends any scoped
 * HYDRA.md files found along the paths referenced in the prompt.
 *
 * @param {string} [agentName='claude'] - Agent name for tier selection
 * @param {object} [taskContext={}]     - Task-specific context (files, types, etc.)
 * @param {object} [projectConfig=null] - Project config from resolveProject(); auto-detected if null
 * @param {string} [promptText=null]    - User prompt text; enables hierarchical context when provided
 * @returns {string} Full context string (scoped HYDRA.md sections + root context)
 */
export function buildAgentContext(agentName = 'claude', taskContext = {}, projectConfig = null, promptText = null) {
  if (!projectConfig) {
    projectConfig = resolveProject({ skipValidation: true });
  }

  // Base context — same as existing getProjectContext behavior
  const baseContext = getProjectContext(agentName, taskContext, projectConfig);

  // Hierarchical injection — only when promptText is provided and feature is enabled
  if (!promptText) {
    return baseContext;
  }

  const cfg = loadHydraConfig();
  const hierCfg = cfg.context?.hierarchical ?? {};

  if (hierCfg.enabled === false) {
    return baseContext;
  }

  const maxFiles = hierCfg.maxFiles ?? 3;
  const scopedFiles = findScopedContextFiles(promptText, projectConfig.projectRoot, { maxFiles });

  if (scopedFiles.length === 0) {
    return baseContext;
  }

  const scopedContext = compileHierarchicalContext(scopedFiles, projectConfig.projectRoot);
  if (!scopedContext) {
    return baseContext;
  }

  // Prepend scoped (deepest-first) context before root context
  return `${scopedContext}\n\n${baseContext}`;
}
