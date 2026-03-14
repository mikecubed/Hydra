/**
 * Hydra Self Index — lightweight code index for self-awareness.
 *
 * This is intentionally heuristic (regex-based). It’s designed to:
 * - give agents a quick map of modules/exports/entrypoints
 * - enumerate daemon routes, MCP tools/resources, and operator commands
 * - stay dependency-free (no AST parser)
 */

import fs from 'node:fs';
import path from 'node:path';
import { HYDRA_ROOT, loadHydraConfig } from './hydra-config.ts';
import { loadCodebaseContext } from './hydra-codebase-context.ts';

// ── Internal types ───────────────────────────────────────────────────────────

interface ModuleIndexEntry {
  file: string;
  purpose?: string;
}

interface McpInfo {
  tools: string[];
  resources: string[];
}

interface OperatorInfo {
  commands: string[];
}

export interface SelfIndex {
  generatedAt: string;
  hydraRoot: string;
  moduleIndex: ModuleIndexEntry[];
  moduleExports: Array<{ file: string; exports: string[] }>;
  daemonRoutes: string[];
  mcp: McpInfo;
  operator: OperatorInfo;
  configKeys: string[];
}

interface FormatSelfIndexOpts {
  maxChars?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function walkFiles(rootDir: string, filterFn: (f: string) => boolean): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === 'node_modules' ||
          ent.name === '.git' ||
          ent.name === 'dist' ||
          ent.name === 'build'
        )
          continue;
        stack.push(full);
      } else if (ent.isFile()) {
        if (filterFn(full)) out.push(full);
      }
    }
  }
  return out;
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

function extractExports(source: string): string[] {
  const names: string[] = [];
  if (source === '') return names;

  // export function foo / export async function foo
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
    names.push(m[1]);
  }
  // export const foo / export let foo
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/g)) {
    names.push(m[1]);
  }
  // export class Foo
  for (const m of source.matchAll(/export\s+class\s+([A-Za-z0-9_]+)/g)) {
    names.push(m[1]);
  }
  // export { a, b as c }
  for (const m of source.matchAll(/export\s*\{\s*([^}]+)\s*\}/g)) {
    const parts = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const splitParts = p.split(/\s+as\s+/i).map((s) => s.trim());
      const left = splitParts[0] ?? p;
      const right = splitParts[1] as string | undefined;
      names.push(right ?? left);
    }
  }
  return uniq(names).sort();
}

