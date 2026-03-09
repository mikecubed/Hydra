/**
 * Hydra verification command resolution.
 *
 * Chooses a project-appropriate verification command from:
 * 1) hydra.config.json verification.command
 * 2) auto-detected project signals
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadHydraConfig } from './hydra-config.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const DISABLED_COMMANDS = new Set(['off', 'none', 'disabled', 'false']);

/**
 * Allowlist of safe characters for verification commands. Verification commands
 * are executed via the system shell (exec/spawn with shell:true), so an attacker
 * that can write hydra.config.json could otherwise inject arbitrary commands.
 * This character-level allowlist prevents shell interpretation and command
 * chaining/redirection via shell metacharacters, but does NOT guarantee that
 * the command itself is non-malicious — a command like `curl evil.com` or
 * `rm -rf /` would still pass.
 *
 * Characters outside [a-zA-Z0-9 _./:@=-] are rejected as a defense-in-depth
 * measure.  Operators such as ; & | ` $ ( ) < > that enable shell injection
 * are not present in any standard build-tool invocation.
 */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9 _./:@=-]+$/;

/**
 * Validate that a verification command is free of shell metacharacters.
 * Prevents shell injection / command chaining via shell interpretation.
 * Does NOT guarantee the command itself is non-malicious.
 * Returns true when the command contains no shell metacharacters.
 * @param {string} command
 * @returns {boolean}
 */
export function isVerificationCommandShellSafe(command) {
  if (!command || typeof command !== 'string') return false;
  return SAFE_COMMAND_PATTERN.test(command.trim());
}

function readPackageJson(projectRoot) {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hasFile(projectRoot, fileName) {
  return fs.existsSync(path.join(projectRoot, fileName));
}

export function collectProjectSignals(projectRoot) {
  const pkg = readPackageJson(projectRoot);
  const npmScripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};

  return {
    npmScripts,
    hasTypeScriptConfig: hasFile(projectRoot, 'tsconfig.json'),
    hasCargoToml: hasFile(projectRoot, 'Cargo.toml'),
    hasGoMod: hasFile(projectRoot, 'go.mod'),
    hasPyproject: hasFile(projectRoot, 'pyproject.toml'),
  };
}

export function chooseAutoVerificationCommand(signals = {}) {
  const scripts =
    signals.npmScripts && typeof signals.npmScripts === 'object' ? signals.npmScripts : {};

  if (scripts.typecheck) {
    return { command: 'npm run typecheck', reason: 'Detected package.json script: typecheck' };
  }

  if (scripts.verify) {
    return { command: 'npm run verify', reason: 'Detected package.json script: verify' };
  }

  // If there's a test script, use it as a safe Node default.
  // Skip the npm-init placeholder: echo "Error: no test specified" && exit 1
  if (scripts.test) {
    const raw = String(scripts.test).trim();
    const isPlaceholder = /no test specified/i.test(raw) && /\bexit\s+1\b/i.test(raw);
    if (!isPlaceholder) {
      return { command: 'npm test', reason: 'Detected package.json script: test' };
    }
  }

  if (signals.hasTypeScriptConfig) {
    return { command: 'npx tsc --noEmit', reason: 'Detected tsconfig.json' };
  }

  if (signals.hasCargoToml) {
    return { command: 'cargo check', reason: 'Detected Cargo.toml' };
  }

  if (signals.hasGoMod) {
    return { command: 'go test ./...', reason: 'Detected go.mod' };
  }

  if (signals.hasPyproject) {
    return { command: 'python -m pytest -q', reason: 'Detected pyproject.toml' };
  }

  return null;
}

function parseTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

export function resolveVerificationPlan(
  projectRoot,
  hydraConfig = loadHydraConfig(),
  signalsOverride = null,
) {
  const cfg = hydraConfig && typeof hydraConfig === 'object' ? hydraConfig : {};
  const verification =
    cfg.verification && typeof cfg.verification === 'object' ? cfg.verification : {};

  const onTaskDone = verification.onTaskDone !== false;
  const timeoutMs = parseTimeoutMs(verification.timeoutMs);
  const rawCommand = String(verification.command ?? 'auto').trim();
  const lowered = rawCommand.toLowerCase();

  if (!onTaskDone) {
    return {
      enabled: false,
      timeoutMs,
      command: '',
      source: 'config',
      reason: 'verification.onTaskDone is false',
    };
  }

  if (DISABLED_COMMANDS.has(lowered)) {
    return {
      enabled: false,
      timeoutMs,
      command: '',
      source: 'config',
      reason: `verification.command=${rawCommand}`,
    };
  }

  if (rawCommand && lowered !== 'auto') {
    if (!isVerificationCommandShellSafe(rawCommand)) {
      return {
        enabled: false,
        timeoutMs,
        command: '',
        source: 'config',
        reason: `verification.command rejected: contains unsafe characters ("${rawCommand.slice(0, 40)}${rawCommand.length > 40 ? '…' : ''}")`,
      };
    }
    return {
      enabled: true,
      timeoutMs,
      command: rawCommand,
      source: 'config',
      reason: 'verification.command configured in hydra.config.json',
    };
  }

  const signals = signalsOverride || collectProjectSignals(projectRoot);
  const detected = chooseAutoVerificationCommand(signals);
  if (!detected) {
    return {
      enabled: false,
      timeoutMs,
      command: '',
      source: 'auto',
      reason: 'No project-specific verification command detected',
    };
  }

  return {
    enabled: true,
    timeoutMs,
    command: detected.command,
    source: 'auto',
    reason: detected.reason,
  };
}
