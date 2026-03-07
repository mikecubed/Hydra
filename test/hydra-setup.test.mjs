import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveHydraRoot,
  resolveMcpServerPath,
  resolveNodePath,
  buildMcpServerEntry,
  readJsonFile,
  detectInstalledCLIs,
  mergeClaudeConfig,
  mergeGeminiConfig,
  registerCodexMcp,
  unmergeClaudeConfig,
  unmergeGeminiConfig,
  unregisterCodexMcp,
  generateHydraMdTemplate,
  main,
} from '../lib/hydra-setup.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-setup-test-'));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Export verification ─────────────────────────────────────────────────────

describe('hydra-setup exports', () => {
  it('exports all expected functions', () => {
    assert.strictEqual(typeof resolveHydraRoot, 'function');
    assert.strictEqual(typeof resolveMcpServerPath, 'function');
    assert.strictEqual(typeof resolveNodePath, 'function');
    assert.strictEqual(typeof buildMcpServerEntry, 'function');
    assert.strictEqual(typeof readJsonFile, 'function');
    assert.strictEqual(typeof detectInstalledCLIs, 'function');
    assert.strictEqual(typeof mergeClaudeConfig, 'function');
    assert.strictEqual(typeof mergeGeminiConfig, 'function');
    assert.strictEqual(typeof registerCodexMcp, 'function');
    assert.strictEqual(typeof unmergeClaudeConfig, 'function');
    assert.strictEqual(typeof unmergeGeminiConfig, 'function');
    assert.strictEqual(typeof unregisterCodexMcp, 'function');
    assert.strictEqual(typeof generateHydraMdTemplate, 'function');
    assert.strictEqual(typeof main, 'function');
  });
});

// ── resolveHydraRoot ────────────────────────────────────────────────────────

describe('resolveHydraRoot', () => {
  it('returns an absolute path', () => {
    const root = resolveHydraRoot();
    assert.ok(path.isAbsolute(root));
  });

  it('root directory contains package.json', () => {
    const root = resolveHydraRoot();
    assert.ok(fs.existsSync(path.join(root, 'package.json')));
  });
});

// ── resolveMcpServerPath ────────────────────────────────────────────────────

describe('resolveMcpServerPath', () => {
  it('returns path ending with hydra-mcp-server.mjs', () => {
    const p = resolveMcpServerPath();
    assert.ok(p.endsWith('hydra-mcp-server.mjs'));
  });

  it('uses forward slashes', () => {
    const p = resolveMcpServerPath();
    assert.ok(!p.includes('\\'), `Path should use forward slashes: ${p}`);
  });
});

// ── resolveNodePath ─────────────────────────────────────────────────────────

describe('resolveNodePath', () => {
  it('returns a string', () => {
    const p = resolveNodePath();
    assert.strictEqual(typeof p, 'string');
    assert.ok(p.length > 0);
  });
});

// ── buildMcpServerEntry ─────────────────────────────────────────────────────

describe('buildMcpServerEntry', () => {
  it('returns claude entry with correct structure', () => {
    const entry = buildMcpServerEntry('claude');
    assert.strictEqual(entry.type, 'stdio');
    assert.strictEqual(entry.command, 'node');
    assert.ok(Array.isArray(entry.args));
    assert.ok(entry.args.length >= 1);
    assert.ok(entry.args[0].endsWith('hydra-mcp-server.mjs'));
    assert.ok(!entry.args[0].includes('\\'), 'args should use forward slashes');
    assert.ok('env' in entry);
    assert.deepStrictEqual(entry.env, {});
  });

  it('returns gemini entry with timeout and description', () => {
    const entry = buildMcpServerEntry('gemini');
    assert.strictEqual(entry.command, 'node');
    assert.ok(Array.isArray(entry.args));
    assert.strictEqual(entry.timeout, 600000);
    assert.strictEqual(typeof entry.description, 'string');
    // Gemini entries should NOT have 'type' field
    assert.strictEqual(entry.type, undefined);
  });

  it('returns codex entry as array for CLI command', () => {
    const entry = buildMcpServerEntry('codex');
    assert.ok(Array.isArray(entry));
    assert.strictEqual(entry[0], 'node');
    assert.ok(entry[1].endsWith('hydra-mcp-server.mjs'));
  });
});

