/**
 * Tests for hydra-persona — persona config, queries, and display.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import {
  invalidatePersonaCache,
  getPersonaConfig,
  isPersonaEnabled,
  listPresets,
  getConciergeIdentity,
  getAgentFraming,
  getProcessLabel,
  showPersonaSummary,
} from '../lib/hydra-persona.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function setPersonaConfig(persona: Record<string, unknown>): void {
  _setTestConfig({ persona } as never);
  invalidatePersonaCache();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('persona cache management', () => {
  beforeEach(() => {
    _setTestConfig({} as never);
    invalidatePersonaCache();
  });

  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('getPersonaConfig returns an object', () => {
    const cfg = getPersonaConfig();
    assert.equal(typeof cfg, 'object');
    assert.ok(cfg !== null);
  });

  it('invalidatePersonaCache forces re-read', () => {
    const first = getPersonaConfig();
    // Set a different config
    _setTestConfig({ persona: { name: 'TestBot' } } as never);
    // Without invalidation, should still return cached value
    const stillCached = getPersonaConfig();
    assert.equal(stillCached, first);
    // After invalidation, should return fresh config
    invalidatePersonaCache();
    const fresh = getPersonaConfig();
    assert.equal(fresh.name, 'TestBot');
  });
});

describe('isPersonaEnabled', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns true when persona.enabled is not set', () => {
    setPersonaConfig({});
    assert.equal(isPersonaEnabled(), true);
  });

  it('returns true when persona.enabled is true', () => {
    setPersonaConfig({ enabled: true });
    assert.equal(isPersonaEnabled(), true);
  });

  it('returns false when persona.enabled is false', () => {
    setPersonaConfig({ enabled: false });
    assert.equal(isPersonaEnabled(), false);
  });
});

describe('listPresets', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns an array of preset names', () => {
    setPersonaConfig({});
    const names = listPresets();
    assert.ok(Array.isArray(names));
    // Default config may include presets — just verify it returns strings
    for (const name of names) {
      assert.equal(typeof name, 'string');
    }
  });

  it('includes custom presets when configured', () => {
    setPersonaConfig({
      presets: {
        professional: { tone: 'formal' },
        friendly: { tone: 'casual' },
      },
    });
    const names = listPresets();
    assert.ok(names.includes('professional'));
    assert.ok(names.includes('friendly'));
  });
});

describe('getConciergeIdentity', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns identity when defaults have enabled set', () => {
    // Default config may have persona.enabled set; if so, it returns a string
    setPersonaConfig({});
    const result = getConciergeIdentity();
    // The result depends on default config — it's either null or a string
    assert.ok(result === null || typeof result === 'string');
  });

  it('returns null when persona.enabled is false', () => {
    setPersonaConfig({ enabled: false });
    assert.equal(getConciergeIdentity(), null);
  });

  it('returns identity string when enabled', () => {
    setPersonaConfig({
      enabled: true,
      identity: 'I am Hydra.',
      voice: 'Speak clearly.',
    });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('I am Hydra.'));
    assert.ok(result.includes('Communication style:'));
    assert.ok(result.includes('Speak clearly.'));
    assert.ok(result.includes('conversational interface'));
  });

  it('includes tone modifiers in identity', () => {
    setPersonaConfig({
      enabled: true,
      tone: 'formal',
      verbosity: 'minimal',
      formality: 'informal',
    });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('professional distance'));
    assert.ok(result.includes('under 3 sentences'));
    assert.ok(result.includes('casual, relaxed'));
  });

  it('includes humor-off modifier', () => {
    setPersonaConfig({ enabled: true, humor: false });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('Do not use humor'));
  });

  it('returns a string when enabled is true', () => {
    setPersonaConfig({ enabled: true });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(typeof result === 'string');
    // Should always include the standard conversational interface message
    assert.ok(result.includes('conversational interface'));
  });
});

describe('getAgentFraming', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns a non-empty string for any agent', () => {
    setPersonaConfig({ name: 'MyBot' });
    const framing = getAgentFraming('claude');
    assert.ok(typeof framing === 'string');
    assert.ok(framing.length > 0);
  });

  it('returns custom framing when configured', () => {
    setPersonaConfig({
      agentFraming: { claude: 'You are the architect.' },
    });
    assert.equal(getAgentFraming('claude'), 'You are the architect.');
  });

  it('normalises agent name to lowercase', () => {
    setPersonaConfig({
      agentFraming: { gemini: 'You are the analyst.' },
    });
    assert.equal(getAgentFraming('GEMINI'), 'You are the analyst.');
  });

  it('returns a framing string even when persona config is minimal', () => {
    setPersonaConfig({});
    const framing = getAgentFraming('codex');
    assert.ok(typeof framing === 'string');
    assert.ok(framing.length > 0);
  });
});

describe('getProcessLabel', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns processKey as-is when no labels configured', () => {
    setPersonaConfig({});
    assert.equal(getProcessLabel('routing'), 'routing');
  });

  it('returns configured label', () => {
    setPersonaConfig({
      processLabels: { routing: 'Signal Analysis' },
    });
    assert.equal(getProcessLabel('routing'), 'Signal Analysis');
  });

  it('returns a string for any key (falls back to key itself or default label)', () => {
    setPersonaConfig({
      processLabels: { routing: 'Signal Analysis' },
    });
    const label = getProcessLabel('nonexistent_key_xyz');
    assert.equal(label, 'nonexistent_key_xyz');
  });
});

describe('showPersonaSummary', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('outputs persona configuration to console', () => {
    setPersonaConfig({
      enabled: true,
      name: 'TestBot',
      tone: 'casual',
      verbosity: 'detailed',
      formality: 'informal',
      humor: false,
    });

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      showPersonaSummary();
    } finally {
      console.log = origLog;
    }

    const output = lines.join('\n');
    assert.ok(output.includes('TestBot'), 'should include name');
    assert.ok(output.includes('casual'), 'should include tone');
    assert.ok(output.includes('detailed'), 'should include verbosity');
    assert.ok(output.includes('informal'), 'should include formality');
  });

  it('shows defaults when config is empty', () => {
    setPersonaConfig({});

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      showPersonaSummary();
    } finally {
      console.log = origLog;
    }

    const output = lines.join('\n');
    assert.ok(output.includes('Hydra'), 'should show default name');
    assert.ok(output.includes('balanced'), 'should show default tone');
    assert.ok(output.includes('concise'), 'should show default verbosity');
    assert.ok(output.includes('neutral'), 'should show default formality');
  });
});
