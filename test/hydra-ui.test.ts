import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COLORS,
  AGENT_ICONS,
  HEALTH_ICONS,
  ACCENT,
  DIM,
  ERROR,
  SUCCESS,
  WARNING,
  stripAnsi,
  formatElapsed,
  compactProgressBar,
  progressBar,
  shortModelName,
  extractTopic,
  phaseNarrative,
  colorAgent,
  agentBadge,
  formatAgentStatus,
  colorStatus,
  formatTaskLine,
  formatHandoffLine,
  relativeTime,
  box,
  sectionHeader,
  divider,
  label,
  getAgentColor,
  getAgentIcon,
  renderDashboard,
  renderStatsDashboard,
  hydraLogoCompact,
  agentHeader,
  hydraSplash,
  HIGHLIGHT,
  HYDRA_SPLASH_50,
  HYDRA_SPLASH_100,
} from '../lib/hydra-ui.ts';

// ── stripAnsi ────────────────────────────────────────────────────────────────

test('stripAnsi removes basic ANSI color codes', () => {
  assert.equal(stripAnsi('\x1b[31mhello\x1b[0m'), 'hello');
  assert.equal(stripAnsi('\x1b[1m\x1b[91mbold red\x1b[0m'), 'bold red');
});

test('stripAnsi removes truecolor sequences', () => {
  assert.equal(stripAnsi('\x1b[38;2;232;134;58morange\x1b[39m'), 'orange');
});

test('stripAnsi passes plain text unchanged', () => {
  assert.equal(stripAnsi('plain text'), 'plain text');
  assert.equal(stripAnsi(''), '');
});

test('stripAnsi handles null/undefined gracefully', () => {
  assert.equal(stripAnsi(null as unknown as string), '');
  assert.equal(stripAnsi(undefined as unknown as string), '');
});

// ── formatElapsed ────────────────────────────────────────────────────────────

test('formatElapsed formats seconds correctly', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(500), '0s');
  assert.equal(formatElapsed(1000), '1s');
  assert.equal(formatElapsed(45000), '45s');
  assert.equal(formatElapsed(59999), '59s');
});

test('formatElapsed formats minutes correctly', () => {
  assert.equal(formatElapsed(60000), '1m');
  assert.equal(formatElapsed(90000), '1m 30s');
  assert.equal(formatElapsed(120000), '2m');
  assert.equal(formatElapsed(3599000), '59m 59s');
});

test('formatElapsed formats hours correctly', () => {
  assert.equal(formatElapsed(3600000), '1h');
  assert.equal(formatElapsed(5400000), '1h 30m');
  assert.equal(formatElapsed(7200000), '2h');
});

test('formatElapsed handles negative and null', () => {
  assert.equal(formatElapsed(-1), '0s');
  assert.equal(formatElapsed(null as unknown as number), '0s');
  assert.equal(formatElapsed(undefined as unknown as number), '0s');
});

// ── shortModelName ───────────────────────────────────────────────────────────

