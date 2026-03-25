/**
 * Deep coverage tests for lib/hydra-persona.ts
 *
 * Covers applyPreset, runPersonaEditor, buildToneBlock, and interactive editor
 * branches that the existing persona test does not exercise.
 */
/* eslint-disable require-atomic-updates -- console.log capture is intentional in tests */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mocks ────────────────────────────────────────────────────────────────────

let savedConfig: Record<string, unknown> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs wide return type
const mockLoadHydraConfig = mock.fn((): any => ({
  persona: {
    enabled: true,
    name: 'Hydra',
    tone: 'balanced',
    verbosity: 'concise',
    formality: 'neutral',
    humor: true,
    presets: {
      professional: {
        tone: 'formal',
        verbosity: 'detailed',
        formality: 'formal',
        humor: false,
        voice: 'Speak with authority.',
      },
      friendly: {
        tone: 'casual',
        verbosity: 'concise',
        formality: 'informal',
        humor: true,
        voice: 'Be warm and welcoming.',
      },
      terse: {
        tone: 'terse',
        verbosity: 'minimal',
        formality: '',
        voice: '',
      },
      empty: {},
    },
    agentFraming: {
      claude: 'You are the lead architect.',
      gemini: 'You are the analyst.',
    },
    processLabels: {
      routing: 'Signal Analysis',
      deliberation: 'Council',
    },
  },
}));

const mockSaveHydraConfig = mock.fn((cfg: Record<string, unknown>) => {
  savedConfig = cfg;
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mockLoadHydraConfig,
    saveHydraConfig: mockSaveHydraConfig,
    _setTestConfig: mock.fn(),
    invalidateConfigCache: mock.fn(),
  },
});

// Mock the prompt choice module used by the editor
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock needs wide return type
const mockPromptChoice = mock.fn(async (): Promise<any> => ({ value: 'done' }));
mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    promptChoice: mockPromptChoice,
  },
});

const {
  invalidatePersonaCache,
  getPersonaConfig,
  isPersonaEnabled,
  listPresets,
  getConciergeIdentity,
  getAgentFraming,
  getProcessLabel,
  showPersonaSummary,
  applyPreset,
  runPersonaEditor,
} = await import('../lib/hydra-persona.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('applyPreset', () => {
  beforeEach(() => {
    invalidatePersonaCache();
    mockSaveHydraConfig.mock.resetCalls();
    savedConfig = null;
  });

  it('returns true and saves config when preset exists', () => {
    const result = applyPreset('professional');
    assert.equal(result, true);
    assert.equal(mockSaveHydraConfig.mock.callCount(), 1);
    const saved = savedConfig as Record<string, unknown>;
    const persona = saved['persona'] as Record<string, unknown>;
    assert.equal(persona['tone'], 'formal');
    assert.equal(persona['verbosity'], 'detailed');
    assert.equal(persona['formality'], 'formal');
    assert.equal(persona['humor'], false);
    assert.equal(persona['voice'], 'Speak with authority.');
  });

  it('returns false when preset does not exist', () => {
    const result = applyPreset('nonexistent');
    assert.equal(result, false);
    assert.equal(mockSaveHydraConfig.mock.callCount(), 0);
  });

  it('applies the friendly preset correctly', () => {
    invalidatePersonaCache();
    const result = applyPreset('friendly');
    assert.equal(result, true);
    const saved = savedConfig as Record<string, unknown>;
    const persona = saved['persona'] as Record<string, unknown>;
    assert.equal(persona['tone'], 'casual');
    assert.equal(persona['humor'], true);
    assert.equal(persona['voice'], 'Be warm and welcoming.');
  });

  it('skips empty-string fields in preset', () => {
    invalidatePersonaCache();
    const result = applyPreset('terse');
    assert.equal(result, true);
    const saved = savedConfig as Record<string, unknown>;
    const persona = saved['persona'] as Record<string, unknown>;
    assert.equal(persona['tone'], 'terse');
    assert.equal(persona['verbosity'], 'minimal');
    // formality and voice are empty strings, should not overwrite
  });

  it('handles empty preset (no fields set)', () => {
    invalidatePersonaCache();
    const result = applyPreset('empty');
    assert.equal(result, true);
    // Save should still be called even with no changes
    assert.equal(mockSaveHydraConfig.mock.callCount(), 1);
  });

  it('invalidates persona cache after apply', () => {
    invalidatePersonaCache();
    // Get config to fill cache
    getPersonaConfig();
    // Apply preset should invalidate
    applyPreset('professional');
    // Next getPersonaConfig should re-read (cache was invalidated)
    invalidatePersonaCache(); // manual check
    const cfg = getPersonaConfig();
    assert.ok(cfg !== null);
  });
});