function extractDaemonRoutes(source: string): string[] {
  const routes: string[] = [];
  if (source === '') return routes;
  for (const m of source.matchAll(/route\s*===\s*'([^']+)'/g)) routes.push(m[1]);
  for (const m of source.matchAll(/route\s*===\s*"([^"]+)"/g)) routes.push(m[1]);
  for (const m of source.matchAll(/route\.startsWith\(\s*'([^']+)'\s*\)/g)) routes.push(`${m[1]}*`);
  for (const m of source.matchAll(/route\.startsWith\(\s*"([^"]+)"\s*\)/g)) routes.push(`${m[1]}*`);
  for (const m of source.matchAll(/route\.endsWith\(\s*'([^']+)'\s*\)/g)) routes.push(`*${m[1]}`);
  for (const m of source.matchAll(/route\.endsWith\(\s*"([^"]+)"\s*\)/g)) routes.push(`*${m[1]}`);
  return uniq(routes).sort();
}

function extractMcpTools(source: string): string[] {
  const tools: string[] = [];
  if (source === '') return tools;
  for (const m of source.matchAll(/server\.tool\(\s*'([^']+)'/g)) tools.push(m[1]);
  for (const m of source.matchAll(/server\.tool\(\s*"([^"]+)"/g)) tools.push(m[1]);
  return uniq(tools).sort();
}

function extractMcpResources(source: string): string[] {
  const resources: string[] = [];
  if (source === '') return resources;
  // server.registerResource('name','hydra://uri', ...)
  for (const m of source.matchAll(/server\.registerResource\(\s*'[^']+'\s*,\s*'([^']+)'/g))
    resources.push(m[1]);
  for (const m of source.matchAll(/server\.registerResource\(\s*"[^"]+"\s*,\s*"([^"]+)"/g))
    resources.push(m[1]);
  return uniq(resources).sort();
}

function extractOperatorCommands(source: string): string[] {
  const cmds: string[] = [];
  if (source === '') return cmds;

  // Best-effort: parse KNOWN_COMMANDS array literals
  const block = source.match(/const\s+KNOWN_COMMANDS\s*=\s*\[([\s\S]*?)\];/m);
  if (block != null && block[1] !== '') {
    for (const m of block[1].matchAll(/'(:[^']+)'/g)) cmds.push(m[1]);
    for (const m of block[1].matchAll(/"(:[^"]+)"/g)) cmds.push(m[1]);
  }

  return uniq(cmds).sort();
}

export function buildSelfIndex(rootDir = HYDRA_ROOT): SelfIndex {
  const libDir = path.join(rootDir, 'lib');
  const codeCtx = loadCodebaseContext();

  const mjsFiles = walkFiles(libDir, (f) => f.endsWith('.mjs'));
  const moduleExports: Array<{ file: string; exports: string[] }> = [];
  for (const abs of mjsFiles) {
    const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
    const src = readFileSafe(abs);
    const exports = extractExports(src);
    if (exports.length === 0) continue;
    moduleExports.push({ file: rel, exports });
  }

  // Special maps
  const daemonRead = readFileSafe(path.join(libDir, 'daemon', 'read-routes.ts'));
  const daemonWrite = readFileSafe(path.join(libDir, 'daemon', 'write-routes.ts'));
  const daemonRoutes = uniq([
    ...extractDaemonRoutes(daemonRead),
    ...extractDaemonRoutes(daemonWrite),
  ]).sort();

  const mcpSrc = readFileSafe(path.join(libDir, 'hydra-mcp-server.ts'));
  const mcp: McpInfo = {
    tools: extractMcpTools(mcpSrc),
    resources: extractMcpResources(mcpSrc),
  };

  const operatorSrc = readFileSafe(path.join(libDir, 'hydra-operator.ts'));
  const operator: OperatorInfo = {
    commands: extractOperatorCommands(operatorSrc),
  };

  const cfg = (() => {
    try {
      return loadHydraConfig();
    } catch {
      return null;
    }
  })();

  const configKeys =
    cfg && typeof cfg === 'object' ? Object.keys(cfg as Record<string, unknown>).sort() : [];

  return {
    generatedAt: new Date().toISOString(),
    hydraRoot: rootDir,
    moduleIndex: codeCtx.moduleIndex,
    moduleExports,
    daemonRoutes,
    mcp,
    operator,
    configKeys,
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15))}... (truncated)`;
}

export function formatSelfIndexForPrompt(index: SelfIndex, opts: FormatSelfIndexOpts = {}): string {
  const maxChars = Number.isFinite(opts.maxChars) ? (opts.maxChars as number) : 7000;
  const idx = index;
  const header = '=== HYDRA SELF INDEX ===\n';
  const footer = '\n=== END INDEX ===';

  const bodyLines: string[] = [];
  if (idx.daemonRoutes.length > 0) {
    bodyLines.push(
      `Daemon routes: ${idx.daemonRoutes.slice(0, 40).join(', ')}${idx.daemonRoutes.length > 40 ? ', ...' : ''}`,
    );
  }
  if (idx.mcp.tools.length > 0) {
    bodyLines.push(`MCP tools: ${idx.mcp.tools.join(', ')}`);
  }
  if (idx.mcp.resources.length > 0) {
    bodyLines.push(`MCP resources: ${idx.mcp.resources.join(', ')}`);
  }
  if (idx.operator.commands.length > 0) {
    bodyLines.push(`Operator commands: ${idx.operator.commands.join(', ')}`);
  }
  if (idx.moduleIndex.length > 0) {
    const sample = idx.moduleIndex
      .slice(0, 14)
      .map((m) => `- ${m.file}${m.purpose != null && m.purpose !== '' ? `: ${m.purpose}` : ''}`)
      .join('\n');
    bodyLines.push('Key modules:');
    bodyLines.push(sample);
    if (idx.moduleIndex.length > 14) bodyLines.push('... (more modules omitted)');
  }

  // Ensure we always include the footer marker (agents use it as a delimiter).
  let body = bodyLines.join('\n');
  const budget = maxChars - header.length - footer.length;
  if (budget <= 0) {
    return truncate((header.trimEnd() + footer).slice(0, maxChars), maxChars);
  }

  if (body.length > budget) {
    const suffix = '\n... (truncated)';
    const cut = Math.max(0, budget - suffix.length);
    body = body.slice(0, cut) + suffix;
  }

  return header + body + footer;
}