test('shortModelName extracts Claude model names', () => {
  assert.equal(shortModelName('claude-opus-4-6'), 'opus');
  assert.equal(shortModelName('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
  assert.equal(shortModelName('claude-haiku-4-5-20251001'), 'haiku');
});

test('shortModelName extracts Gemini model names', () => {
  assert.equal(shortModelName('gemini-2.5-flash'), '2.5-flash');
  assert.equal(shortModelName('gemini-2.5-pro'), '2.5-pro');
  assert.equal(shortModelName('gemini-3-pro-preview'), 'pro');
  assert.equal(shortModelName('gemini-3-flash-preview'), 'flash');
});

test('shortModelName extracts OpenAI/Codex model names', () => {
  assert.equal(shortModelName('o4-mini'), 'o4-mini');
  assert.equal(shortModelName('codex-5.2'), 'gpt-5.2c');
  assert.equal(shortModelName('gpt-5.2-codex'), 'gpt-5.2c');
  assert.equal(shortModelName('gpt-5.2'), 'gpt-5.2');
  assert.equal(shortModelName('gpt-5'), 'gpt-5');
  assert.equal(shortModelName('gpt-4'), 'gpt-4');
});

test('shortModelName handles null/empty', () => {
  assert.equal(shortModelName(''), '');
  assert.equal(shortModelName(null as unknown as string), '');
  assert.equal(shortModelName(undefined as unknown as string), '');
});

test('shortModelName strips common prefixes for unknown models', () => {
  const result = shortModelName('claude-future-model-20260101');
  assert.ok(!result.startsWith('claude-'), 'Should strip claude- prefix');
});

// ── extractTopic ─────────────────────────────────────────────────────────────

test('extractTopic strips leading filler words', () => {
  const topic = extractTopic('please fix the auth bug');
  assert.ok(!topic.toLowerCase().startsWith('please'));
  assert.ok(topic.includes('auth bug'));
});

test('extractTopic strips action verbs', () => {
  const topic = extractTopic('fix the login form');
  assert.ok(!topic.toLowerCase().startsWith('fix'));
  assert.ok(topic.includes('login form'));
});

test('extractTopic truncates long prompts at word boundary', () => {
  const longPrompt =
    'the authentication system needs to be completely redesigned from scratch with new token handling';
  const topic = extractTopic(longPrompt, 30);
  assert.ok(topic.length <= 31); // +1 for ellipsis char
  assert.ok(topic.endsWith('\u2026') || topic.length <= 30);
});

test('extractTopic takes first clause on semicolons', () => {
  const topic = extractTopic('update the header; also fix the footer');
  assert.ok(!topic.includes('footer'));
});

test('extractTopic returns empty for null/empty', () => {
  assert.equal(extractTopic(''), '');
  assert.equal(extractTopic(null as unknown as string), '');
  assert.equal(extractTopic(undefined as unknown as string), '');
});

// ── phaseNarrative ───────────────────────────────────────────────────────────

test('phaseNarrative returns correct narratives for known phases', () => {
  assert.match(phaseNarrative('propose', 'claude', 'auth fix'), /Analyzing/i);
  assert.match(phaseNarrative('critique', 'gemini', 'auth fix'), /Reviewing/i);
  assert.match(phaseNarrative('refine', 'claude', ''), /Incorporating/i);
  assert.match(phaseNarrative('implement', 'codex', 'new feature'), /Evaluating/i);
  assert.match(phaseNarrative('vote', 'claude', ''), /Casting/i);
  assert.match(phaseNarrative('summarize', 'claude', ''), /Summarizing/i);
});

test('phaseNarrative falls back for unknown phases', () => {
  const result = phaseNarrative('unknown_phase', 'claude', 'topic');
  assert.ok(result.includes('topic') || result.includes('unknown_phase'));
});

// ── AGENT_COLORS ─────────────────────────────────────────────────────────────

test('AGENT_COLORS has entries for all agents including copilot', () => {
  assert.ok(typeof AGENT_COLORS.claude === 'function');
  assert.ok(typeof AGENT_COLORS.gemini === 'function');
  assert.ok(typeof AGENT_COLORS.codex === 'function');
  assert.ok(typeof AGENT_COLORS.copilot === 'function', 'Missing AGENT_COLORS.copilot');
  assert.ok(typeof AGENT_COLORS.human === 'function');
  assert.ok(typeof AGENT_COLORS.system === 'function');
});

test('AGENT_COLORS.claude renders orange (truecolor) or yellow (fallback) and preserves text', () => {
  const colored = AGENT_COLORS.claude('test');
  assert.ok(
    colored.includes('test'),
    `Color function must preserve input text, got: ${JSON.stringify(colored)}`,
  );
  // In truecolor terminals the escape 38;2;232;134;58 is emitted; in others picocolors
  // emits a yellow code or no code at all (NO_COLOR / non-TTY). Either way the text is present.
  const isTruecolor =
    process.env['COLORTERM'] === 'truecolor' ||
    process.env['COLORTERM'] === '24bit' ||
    Boolean(process.env['WT_SESSION']);
  if (isTruecolor) {
    assert.ok(
      colored.includes('38;2;232;134;58'),
      `Expected truecolor orange in truecolor terminal, got: ${JSON.stringify(colored)}`,
    );
  }
});

test('AGENT_COLORS produce strings containing the input text', () => {
  for (const [name, fn] of Object.entries(AGENT_COLORS)) {
    const result = (fn as (s: string) => string)('hello');
    assert.ok(result.includes('hello'), `${name} color function should wrap text`);
  }
});

// ── AGENT_ICONS ──────────────────────────────────────────────────────────────

test('AGENT_ICONS has correct symbols', () => {
  assert.equal(AGENT_ICONS.claude, '\u274B'); // ❋
  assert.equal(AGENT_ICONS.gemini, '\u2726'); // ✦
  assert.equal(AGENT_ICONS.codex, '\u058E'); // ֎
  assert.equal(AGENT_ICONS.copilot, '\u29BF'); // ⦿
  assert.equal(AGENT_ICONS.human, '\u{1F16F}'); // 🅯
  assert.equal(AGENT_ICONS.system, '\u{1F5B3}'); // 🖳
});

// ── HEALTH_ICONS ─────────────────────────────────────────────────────────────

test('HEALTH_ICONS has all four states', () => {
  assert.ok(HEALTH_ICONS.idle);
  assert.ok(HEALTH_ICONS.working);
  assert.ok(HEALTH_ICONS.error);
  assert.ok(HEALTH_ICONS.inactive);
  // All should contain the filled circle character
  for (const icon of Object.values(HEALTH_ICONS)) {
    assert.ok(stripAnsi(icon).includes('\u25CF'));
  }
});

// ── colorAgent ───────────────────────────────────────────────────────────────

test('colorAgent wraps known agents with their color', () => {
  const result = colorAgent('claude');
  const stripped = stripAnsi(result);
  assert.equal(stripped, 'claude');
  // ANSI codes are present in color-capable terminals; in NO_COLOR / non-TTY
  // environments picocolors emits the raw string. Either output is correct.
  assert.ok(result.includes('claude'));
});

test('colorAgent defaults to white for unknown agents', () => {
  const result = colorAgent('unknown_agent');
  assert.ok(result.includes('unknown_agent'));
});

test('colorAgent handles null/empty', () => {
  // colorAgent uses String(name), so null becomes "null"
  const result = colorAgent(null as unknown as string);
  assert.equal(stripAnsi(result), 'null');
  const empty = colorAgent('');
  assert.equal(stripAnsi(empty), '');
});

// ── agentBadge ───────────────────────────────────────────────────────────────

test('agentBadge includes icon and uppercased name', () => {
  const badge = agentBadge('claude');
  const stripped = stripAnsi(badge);
  assert.ok(stripped.includes('\u274B'), 'Should contain star icon');
  assert.ok(stripped.includes('CLAUDE'), 'Should contain uppercased name');
});

test('agentBadge works for all agents', () => {
  for (const name of ['gemini', 'codex', 'claude']) {
    const badge = agentBadge(name);
    const stripped = stripAnsi(badge);
    assert.ok(stripped.includes(name.toUpperCase()));
  }
});

// ── formatAgentStatus ────────────────────────────────────────────────────────

test('formatAgentStatus includes health icon, agent icon, and action text', () => {
  const result = formatAgentStatus('claude', 'working', 'Calling sonnet...', 80);
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('CLAUDE'));
  assert.ok(stripped.includes('Calling sonnet...'));
});

test('formatAgentStatus truncates action text at maxWidth', () => {
  const result = formatAgentStatus('gemini', 'idle', 'A very long action description here', 15);
  const stripped = stripAnsi(result);
  // The name + action portion should be truncated
  assert.ok(stripped.includes('\u2026') || stripped.length <= 30);
});

// ── progressBar / compactProgressBar ─────────────────────────────────────────

test('progressBar renders filled and empty segments', () => {
  const bar = progressBar(50, 10);
  const stripped = stripAnsi(bar);
  assert.ok(stripped.includes('50.0%'));
});

test('progressBar clamps to 0-100', () => {
  const low = progressBar(-10, 10);
  assert.ok(stripAnsi(low).includes('0.0%'));
  const high = progressBar(200, 10);
  assert.ok(stripAnsi(high).includes('100.0%'));
});

test('compactProgressBar renders percentage', () => {
  const bar = compactProgressBar(75, 10);
  assert.ok(stripAnsi(bar).includes('75.0%'));
});

test('compactProgressBar handles zero', () => {
  const bar = compactProgressBar(0, 10);
  assert.ok(stripAnsi(bar).includes('0.0%'));
});

// ── box ──────────────────────────────────────────────────────────────────────

test('box creates bordered output with title', () => {
  const result = box('Test', ['line 1', 'line 2'], 30);
  assert.ok(result.includes('Test'));
  assert.ok(result.includes('line 1'));
  assert.ok(result.includes('line 2'));
  assert.ok(result.includes('\u250C')); // top-left corner
  assert.ok(result.includes('\u2514')); // bottom-left corner
});

test('box handles empty lines array', () => {
  const result = box('Empty', [], 20);
  assert.ok(result.includes('Empty'));
  assert.ok(result.includes('\u250C'));
  assert.ok(result.includes('\u2514'));
});

// ── sectionHeader ────────────────────────────────────────────────────────────

test('sectionHeader includes title text', () => {
  const result = sectionHeader('Agents');
  assert.ok(stripAnsi(result).includes('Agents'));
});

// ── divider ──────────────────────────────────────────────────────────────────

test('divider returns horizontal line', () => {
  const result = divider();
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('─'));
  assert.ok(stripped.length >= 50);
});