// ── readJsonFile ────────────────────────────────────────────────────────────

describe('readJsonFile', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  it('returns {} for missing file', () => {
    const result = readJsonFile(path.join(tmpDir, 'nonexistent.json'));
    assert.deepStrictEqual(result, {});
  });

  it('returns {} for invalid JSON', () => {
    const fpath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(fpath, 'not json at all {{{', 'utf8');
    const result = readJsonFile(fpath);
    assert.deepStrictEqual(result, {});
  });

  it('reads valid JSON', () => {
    const fpath = path.join(tmpDir, 'good.json');
    const data = { foo: 'bar', num: 42 };
    fs.writeFileSync(fpath, JSON.stringify(data), 'utf8');
    const result = readJsonFile(fpath);
    assert.deepStrictEqual(result, data);
  });

  it('returns {} for empty file', () => {
    const fpath = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(fpath, '', 'utf8');
    const result = readJsonFile(fpath);
    assert.deepStrictEqual(result, {});
  });
});

// ── detectInstalledCLIs ─────────────────────────────────────────────────────

describe('detectInstalledCLIs', () => {
  it('returns an object with claude, gemini, codex keys', () => {
    const result = detectInstalledCLIs();
    assert.ok('claude' in result);
    assert.ok('gemini' in result);
    assert.ok('codex' in result);
  });

  it('each value is a boolean', () => {
    const result = detectInstalledCLIs();
    assert.strictEqual(typeof result.claude, 'boolean');
    assert.strictEqual(typeof result.gemini, 'boolean');
    assert.strictEqual(typeof result.codex, 'boolean');
  });
});

// ── mergeClaudeConfig ───────────────────────────────────────────────────────

describe('mergeClaudeConfig', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = path.join(tmpDir, '.claude.json');
  });
  afterEach(() => { rmDir(tmpDir); });

  it('adds hydra to empty config', () => {
    const result = mergeClaudeConfig({ configPath });
    assert.strictEqual(result.status, 'added');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcpServers);
    assert.ok(config.mcpServers.hydra);
    assert.strictEqual(config.mcpServers.hydra.type, 'stdio');
    assert.strictEqual(config.mcpServers.hydra.command, 'node');
  });

  it('adds hydra to config with no mcpServers key', () => {
    fs.writeFileSync(configPath, JSON.stringify({ otherKey: true }), 'utf8');
    const result = mergeClaudeConfig({ configPath });
    assert.strictEqual(result.status, 'added');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcpServers.hydra);
    assert.strictEqual(config.otherKey, true); // preserved
  });

  it('skips if hydra entry already exists (no --force)', () => {
    // First add
    mergeClaudeConfig({ configPath });
    // Second add
    const result = mergeClaudeConfig({ configPath });
    assert.strictEqual(result.status, 'exists');
  });

  it('overwrites if --force is set', () => {
    mergeClaudeConfig({ configPath });
    const result = mergeClaudeConfig({ configPath, force: true });
    assert.strictEqual(result.status, 'updated');
  });

  it('preserves other MCP server entries', () => {
    const existing = {
      mcpServers: {
        other_server: { type: 'stdio', command: 'other', args: [] },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    mergeClaudeConfig({ configPath });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcpServers.other_server);
    assert.ok(config.mcpServers.hydra);
    assert.strictEqual(config.mcpServers.other_server.command, 'other');
  });
});

// ── mergeGeminiConfig ───────────────────────────────────────────────────────

describe('mergeGeminiConfig', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = path.join(tmpDir, 'settings.json');
  });
  afterEach(() => { rmDir(tmpDir); });

  it('creates file if missing and adds hydra', () => {
    const result = mergeGeminiConfig({ configPath });
    assert.strictEqual(result.status, 'added');

    assert.ok(fs.existsSync(configPath));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcpServers.hydra);
    assert.strictEqual(config.mcpServers.hydra.command, 'node');
    assert.strictEqual(config.mcpServers.hydra.timeout, 600000);
  });

  it('skips if hydra entry already exists', () => {
    mergeGeminiConfig({ configPath });
    const result = mergeGeminiConfig({ configPath });
    assert.strictEqual(result.status, 'exists');
  });

  it('overwrites if --force is set', () => {
    mergeGeminiConfig({ configPath });
    const result = mergeGeminiConfig({ configPath, force: true });
    assert.strictEqual(result.status, 'updated');
  });

  it('preserves other entries', () => {
    const existing = {
      mcpServers: {
        other: { command: 'python', args: ['server.py'] },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    mergeGeminiConfig({ configPath });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcpServers.other);
    assert.ok(config.mcpServers.hydra);
  });
});

