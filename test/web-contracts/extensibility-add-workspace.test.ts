/**
 * Extensibility test: Simulated workspace package addition.
 *
 * Proves that a new workspace package (e.g., packages/web-ui/) can be added
 * without modifying the root workspaces glob, ESLint boundary patterns, or
 * root tsconfig.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * Simple glob match check — verifies that a path would be covered
 * by a workspace glob pattern.
 */
function matchesWorkspaceGlob(globs: string[], path: string): boolean {
  return globs.some((glob) => {
    // Convert npm workspace glob "apps/*" to match "apps/new-app"
    const pattern = glob.endsWith('/*') ? `${glob.slice(0, -2)}/` : glob;
    return path.startsWith(pattern) || path.match(new RegExp(`^${glob.replaceAll('*', '[^/]+')}$`));
  });
}

interface PackageJson {
  workspaces?: string[];
}

interface TsconfigJson {
  compilerOptions?: {
    target?: string;
    module?: string;
  };
  include?: string[];
}

describe('Extensibility — simulated workspace package addition', () => {
  it('root package.json workspaces glob covers new packages under apps/', async () => {
    const pkgPath = resolve(ROOT, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as PackageJson;

    assert.ok(Array.isArray(pkg.workspaces), 'package.json must have workspaces array');
    assert.ok(pkg.workspaces.includes('apps/*'), 'workspaces must include "apps/*"');

    // A new app like apps/web-admin would be covered
    assert.ok(matchesWorkspaceGlob(pkg.workspaces, 'apps/web-admin'));
  });

  it('root package.json workspaces glob covers new packages under packages/', async () => {
    const pkgPath = resolve(ROOT, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as PackageJson;

    assert.ok(Array.isArray(pkg.workspaces), 'package.json must have workspaces array');
    assert.ok(pkg.workspaces.includes('packages/*'), 'workspaces must include "packages/*"');

    // A new package like packages/web-ui would be covered
    assert.ok(matchesWorkspaceGlob(pkg.workspaces, 'packages/web-ui'));
  });

  it('ESLint boundary pattern for web-contracts does not interfere with sibling packages', async () => {
    const configPath = resolve(ROOT, 'eslint.config.mjs');
    const configModule = await import(configPath);
    const configs: unknown[] = configModule.default;

    let elements: Array<{ type: string; pattern: string }> = [];
    for (const config of configs) {
      const cfg = config as Record<string, unknown>;
      if (cfg['settings'] && typeof cfg['settings'] === 'object') {
        const settings = cfg['settings'] as Record<string, unknown>;
        if (settings['boundaries/elements']) {
          elements = settings['boundaries/elements'] as Array<{ type: string; pattern: string }>;
        }
      }
    }

    const webContractsPattern = elements.find((e) => e.type === 'web-contracts')?.pattern;
    assert.ok(webContractsPattern, 'web-contracts boundary element must exist');

    // web-contracts pattern should be scoped to packages/web-contracts/**
    // and should NOT match packages/web-ui/
    assert.equal(webContractsPattern, 'packages/web-contracts/**');
    assert.ok(
      !webContractsPattern.startsWith('packages/**'),
      'Pattern must be scoped, not catch-all',
    );
  });

  it('root tsconfig includes patterns cover new workspace packages', async () => {
    const tsconfigPath = resolve(ROOT, 'tsconfig.json');
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8')) as TsconfigJson;

    assert.ok(Array.isArray(tsconfig.include), 'tsconfig must have include array');

    // Check that packages/**/*.ts and apps/**/*.ts are included
    assert.ok(
      tsconfig.include.includes('packages/**/*.ts'),
      'tsconfig must include packages/**/*.ts',
    );
    assert.ok(tsconfig.include.includes('apps/**/*.ts'), 'tsconfig must include apps/**/*.ts');
  });

  it('new workspace tsconfig can extend root without root modification', async () => {
    const tsconfigPath = resolve(ROOT, 'tsconfig.json');
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8')) as TsconfigJson;

    // Verify the root tsconfig can be extended — it has compilerOptions
    assert.ok(tsconfig.compilerOptions, 'root tsconfig must have compilerOptions for extension');
    assert.ok(tsconfig.compilerOptions.target, 'root tsconfig must specify target');
    assert.ok(tsconfig.compilerOptions.module, 'root tsconfig must specify module');
  });
});