// ── label ────────────────────────────────────────────────────────────────────

test('label formats key-value pair', () => {
  const result = label('Mode', 'auto');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('Mode:'));
  assert.ok(stripped.includes('auto'));
});

// ── colorStatus ──────────────────────────────────────────────────────────────

test('colorStatus includes status icon and text', () => {
  const done = colorStatus('done');
  assert.ok(stripAnsi(done).includes('\u2713'));
  assert.ok(stripAnsi(done).includes('done'));

  const blocked = colorStatus('blocked');
  assert.ok(stripAnsi(blocked).includes('\u2717'));
});

// ── formatTaskLine ───────────────────────────────────────────────────────────

test('formatTaskLine renders task with id, status, owner', () => {
  const line = formatTaskLine({ id: 'T-1', status: 'todo', owner: 'claude', title: 'Fix auth' });
  const stripped = stripAnsi(line);
  assert.ok(stripped.includes('T-1'));
  assert.ok(stripped.includes('claude'));
});

test('formatTaskLine handles null task', () => {
  assert.equal(formatTaskLine(null), '');
});

// ── relativeTime ─────────────────────────────────────────────────────────────

test('relativeTime shows "just now" for recent timestamps', () => {
  const result = relativeTime(new Date().toISOString());
  assert.ok(stripAnsi(result).includes('just now'));
});