// ── unmergeClaudeConfig ─────────────────────────────────────────────────────

describe('unmergeClaudeConfig', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = path.join(tmpDir, '.claude.json');
  });
  afterEach(() => { rmDir(tmpDir); });

  it('removes hydra entry', () => {
    mergeClaudeConfig({ configPath });
    const result = unmergeClaudeConfig({ configPath });
    assert.strictEqual(result.status, 'removed');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(config.mcpServers.hydra, undefined);
  });

  it('returns not_found if hydra entry absent', () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const result = unmergeClaudeConfig({ configPath });
    assert.strictEqual(result.status, 'not_found');
  });

  it('returns not_found if config file does not exist', () => {
    const result = unmergeClaudeConfig({ configPath });
    assert.strictEqual(result.status, 'not_found');
  });

  it('preserves other entries after removal', () => {
    const existing = {
      mcpServers: {
        hydra: { type: 'stdio', command: 'node', args: [] },
        other: { type: 'stdio', command: 'other', args: [] },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    unmergeClaudeConfig({ configPath });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(config.mcpServers.hydra, undefined);
    assert.ok(config.mcpServers.other);
  });
});

// ── unmergeGeminiConfig ─────────────────────────────────────────────────────

describe('unmergeGeminiConfig', () => {
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    configPath = path.join(tmpDir, 'settings.json');
  });
  afterEach(() => { rmDir(tmpDir); });

  it('removes hydra entry', () => {
    mergeGeminiConfig({ configPath });
    const result = unmergeGeminiConfig({ configPath });
    assert.strictEqual(result.status, 'removed');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(config.mcpServers.hydra, undefined);
  });

  it('returns not_found if hydra entry absent', () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const result = unmergeGeminiConfig({ configPath });
    assert.strictEqual(result.status, 'not_found');
  });

  it('returns not_found if config file does not exist', () => {
    const result = unmergeGeminiConfig({ configPath });
    assert.strictEqual(result.status, 'not_found');
  });

  it('preserves other entries after removal', () => {
    const existing = {
      mcpServers: {
        hydra: { command: 'node', args: [], timeout: 600000 },
        other: { command: 'python', args: ['server.py'] },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existing), 'utf8');

    unmergeGeminiConfig({ configPath });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(config.mcpServers.hydra, undefined);
    assert.ok(config.mcpServers.other);
  });
});

// ── generateHydraMdTemplate ─────────────────────────────────────────────────

describe('generateHydraMdTemplate', () => {
  it('returns a non-empty string', () => {
    const template = generateHydraMdTemplate();
    assert.strictEqual(typeof template, 'string');
    assert.ok(template.length > 0);
  });

  it('includes HYDRA.md header', () => {
    const template = generateHydraMdTemplate();
    assert.ok(template.includes('# HYDRA.md'));
  });

  it('includes agent section headings', () => {
    const template = generateHydraMdTemplate();
    assert.ok(template.includes('## @claude'));
    assert.ok(template.includes('## @gemini'));
    assert.ok(template.includes('## @codex'));
  });

  it('accepts projectName option', () => {
    const template = generateHydraMdTemplate({ projectName: 'MyProject' });
    assert.ok(template.includes('MyProject'));
  });
});

// ── registerCodexMcp / unregisterCodexMcp ───────────────────────────────────

describe('registerCodexMcp', () => {
  it('returns an object with status', () => {
    // This calls `codex mcp add` which may fail if codex is not installed
    const result = registerCodexMcp();
    assert.ok('status' in result);
    assert.ok(['added', 'error'].includes(result.status));
  });
});

describe('unregisterCodexMcp', () => {
  it('returns an object with status', () => {
    const result = unregisterCodexMcp();
    assert.ok('status' in result);
    assert.ok(['removed', 'error', 'not_found'].includes(result.status));
  });
});
