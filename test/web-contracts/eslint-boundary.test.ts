/**
 * ESLint boundary enforcement tests for the web initiative.
 *
 * Verifies that eslint-plugin-boundaries is configured with the correct
 * boundary elements and import direction rules for web workspace packages.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

/**
 * Load and parse the ESLint config to extract boundary settings.
 * We import the config dynamically since it's an ESM default export.
 */
async function loadBoundaryConfig(): Promise<{
  elements: Array<{ type: string; pattern: string }>;
  rules: Array<{ from: string; allow: string[] }>;
}> {
  const configPath = resolve(ROOT, 'eslint.config.mjs');
  const configModule = await import(pathToFileURL(configPath).href);
  const configs: unknown[] = configModule.default;

  let elements: Array<{ type: string; pattern: string }> = [];
  let rules: Array<{ from: string; allow: string[] }> = [];

  for (const config of configs) {
    const cfg = config as Record<string, unknown>;
    // Find the boundaries settings block
    if (cfg['settings'] && typeof cfg['settings'] === 'object') {
      const settings = cfg['settings'] as Record<string, unknown>;
      if (settings['boundaries/elements']) {
        elements = settings['boundaries/elements'] as Array<{ type: string; pattern: string }>;
      }
    }
    // Find the boundaries rules block
    if (cfg['rules'] && typeof cfg['rules'] === 'object') {
      const cfgRules = cfg['rules'] as Record<string, unknown>;
      if (cfgRules['boundaries/element-types']) {
        const ruleConfig = cfgRules['boundaries/element-types'] as [
          string,
          { rules: Array<{ from: string; allow: string[] }> },
        ];
        rules = ruleConfig[1].rules;
      }
    }
  }

  return { elements, rules };
}

describe('ESLint boundary enforcement — web initiative', () => {
  it('defines a web-app boundary element for apps/web/**', async () => {
    const { elements } = await loadBoundaryConfig();
    const webApp = elements.find((e) => e.type === 'web-app');
    assert.ok(webApp, 'Expected boundary element with type "web-app"');
    assert.equal(webApp.pattern, 'apps/web/**');
  });

  it('defines a web-gateway boundary element for apps/web-gateway/**', async () => {
    const { elements } = await loadBoundaryConfig();
    const webGateway = elements.find((e) => e.type === 'web-gateway');
    assert.ok(webGateway, 'Expected boundary element with type "web-gateway"');
    assert.equal(webGateway.pattern, 'apps/web-gateway/**');
  });

  it('defines a web-contracts boundary element for packages/web-contracts/**', async () => {
    const { elements } = await loadBoundaryConfig();
    const webContracts = elements.find((e) => e.type === 'web-contracts');
    assert.ok(webContracts, 'Expected boundary element with type "web-contracts"');
    assert.equal(webContracts.pattern, 'packages/web-contracts/**');
  });

  it('web-app may only import from web-contracts', async () => {
    const { rules } = await loadBoundaryConfig();
    const webAppRule = rules.find((r) => r.from === 'web-app');
    assert.ok(webAppRule, 'Expected import direction rule for "web-app"');
    assert.deepEqual(webAppRule.allow, ['web-contracts']);
  });

  it('web-gateway may only import from web-contracts', async () => {
    const { rules } = await loadBoundaryConfig();
    const webGatewayRule = rules.find((r) => r.from === 'web-gateway');
    assert.ok(webGatewayRule, 'Expected import direction rule for "web-gateway"');
    assert.deepEqual(webGatewayRule.allow, ['web-contracts']);
  });

  it('web-contracts has no internal dependencies', async () => {
    const { rules } = await loadBoundaryConfig();
    const webContractsRule = rules.find((r) => r.from === 'web-contracts');
    assert.ok(webContractsRule, 'Expected import direction rule for "web-contracts"');
    assert.deepEqual(webContractsRule.allow, []);
  });

  it('test allow list includes web element types', async () => {
    const { rules } = await loadBoundaryConfig();
    const testRule = rules.find((r) => r.from === 'test');
    assert.ok(testRule, 'Expected import direction rule for "test"');
    assert.ok(testRule.allow.includes('web-app'), 'test should be allowed to import web-app');
    assert.ok(
      testRule.allow.includes('web-gateway'),
      'test should be allowed to import web-gateway',
    );
    assert.ok(
      testRule.allow.includes('web-contracts'),
      'test should be allowed to import web-contracts',
    );
  });
});