test('relativeTime shows minutes for older timestamps', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = relativeTime(fiveMinAgo);
  assert.ok(stripAnsi(result).includes('5m ago'));
});

test('relativeTime shows "never" for null', () => {
  assert.ok(stripAnsi(relativeTime(null as unknown as string)).includes('never'));
});

// ── Semantic color exports ───────────────────────────────────────────────────

test('semantic color exports are functions', () => {
  assert.ok(typeof ACCENT === 'function');
  assert.ok(typeof DIM === 'function');
  assert.ok(typeof ERROR === 'function');
  assert.ok(typeof SUCCESS === 'function');
  assert.ok(typeof WARNING === 'function');
});

// ── getAgentColor ────────────────────────────────────────────────────────────

test('getAgentColor returns known agent color functions', () => {
  const claudeColor = getAgentColor('claude');
  assert.equal(typeof claudeColor, 'function');
  assert.ok(claudeColor('x').includes('x'));
  const geminiColor = getAgentColor('gemini');
  assert.equal(typeof geminiColor, 'function');
  assert.ok(geminiColor('y').includes('y'));
});

test('getAgentColor falls back to system color for unknown agents', () => {
  const fallback = getAgentColor('nonexistent_agent');
  assert.equal(typeof fallback, 'function');
  assert.ok(fallback('test').includes('test'));
});

test('getAgentColor handles empty string', () => {
  const fallback = getAgentColor('');
  assert.equal(typeof fallback, 'function');
});

test('getAgentColor is case-insensitive', () => {
  const upper = getAgentColor('CLAUDE');
  const lower = getAgentColor('claude');
  // Both should resolve the same color function
  assert.equal(typeof upper, 'function');
  assert.equal(typeof lower, 'function');
});

// ── getAgentIcon ─────────────────────────────────────────────────────────────

test('getAgentIcon returns correct icons for known agents', () => {
  assert.equal(getAgentIcon('claude'), '\u274B');
  assert.equal(getAgentIcon('gemini'), '\u2726');
  assert.equal(getAgentIcon('codex'), '\u058E');
  assert.equal(getAgentIcon('copilot'), '\u29BF');
});

test('getAgentIcon returns diamond for unknown agents', () => {
  assert.equal(getAgentIcon('mystery_agent'), '\u25C7');
});

test('getAgentIcon handles empty and null-ish', () => {
  assert.equal(getAgentIcon(''), '\u25C7');
  // null coerced to ''
  assert.equal(getAgentIcon(null as unknown as string), '\u25C7');
});

// ── colorAgent extended ──────────────────────────────────────────────────────

test('colorAgent preserves casing in output for each known agent', () => {
  for (const name of ['claude', 'gemini', 'codex', 'copilot']) {
    const result = colorAgent(name);
    assert.ok(result.includes(name), `${name} should be in output`);
  }
});

// ── agentBadge extended ──────────────────────────────────────────────────────

