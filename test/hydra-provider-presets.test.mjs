import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderPresets } from '../lib/hydra-config.mjs';

test('getProviderPresets returns array', () => {
  const presets = getProviderPresets();
  assert.ok(Array.isArray(presets));
  assert.ok(presets.length >= 2);
});

test('GLM-5 preset has required fields', () => {
  const presets = getProviderPresets();
  const glm = presets.find(p => p.name === 'glm-5');
  assert.ok(glm, 'glm-5 preset missing');
  assert.ok(glm.label);
  assert.ok(glm.baseUrl.startsWith('https://'));
  assert.ok(glm.defaultModel);
  assert.ok(glm.envKey);
  assert.ok(glm.description);
});

test('Kimi K2.5 preset has required fields', () => {
  const presets = getProviderPresets();
  const kimi = presets.find(p => p.name === 'kimi-k2');
  assert.ok(kimi, 'kimi-k2 preset missing');
  assert.ok(kimi.baseUrl.startsWith('https://'));
  assert.ok(kimi.defaultModel);
  assert.ok(kimi.envKey);
});

test('all presets have name, baseUrl, defaultModel, envKey, description', () => {
  for (const preset of getProviderPresets()) {
    assert.ok(preset.name, `preset missing name: ${JSON.stringify(preset)}`);
    assert.ok(preset.baseUrl);
    assert.ok(preset.defaultModel);
    assert.ok(preset.envKey);
    assert.ok(preset.description);
  }
});
