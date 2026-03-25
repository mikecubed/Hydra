import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderPresets } from '../lib/hydra-config.ts';

test('getProviderPresets returns array', () => {
  const presets = getProviderPresets();
  assert.ok(Array.isArray(presets));
  assert.ok(presets.length >= 2);
});

test('GLM-5 preset has required fields', () => {
  const presets = getProviderPresets();
  const glm = presets.find((p) => p['name'] === 'glm-5');
  assert.ok(glm, 'glm-5 preset missing');
  assert.ok(glm['label']);
  assert.strictEqual(glm['baseUrl'], 'https://open.bigmodel.cn/api/paas/v4');
  assert.strictEqual(glm['defaultModel'], 'glm-5');
  assert.strictEqual(glm['envKey'], 'GLM_API_KEY');
  assert.ok(glm['description']);
});

test('Kimi K2.5 preset has required fields', () => {
  const presets = getProviderPresets();
  const kimi = presets.find((p) => p['name'] === 'kimi-k2');
  assert.ok(kimi, 'kimi-k2 preset missing');
  assert.strictEqual(kimi['baseUrl'], 'https://api.moonshot.cn/v1');
  assert.strictEqual(kimi['defaultModel'], 'kimi-k2');
  assert.strictEqual(kimi['envKey'], 'MOONSHOT_API_KEY');
});

test('all presets have name, baseUrl, defaultModel, envKey, description', () => {
  for (const preset of getProviderPresets()) {
    assert.ok(preset['name'], `preset missing name: ${JSON.stringify(preset)}`);
    assert.ok(preset['baseUrl']);
    assert.ok(preset['defaultModel']);
    assert.ok(preset['envKey']);
    assert.ok(preset['description']);
  }
});

test('preset can produce a valid customAgent entry shape', () => {
  const presets = getProviderPresets();
  const glm = presets.find((p) => p['name'] === 'glm-5');
  assert.ok(glm, 'glm-5 preset missing');
  const entry = {
    name: 'glm',
    type: 'api' as const,
    baseUrl: glm['baseUrl'],
    model: glm['defaultModel'],
    enabled: true,
  };
  assert.strictEqual(entry.type, 'api');
  assert.ok(entry.baseUrl.startsWith('https://'));
  assert.strictEqual(entry.model, 'glm-5');
});