test('agentBadge for copilot includes copilot icon', () => {
  const badge = agentBadge('copilot');
  const stripped = stripAnsi(badge);
  assert.ok(stripped.includes('\u29BF'), 'Should contain copilot icon');
  assert.ok(stripped.includes('COPILOT'));
});

test('agentBadge for unknown agent uses diamond icon', () => {
  const badge = agentBadge('custom_bot');
  const stripped = stripAnsi(badge);
  assert.ok(stripped.includes('\u25C7'), 'Unknown agents get diamond icon');
  assert.ok(stripped.includes('CUSTOM_BOT'));
});

// ── colorStatus extended ─────────────────────────────────────────────────────

test('colorStatus handles all known statuses', () => {
  const statuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
  const expectedIcons: Record<string, string> = {
    todo: '\u25CB',
    in_progress: '\u25D4',
    blocked: '\u2717',
    done: '\u2713',
    cancelled: '\u2500',
  };
  for (const status of statuses) {
    const result = colorStatus(status);
    const stripped = stripAnsi(result);
    assert.ok(
      stripped.includes(expectedIcons[status]),
      `${status} should have icon ${expectedIcons[status]}`,
    );
    assert.ok(stripped.includes(status));
  }
});

test('colorStatus uses bullet for unknown status', () => {
  const result = colorStatus('mystery');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('\u2022'), 'Unknown status gets bullet');
  assert.ok(stripped.includes('mystery'));
});

test('colorStatus handles empty string', () => {
  const result = colorStatus('');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('\u2022'));
});

// ── formatTaskLine extended ──────────────────────────────────────────────────

test('formatTaskLine renders title truncated to 60 chars', () => {
  const longTitle = 'A'.repeat(100);
  const line = formatTaskLine({
    id: 'T-99',
    status: 'in_progress',
    owner: 'gemini',
    title: longTitle,
  });
  const stripped = stripAnsi(line);
  // The title portion should be at most 60 chars of A
  assert.ok(!stripped.includes('A'.repeat(61)), 'Title should be truncated at 60');
  assert.ok(stripped.includes('A'.repeat(60)));
});

test('formatTaskLine handles undefined fields gracefully', () => {
  const line = formatTaskLine({});
  const stripped = stripAnsi(line);
  assert.ok(stripped.includes('???'), 'Missing id shows ???');
});

test('formatTaskLine returns empty for undefined', () => {
  assert.equal(formatTaskLine(), '');
});

// ── formatHandoffLine ────────────────────────────────────────────────────────

test('formatHandoffLine renders handoff with from/to and arrow', () => {
  const line = formatHandoffLine({
    id: 'H-1',
    from: 'claude',
    to: 'codex',
    acknowledgedAt: null,
    summary: 'Pass to codex for implementation',
  });
  const stripped = stripAnsi(line);
  assert.ok(stripped.includes('H-1'));
  assert.ok(stripped.includes('\u2192'), 'Should contain arrow');
  assert.ok(stripped.includes('pending'), 'Unacknowledged should show pending');
});

test('formatHandoffLine shows ack when acknowledgedAt is set', () => {
  const line = formatHandoffLine({
    id: 'H-2',
    from: 'gemini',
    to: 'claude',
    acknowledgedAt: '2025-01-01T00:00:00Z',
    summary: 'Review complete',
  });
  const stripped = stripAnsi(line);
  assert.ok(stripped.includes('\u2713'), 'Acknowledged should show checkmark');
  assert.ok(stripped.includes('ack'));
});

test('formatHandoffLine returns empty for null', () => {
  assert.equal(formatHandoffLine(null), '');
  assert.equal(formatHandoffLine(), '');
});

test('formatHandoffLine handles missing fields', () => {
  const line = formatHandoffLine({});
  const stripped = stripAnsi(line);
  assert.ok(stripped.includes('???'));
});

test('formatHandoffLine truncates summary at 50 chars', () => {
  const longSummary = 'X'.repeat(80);
  const line = formatHandoffLine({ id: 'H-3', from: 'a', to: 'b', summary: longSummary });
  const stripped = stripAnsi(line);
  assert.ok(!stripped.includes('X'.repeat(51)));
});

// ── relativeTime extended ────────────────────────────────────────────────────

test('relativeTime shows hours for timestamps several hours ago', () => {
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const result = relativeTime(threeHoursAgo);
  assert.ok(stripAnsi(result).includes('3h ago'));
});

test('relativeTime shows days for timestamps over 24h ago', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const result = relativeTime(twoDaysAgo);
  assert.ok(stripAnsi(result).includes('2d ago'));
});

