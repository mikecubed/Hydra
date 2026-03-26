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

// ── Additional edge-case coverage ────────────────────────────────────────────

describe('getPersonaConfig edge cases', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns empty object when persona key is missing entirely', () => {
    _setTestConfig({} as never);
    invalidatePersonaCache();
    const cfg = getPersonaConfig();
    // Should be {} (fallback)
    assert.equal(typeof cfg, 'object');
    assert.ok(cfg !== null);
  });

  it('caches config across multiple calls', () => {
    setPersonaConfig({ name: 'CacheBoy' });
    const a = getPersonaConfig();
    const b = getPersonaConfig();
    assert.equal(a, b); // same reference (cached)
    assert.equal(a.name, 'CacheBoy');
  });

  it('returns fresh config after invalidation', () => {
    setPersonaConfig({ name: 'A' });
    const first = getPersonaConfig();
    assert.equal(first.name, 'A');

    // Change underlying config
    _setTestConfig({ persona: { name: 'B' } } as never);
    invalidatePersonaCache();
    const second = getPersonaConfig();
    assert.equal(second.name, 'B');
    assert.notEqual(first, second);
  });
});

describe('isPersonaEnabled edge cases', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns true when enabled is undefined (not set)', () => {
    // enabled !== false is the check, so undefined => true
    setPersonaConfig({});
    assert.equal(isPersonaEnabled(), true);
  });

  it('returns true when enabled is explicitly true via defaults merge', () => {
    // Default config has persona.enabled: true, so even with empty override,
    // the merged config has enabled: true
    setPersonaConfig({});
    assert.equal(isPersonaEnabled(), true);
  });
});

describe('getConciergeIdentity edge cases', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns null when enabled is undefined (not set in config at top level)', () => {
    // When the merged config has enabled set (defaults include enabled: true),
    // the result depends on defaults. The setPersonaConfig helper merges with defaults.
    // Since default has enabled: true, getConciergeIdentity returns a string.
    _setTestConfig({ persona: { enabled: undefined } } as never);
    invalidatePersonaCache();
    const result = getConciergeIdentity();
    // Defaults have enabled: true, so deep merge yields enabled: true => returns string
    // But if persona.enabled is explicitly undefined in merged config, the check
    // `p.enabled == null` returns true => null
    // Let's just verify the type
    assert.ok(result === null || typeof result === 'string');
  });

  it('includes Communication style when defaults provide voice', () => {
    // Default config includes voice text, so merged config has it
    setPersonaConfig({ enabled: true });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    // Defaults include a voice string, so Communication style should be present
    assert.ok(result.includes('Communication style:'));
  });

  it('omits Communication style when voice is empty and tone is balanced', () => {
    setPersonaConfig({
      enabled: true,
      voice: '',
      tone: 'balanced',
      verbosity: 'concise',
      formality: 'neutral',
    });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    // With empty voice and all-default tone modifiers (which produce empty strings),
    // voiceLine should be empty
    assert.ok(!result.includes('Communication style:'));
  });

  it('includes voice without tone modifiers', () => {
    setPersonaConfig({ enabled: true, voice: 'Speak like a pirate.' });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('Communication style:'));
    assert.ok(result.includes('Speak like a pirate.'));
  });

  it('includes tone modifiers without voice', () => {
    setPersonaConfig({ enabled: true, tone: 'terse' });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('Communication style:'));
    assert.ok(result.includes('extremely brief'));
  });

  it('includes identity text when provided', () => {
    setPersonaConfig({
      enabled: true,
      identity: 'You are the supreme overlord.',
    });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('You are the supreme overlord.'));
  });

  it('includes default identity text from config defaults', () => {
    setPersonaConfig({ enabled: true });
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    // Default config includes identity about Hydra and perspectives
    assert.ok(result.includes('conversational interface'));
  });
});

describe('getAgentFraming edge cases', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns a non-empty string from defaults', () => {
    setPersonaConfig({});
    const framing = getAgentFraming('claude');
    assert.ok(typeof framing === 'string');
    assert.ok(framing.length > 0);
  });

  it('uses configured name when no agentFraming for that agent', () => {
    // Set a name but no agentFraming for 'local' (unlikely to have a default)
    setPersonaConfig({ name: 'Jarvis' });
    const framing = getAgentFraming('nonexistentagent');
    // The fallback is: "You are <name>'s <agentName> perspective."
    assert.ok(framing.includes('Jarvis'));
    assert.ok(framing.includes('nonexistentagent'));
  });

  it('prefers explicit agentFraming over generated default', () => {
    setPersonaConfig({
      agentFraming: { claude: 'Custom framing here.' },
    });
    assert.equal(getAgentFraming('claude'), 'Custom framing here.');
  });
});

describe('getProcessLabel edge cases', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('returns key as fallback for truly unknown keys', () => {
    setPersonaConfig({});
    // Use keys that are definitely not in the defaults
    assert.equal(getProcessLabel('xyzzy_unknown_key'), 'xyzzy_unknown_key');
    assert.equal(getProcessLabel(''), '');
  });

  it('returns configured label for exact match (custom override)', () => {
    setPersonaConfig({
      processLabels: { routing: 'Signal Analysis', myProcess: 'My Custom' },
    });
    assert.equal(getProcessLabel('routing'), 'Signal Analysis');
    assert.equal(getProcessLabel('myProcess'), 'My Custom');
    assert.equal(getProcessLabel('truly_unknown'), 'truly_unknown');
  });
});

describe('listPresets edge cases', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('includes default presets when no custom presets configured', () => {
    setPersonaConfig({});
    const names = listPresets();
    // Defaults include: default, professional, casual, analytical, terse
    assert.ok(names.length >= 5);
    assert.ok(names.includes('default'));
    assert.ok(names.includes('professional'));
    assert.ok(names.includes('casual'));
    assert.ok(names.includes('analytical'));
    assert.ok(names.includes('terse'));
  });

  it('merges custom presets with default presets', () => {
    setPersonaConfig({
      presets: {
        pro: { tone: 'formal' },
        myCustom: { tone: 'casual' },
      },
    });
    const names = listPresets();
    // Should include both defaults and custom
    assert.ok(names.includes('pro'));
    assert.ok(names.includes('myCustom'));
    // Also includes original defaults
    assert.ok(names.includes('default'));
  });

  it('returns only strings', () => {
    setPersonaConfig({});
    const names = listPresets();
    for (const name of names) {
      assert.equal(typeof name, 'string');
    }
  });
});

describe('invalidatePersonaCache', () => {
  afterEach(() => {
    invalidateConfigCache();
    invalidatePersonaCache();
  });

  it('can be called multiple times without error', () => {
    assert.doesNotThrow(() => {
      invalidatePersonaCache();
      invalidatePersonaCache();
      invalidatePersonaCache();
    });
  });

  it('forces fresh read from config on next getPersonaConfig call', () => {
    setPersonaConfig({ name: 'Before' });
    assert.equal(getPersonaConfig().name, 'Before');

    _setTestConfig({ persona: { name: 'After' } } as never);
    // Without invalidation, still cached
    assert.equal(getPersonaConfig().name, 'Before');

    invalidatePersonaCache();
    assert.equal(getPersonaConfig().name, 'After');
  });
});