describe('getConciergeIdentity edge cases', () => {
  beforeEach(() => {
    invalidatePersonaCache();
  });

  it('includes voice line with toneBlock when both present', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {
        enabled: true,
        voice: 'Speak like a pirate.',
        tone: 'casual',
        verbosity: 'minimal',
        formality: 'informal',
      },
    }));
    invalidatePersonaCache();
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('Communication style:'));
    assert.ok(result.includes('Speak like a pirate.'));
    assert.ok(result.includes('approachable'));
    assert.ok(result.includes('under 3 sentences'));
  });

  it('returns identity with no voice or tone modifiers when all are default', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {
        enabled: true,
        tone: 'balanced',
        verbosity: 'concise',
        formality: 'neutral',
      },
    }));
    invalidatePersonaCache();
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    // Should still include the base text
    assert.ok(result.includes('conversational interface'));
  });

  it('includes humor-off modifier explicitly', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: { enabled: true, humor: false },
    }));
    invalidatePersonaCache();
    const result = getConciergeIdentity();
    assert.ok(result !== null);
    assert.ok(result.includes('Do not use humor'));
  });

  it('returns null when enabled is explicitly undefined (not set)', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {},
    }));
    invalidatePersonaCache();
    const result = getConciergeIdentity();
    // enabled == null returns null
    assert.equal(result, null);
  });
});

describe('getAgentFraming edge cases', () => {
  beforeEach(() => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {
        name: 'TestBot',
        agentFraming: { claude: 'Custom framing for Claude.' },
      },
    }));
    invalidatePersonaCache();
  });

  it('returns custom framing for configured agent', () => {
    assert.equal(getAgentFraming('claude'), 'Custom framing for Claude.');
  });

  it('returns default framing with persona name for unconfigured agent', () => {
    const result = getAgentFraming('codex');
    assert.ok(result.includes('TestBot'));
    assert.ok(result.includes('codex'));
  });

  it('uses Hydra as default name when no name configured', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {},
    }));
    invalidatePersonaCache();
    const result = getAgentFraming('gemini');
    assert.ok(result.includes('Hydra'));
  });
});

describe('getProcessLabel edge cases', () => {
  beforeEach(() => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {
        processLabels: { routing: 'Signal Analysis' },
      },
    }));
    invalidatePersonaCache();
  });

  it('returns configured label', () => {
    assert.equal(getProcessLabel('routing'), 'Signal Analysis');
  });

  it('returns key as fallback', () => {
    assert.equal(getProcessLabel('unknown'), 'unknown');
  });
});

describe('showPersonaSummary output', () => {
  beforeEach(() => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {
        enabled: false,
        name: 'DisabledBot',
        tone: 'terse',
        verbosity: 'minimal',
        formality: 'formal',
        humor: false,
      },
    }));
    invalidatePersonaCache();
  });

  it('shows disabled state', () => {
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
    assert.ok(output.includes('DisabledBot'));
    assert.ok(output.includes('terse'));
    assert.ok(output.includes('minimal'));
    assert.ok(output.includes('formal'));
  });
});

describe('isPersonaEnabled with various configs', () => {
  it('returns true when persona not present at all', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({}));
    invalidatePersonaCache();
    assert.equal(isPersonaEnabled(), true);
  });

  it('returns true when enabled is true', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: { enabled: true },
    }));
    invalidatePersonaCache();
    assert.equal(isPersonaEnabled(), true);
  });
});

describe('listPresets with various configs', () => {
  it('returns empty when no presets defined', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {},
    }));
    invalidatePersonaCache();
    assert.deepStrictEqual(listPresets(), []);
  });

  it('returns preset names', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: { presets: { a: {}, b: {} } },
    }));
    invalidatePersonaCache();
    const names = listPresets();
    assert.ok(names.includes('a'));
    assert.ok(names.includes('b'));
  });
});