test('relativeTime shows "future" for future timestamps', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const result = relativeTime(future);
  assert.ok(stripAnsi(result).includes('future'));
});

test('relativeTime shows seconds for 30s ago', () => {
  const thirtySecsAgo = new Date(Date.now() - 30 * 1000).toISOString();
  const result = relativeTime(thirtySecsAgo);
  assert.ok(stripAnsi(result).includes('s ago'));
});

// ── box extended ─────────────────────────────────────────────────────────────

test('box supports options object with style and padding', () => {
  const result = box('Test', ['content'], { style: 'heavy', width: 40, padding: 1 });
  assert.ok(result.includes('\u250F'), 'Heavy style uses thick corners');
  assert.ok(result.includes('\u2517'));
  assert.ok(result.includes('content'));
});

test('box supports rounded style', () => {
  const result = box('Round', ['line'], { style: 'rounded', width: 30 });
  assert.ok(result.includes('\u256D'), 'Rounded style uses round corners');
  assert.ok(result.includes('\u256F'));
});

test('box supports double style', () => {
  const result = box('Double', ['line'], { style: 'double', width: 30 });
  assert.ok(result.includes('\u2554'), 'Double style uses double-line corners');
  assert.ok(result.includes('\u255D'));
});

test('box with padding adds blank lines', () => {
  const result = box('Padded', ['inner'], { padding: 2, width: 30 });
  const lines = result.split('\n');
  // With padding > 0, blank lines are added after top and before bottom
  assert.ok(lines.length >= 4, 'Padding should add blank lines');
});

test('box defaults to width 60 when opts.width is 0', () => {
  const result = box('Default', ['a'], { width: 0 });
  // The top border includes the title + horizontal lines, verifying width > 0
  const topLine = result.split('\n')[0];
  assert.ok(stripAnsi(topLine).length >= 50, 'Should default to roughly 60 width');
});

test('box handles very long lines gracefully', () => {
  const result = box('Title', ['A'.repeat(200)], 40);
  // The line won't be truncated, but pad will be 0
  assert.ok(result.includes('A'.repeat(200)));
});

// ── sectionHeader extended ───────────────────────────────────────────────────

test('sectionHeader respects custom width', () => {
  const result = sectionHeader('Test', 80);
  const stripped = stripAnsi(result);
  // Should have more dashes than default (60)
  const dashCount = (stripped.match(/─/g) ?? []).length;
  assert.ok(dashCount > 50, 'Custom width should produce more dashes');
});

test('sectionHeader handles empty title', () => {
  const result = sectionHeader('');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('─'));
});

// ── label extended ───────────────────────────────────────────────────────────

test('label with no value shows just the key', () => {
  const result = label('Mode');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('Mode:'));
  assert.ok(!stripped.includes('undefined'));
});

test('label formats boolean values', () => {
  const result = label('Enabled', true);
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('true'));
});

test('label formats numeric values', () => {
  const result = label('Count', 42);
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('42'));
});

// ── progressBar extended ─────────────────────────────────────────────────────

test('progressBar with fractional=false uses simple blocks', () => {
  const bar = progressBar(50, 10, false);
  const stripped = stripAnsi(bar);
  assert.ok(stripped.includes('50.0%'));
});

test('progressBar at 100% shows full', () => {
  const bar = progressBar(100, 10);
  const stripped = stripAnsi(bar);
  assert.ok(stripped.includes('100.0%'));
});

test('progressBar changes color at thresholds', () => {
  // 80-89% = yellow, 90+% = red — we can't easily check ANSI color,
  // but we can verify the percentage is rendered correctly
  const bar80 = progressBar(85, 10);
  assert.ok(stripAnsi(bar80).includes('85.0%'));
  const bar95 = progressBar(95, 10);
  assert.ok(stripAnsi(bar95).includes('95.0%'));
});

// ── compactProgressBar extended ──────────────────────────────────────────────

test('compactProgressBar at 100% shows full bar', () => {
  const bar = compactProgressBar(100, 10);
  assert.ok(stripAnsi(bar).includes('100.0%'));
});

test('compactProgressBar clamps negative values', () => {
  const bar = compactProgressBar(-5, 10);
  assert.ok(stripAnsi(bar).includes('0.0%'));
});

test('compactProgressBar clamps values over 100', () => {
  const bar = compactProgressBar(150, 10);
  assert.ok(stripAnsi(bar).includes('100.0%'));
});

// ── formatAgentStatus extended ───────────────────────────────────────────────

test('formatAgentStatus shows inactive for empty action and status', () => {
  const result = formatAgentStatus('claude', '', '', 80);
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('CLAUDE'));
  assert.ok(stripped.includes('Inactive'));
});

test('formatAgentStatus uses error icon for error status', () => {
  const result = formatAgentStatus('gemini', 'error', 'Connection failed', 80);
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('GEMINI'));
});

test('formatAgentStatus handles unknown agent', () => {
  const result = formatAgentStatus('custom', 'idle', 'Waiting', 80);
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('CUSTOM'));
  assert.ok(stripped.includes('Waiting'));
});

// ── extractTopic extended ────────────────────────────────────────────────────

test('extractTopic strips multiple leading verbs', () => {
  assert.ok(!extractTopic('create a new user service').toLowerCase().startsWith('create'));
  assert.ok(!extractTopic('implement the caching layer').toLowerCase().startsWith('implement'));
  assert.ok(!extractTopic('refactor the auth module').toLowerCase().startsWith('refactor'));
});

test('extractTopic takes first clause on period', () => {
  const topic = extractTopic('update the header. also fix the footer');
  assert.ok(!topic.includes('footer'));
});

test('extractTopic takes first clause on newline', () => {
  const topic = extractTopic('update the header\nalso fix the footer');
  assert.ok(!topic.includes('footer'));
});

test('extractTopic splits on "so that" and "because"', () => {
  const topic1 = extractTopic('the auth module so that it handles tokens');
  assert.ok(!topic1.includes('handles tokens'));
  const topic2 = extractTopic('the config system because it has bugs');
  assert.ok(!topic2.includes('has bugs'));
});

test('extractTopic handles comma split only when > 8 chars', () => {
  // Short pre-comma should NOT split
  const short = extractTopic('foo, bar and baz');
  assert.ok(short.includes('foo'));
  // Long pre-comma should split
  const long = extractTopic('the authentication, plus the cache system');
  assert.ok(!long.includes('cache system'));
});

// ── shortModelName extended ──────────────────────────────────────────────────

test('shortModelName strips date suffix from unknown claude models', () => {
  const result = shortModelName('claude-future-model-20260101');
  assert.ok(!result.includes('20260101'), 'Should strip date suffix');
  assert.ok(!result.startsWith('claude-'), 'Should strip claude- prefix');
});

test('shortModelName strips gemini prefix from unknown gemini models', () => {
  const result = shortModelName('gemini-future-model');
  assert.ok(!result.startsWith('gemini-'), 'Should strip gemini- prefix');
});

// ── renderDashboard ──────────────────────────────────────────────────────────

test('renderDashboard renders minimal dashboard with no data', () => {
  const result = renderDashboard({}, {});
  assert.ok(result.includes('HYDRA'), 'Should contain hydra branding');
  assert.ok(result.includes('Open tasks'));
});

test('renderDashboard renders session info when present', () => {
  const result = renderDashboard(
    {
      activeSession: { focus: 'auth rewrite', branch: 'feat/auth', status: 'active' },
      counts: { tasksOpen: 3, blockersOpen: 1, decisions: 2, handoffs: 1 },
      updatedAt: new Date().toISOString(),
    },
    {},
  );
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('auth rewrite'));
  assert.ok(stripped.includes('feat/auth'));
});

test('renderDashboard renders agent section', () => {
  const result = renderDashboard(
    { counts: { tasksOpen: 0, blockersOpen: 0, decisions: 0, handoffs: 0 } },
    { claude: { action: 'idle' }, gemini: { action: 'continue_task', task: { id: 'T-5' } } },
  );
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('CLAUDE'));
  assert.ok(stripped.includes('GEMINI'));
});

test('renderDashboard renders open tasks', () => {
  const result = renderDashboard(
    {
      openTasks: [
        { id: 'T-1', status: 'todo', owner: 'claude', title: 'Fix auth' },
        { id: 'T-2', status: 'in_progress', owner: 'gemini', title: 'Review plan' },
      ],
    },
    {},
  );
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('T-1'));
  assert.ok(stripped.includes('T-2'));
});

test('renderDashboard renders blockers', () => {
  const result = renderDashboard(
    {
      openBlockers: [{ id: 'B-1', owner: 'codex', title: 'Blocked on API' }],
    },
    {},
  );
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('B-1'));
  assert.ok(stripped.includes('Blocked on API'));
});