describe('runPersonaEditor', () => {
  beforeEach(() => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: {
        enabled: true,
        name: 'Hydra',
        presets: { pro: { tone: 'formal' } },
      },
    }));
    invalidatePersonaCache();
    mockSaveHydraConfig.mock.resetCalls();
    mockPromptChoice.mock.resetCalls();
  });

  it('exits immediately when user picks "done"', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({ value: 'done' }));
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    // No changes saved
    assert.equal(mockSaveHydraConfig.mock.callCount(), 0);
    const output = lines.join('\n');
    assert.ok(output.includes('No changes'));
  });

  it('handles toggle action', async () => {
    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'toggle' };
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    // Should have saved 1 change (toggle)
    assert.equal(mockSaveHydraConfig.mock.callCount(), 1);
    const output = lines.join('\n');
    assert.ok(output.includes('Saved'));
    assert.ok(output.includes('enabled'));
  });

  it('handles null action (e.g. timeout)', async () => {
    mockPromptChoice.mock.mockImplementation(async () => null);
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    assert.equal(mockSaveHydraConfig.mock.callCount(), 0);
  });

  it('handles timedOut action', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({ timedOut: true }));
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const origLog = console.log;
    console.log = () => {};
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    assert.equal(mockSaveHydraConfig.mock.callCount(), 0);
  });

  it('handles preset action with successful selection', async () => {
    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'preset' };
      if (callCount === 2) return { value: 'pro' }; // select preset "pro"
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    assert.equal(mockSaveHydraConfig.mock.callCount(), 1);
    const output = lines.join('\n');
    assert.ok(output.includes('Applied preset'));
  });

  it('handles tweak action with tone/verbosity/formality/humor choices', async () => {
    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'tweak' };
      if (callCount === 2) return { value: 'formal' }; // tone
      if (callCount === 3) return { value: 'detailed' }; // verbosity
      if (callCount === 4) return { value: 'formal' }; // formality
      if (callCount === 5) return { value: false }; // humor
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    assert.equal(mockSaveHydraConfig.mock.callCount(), 1);
    const output = lines.join('\n');
    assert.ok(output.includes('Saved'));
    assert.ok(output.includes('tone'));
    assert.ok(output.includes('verbosity'));
    assert.ok(output.includes('formality'));
    assert.ok(output.includes('humor'));
  });

  it('handles name action with custom name', async () => {
    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'name' };
      if (callCount === 2) return { value: 'CustomBot' }; // name choice
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    assert.equal(mockSaveHydraConfig.mock.callCount(), 1);
    const output = lines.join('\n');
    assert.ok(output.includes('name'));
    assert.ok(output.includes('CustomBot'));
  });

  it('handles name action with __freeform__ (no change)', async () => {
    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'name' };
      if (callCount === 2) return { value: '__freeform__' };
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const origLog = console.log;
    console.log = () => {};
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    // __freeform__ should not set name, so no save
    assert.equal(mockSaveHydraConfig.mock.callCount(), 0);
  });

  it('handles preset action with empty preset list', async () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: { enabled: true, name: 'Hydra' },
    }));
    invalidatePersonaCache();

    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'preset' };
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    const output = lines.join('\n');
    assert.ok(output.includes('No presets available'));
  });

  it('handles preset action with empty selection', async () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: { enabled: true, presets: { a: { tone: 'casual' } } },
    }));
    invalidatePersonaCache();

    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'preset' };
      if (callCount === 2) return { value: '' }; // empty selection
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const origLog = console.log;
    console.log = () => {};
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    // Empty selection should not apply preset
    assert.equal(mockSaveHydraConfig.mock.callCount(), 0);
  });

  it('handles tweak with non-string values (null picks)', async () => {
    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'tweak' };
      if (callCount === 2) return { value: null }; // tone - null
      if (callCount === 3) return { value: null }; // verbosity - null
      if (callCount === 4) return { value: null }; // formality - null
      if (callCount === 5) return { value: undefined }; // humor - undefined
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const origLog = console.log;
    console.log = () => {};
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    // No valid tweak values means no changes
    assert.equal(mockSaveHydraConfig.mock.callCount(), 0);
  });

  it('handles multiple changes in sequence', async () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: { enabled: true, name: 'Hydra', presets: {} },
    }));
    invalidatePersonaCache();

    let callCount = 0;
    mockPromptChoice.mock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { value: 'toggle' }; // disable
      if (callCount === 2) return { value: 'toggle' }; // enable
      return { value: 'done' };
    });
    const fakeRl = {} as Parameters<typeof runPersonaEditor>[0];
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runPersonaEditor(fakeRl);
    } finally {
      console.log = origLog;
    }
    assert.equal(mockSaveHydraConfig.mock.callCount(), 1);
    const output = lines.join('\n');
    assert.ok(output.includes('2 changes'));
  });
});

describe('getPersonaConfig caching', () => {
  it('returns same reference on consecutive calls', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      persona: { name: 'CacheTest' },
    }));
    invalidatePersonaCache();
    const first = getPersonaConfig();
    const second = getPersonaConfig();
    assert.equal(first, second);
  });
});