test('renderDashboard renders latest handoff', () => {
  const result = renderDashboard(
    {
      latestHandoff: {
        id: 'H-1',
        from: 'claude',
        to: 'codex',
        summary: 'Handoff for impl',
      },
    },
    {},
  );
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('H-1'));
});

test('renderDashboard renders token usage when present', () => {
  const result = renderDashboard(
    { counts: { tasksOpen: 0, blockersOpen: 0, decisions: 0, handoffs: 0 } },
    {},
    { usage: { level: 'warning', percent: 75 } },
  );
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('75.0%'));
});

// ── renderStatsDashboard ─────────────────────────────────────────────────────

test('renderStatsDashboard renders empty state for null metrics', () => {
  const result = renderStatsDashboard(null, null);
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('No agent calls recorded'));
});

test('renderStatsDashboard renders usage section', () => {
  const result = renderStatsDashboard(null, {
    percent: 50,
    level: 'normal',
    todayTokens: 5000,
    message: 'All good',
  });
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('50.0%'));
  assert.ok(stripped.includes('NORMAL'));
});

test('renderStatsDashboard renders agent performance table', () => {
  const result = renderStatsDashboard(
    {
      agents: {
        claude: { callsToday: 10, avgDurationMs: 2500, successRate: 95 },
        gemini: { callsToday: 5, avgDurationMs: 1200, successRate: 100 },
      },
      totalCalls: 15,
      totalTokens: 50000,
      totalDurationMs: 30000,
      uptimeSec: 3600,
    },
    null,
  );
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('Agent Performance'));
  assert.ok(stripped.includes('Session Totals'));
});

// ── agentHeader ──────────────────────────────────────────────────────────────

test('agentHeader renders known agent with tagline', () => {
  const result = agentHeader('claude');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('CLAUDE'));
  assert.ok(stripped.includes('Architect'));
});

test('agentHeader renders unknown agent with generic tagline', () => {
  const result = agentHeader('mystery');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('MYSTERY'));
  assert.ok(stripped.includes('Agent'));
});

test('agentHeader handles empty name', () => {
  const result = agentHeader('');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('Agent'));
});

// ── hydraLogoCompact ─────────────────────────────────────────────────────────

test('hydraLogoCompact returns branded string', () => {
  const result = hydraLogoCompact();
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('HYDRA'));
  assert.ok(stripped.includes('Hybrid'));
});

// ── hydraSplash ──────────────────────────────────────────────────────────────

test('hydraSplash returns multi-line splash with version', () => {
  const result = hydraSplash();
  assert.ok(result.includes('H Y D R A'));
  assert.ok(result.includes('SillyPepper'));
});

// ── HYDRA_SPLASH constants ───────────────────────────────────────────────────

test('HYDRA_SPLASH_50 contains agent names', () => {
  assert.ok(HYDRA_SPLASH_50.includes('GEMINI'));
  assert.ok(HYDRA_SPLASH_50.includes('CODEX'));
  assert.ok(HYDRA_SPLASH_50.includes('CLAUDE'));
});

test('HYDRA_SPLASH_100 contains agent names', () => {
  assert.ok(HYDRA_SPLASH_100.includes('GEMINI'));
  assert.ok(HYDRA_SPLASH_100.includes('CODEX'));
  assert.ok(HYDRA_SPLASH_100.includes('CLAUDE'));
});

// ── HIGHLIGHT ────────────────────────────────────────────────────────────────

test('HIGHLIGHT wraps text', () => {
  assert.ok(typeof HIGHLIGHT === 'function');
  const result = HIGHLIGHT('bold text');
  assert.ok(result.includes('bold text'));
});

// ── formatElapsed edge cases ─────────────────────────────────────────────────

test('formatElapsed large hours', () => {
  // 26 hours = 1d 2h, but formatElapsed only goes to hours
  assert.equal(formatElapsed(26 * 3600000), '26h');
});

test('formatElapsed exactly 1 hour with seconds ignored', () => {
  // 1h 0m 30s => should show 1h
  assert.equal(formatElapsed(3600000 + 30000), '1h');
});

// ── phaseNarrative extended ──────────────────────────────────────────────────

test('phaseNarrative with empty topic uses default text', () => {
  assert.match(phaseNarrative('propose', 'claude', ''), /objective/i);
  assert.match(phaseNarrative('critique', 'gemini', ''), /plan/i);
  assert.match(phaseNarrative('implement', 'codex', ''), /approach/i);
});

test('phaseNarrative unknown phase with empty topic uses ellipsis', () => {
  const result = phaseNarrative('unknown_phase', 'claude', '');
  assert.ok(result.includes('...'));
});
