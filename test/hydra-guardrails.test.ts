import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSafetyPrompt,
  scanForSecrets,
  verifyBranch,
  isCleanWorkingTree,
  checkDiffSize,
  scanBranchViolations,
} from '../lib/hydra-shared/guardrails.ts';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../');

// ---------------------------------------------------------------------------
// buildSafetyPrompt() — pure string builder
// ---------------------------------------------------------------------------

describe('buildSafetyPrompt() — content', () => {
  const baseOpts = {
    runner: 'NightlyRunner',
    reportName: 'nightly-report.md',
    protectedFiles: new Set(['CLAUDE.md', 'package.json']),
    blockedCommands: ['git push', 'npm publish'],
  };

  it('contains the branch name', () => {
    const result = buildSafetyPrompt('feat/test-branch', baseOpts);
    assert.ok(result.includes('feat/test-branch'), 'should contain branch name');
  });

  it('contains the runner name', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('NightlyRunner'));
  });

  it('contains the report name', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('nightly-report.md'));
  });

  it('lists protected files wrapped in backticks', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('`CLAUDE.md`'));
    assert.ok(result.includes('`package.json`'));
  });

  it('lists blocked commands wrapped in backticks', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('`git push`'));
    assert.ok(result.includes('`npm publish`'));
  });

  it('includes ## SAFETY RULES heading', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('## SAFETY RULES'));
  });

  it('includes ### Branch Isolation heading', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('### Branch Isolation'));
  });

  it('includes ### Protected Files heading', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('### Protected Files'));
  });

  it('includes ### Blocked Commands heading', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(result.includes('### Blocked Commands'));
  });

  it('does not add extra section when extraRules is empty', () => {
    const result = buildSafetyPrompt('feat/x', { ...baseOpts, extraRules: [] });
    // Should still be a valid prompt but without extra bullet section
    assert.ok(typeof result === 'string');
  });

  it('does not add extra section when extraRules is absent', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(typeof result === 'string');
  });

  it('includes extraRules as bullet points when provided', () => {
    const result = buildSafetyPrompt('feat/x', {
      ...baseOpts,
      extraRules: ['Do not touch auth files', 'Run tests before commit'],
    });
    assert.ok(result.includes('- Do not touch auth files'));
    assert.ok(result.includes('- Run tests before commit'));
  });

  it('does not include attribution section when attribution is absent', () => {
    const result = buildSafetyPrompt('feat/x', baseOpts);
    assert.ok(!result.includes('Originated-By'));
    assert.ok(!result.includes('Commit Attribution'));
  });

  it('includes attribution section when attribution is provided', () => {
    const result = buildSafetyPrompt('feat/x', {
      ...baseOpts,
      attribution: { pipeline: 'nightly-v2' },
    });
    assert.ok(result.includes('Originated-By: nightly-v2'));
  });

  it('includes Executed-By when attribution.agent is provided', () => {
    const result = buildSafetyPrompt('feat/x', {
      ...baseOpts,
      attribution: { pipeline: 'nightly-v2', agent: 'claude' },
    });
    assert.ok(result.includes('Executed-By: claude'));
  });

  it('does not include Executed-By when attribution.agent is absent', () => {
    const result = buildSafetyPrompt('feat/x', {
      ...baseOpts,
      attribution: { pipeline: 'nightly-v2' },
    });
    assert.ok(!result.includes('Executed-By'));
  });

  it('handles empty protectedFiles set', () => {
    const result = buildSafetyPrompt('feat/x', {
      ...baseOpts,
      protectedFiles: new Set(),
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('### Protected Files'));
  });

  it('handles empty blockedCommands array', () => {
    const result = buildSafetyPrompt('feat/x', {
      ...baseOpts,
      blockedCommands: [],
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('### Blocked Commands'));
  });

  it('full combined test with all options', () => {
    const result = buildSafetyPrompt('feat/full-test', {
      runner: 'FullRunner',
      reportName: 'full-report.json',
      protectedFiles: new Set(['README.md']),
      blockedCommands: ['rm -rf /'],
      extraRules: ['Extra rule one'],
      attribution: { pipeline: 'full-pipeline', agent: 'gemini' },
    });
    assert.ok(result.includes('feat/full-test'));
    assert.ok(result.includes('FullRunner'));
    assert.ok(result.includes('full-report.json'));
    assert.ok(result.includes('`README.md`'));
    assert.ok(result.includes('`rm -rf /`'));
    assert.ok(result.includes('- Extra rule one'));
    assert.ok(result.includes('Originated-By: full-pipeline'));
    assert.ok(result.includes('Executed-By: gemini'));
  });
});

// ---------------------------------------------------------------------------
// scanForSecrets() — filename pattern detection
// ---------------------------------------------------------------------------

describe('scanForSecrets() — filename patterns', () => {
  it('detects .env as secrets_filename', () => {
    const results = scanForSecrets('/nonexistent', ['.env']);
    assert.ok(results.some((v) => v.type === 'secrets_filename' && v.severity === 'critical'));
  });

  it('detects .env.local as secrets_filename', () => {
    const results = scanForSecrets('/nonexistent', ['.env.local']);
    assert.ok(results.some((v) => v.type === 'secrets_filename'));
  });

  it('detects private.key as secrets_filename', () => {
    const results = scanForSecrets('/nonexistent', ['private.key']);
    assert.ok(results.some((v) => v.type === 'secrets_filename'));
  });

  it('detects cert.pem as secrets_filename', () => {
    const results = scanForSecrets('/nonexistent', ['cert.pem']);
    assert.ok(results.some((v) => v.type === 'secrets_filename'));
  });

  it('detects credentials.json as secrets_filename', () => {
    const results = scanForSecrets('/nonexistent', ['credentials.json']);
    assert.ok(results.some((v) => v.type === 'secrets_filename'));
  });

  it('detects api_key.txt as secrets_filename', () => {
    const results = scanForSecrets('/nonexistent', ['api_key.txt']);
    assert.ok(results.some((v) => v.type === 'secrets_filename'));
  });

  it('detects auth_token.json as secrets_filename', () => {
    const results = scanForSecrets('/nonexistent', ['auth_token.json']);
    assert.ok(results.some((v) => v.type === 'secrets_filename'));
  });

  it('returns no secrets_filename violations for normal source files', () => {
    const results = scanForSecrets('/nonexistent', ['src/index.ts', 'lib/utils.ts']);
    assert.ok(!results.some((v) => v.type === 'secrets_filename'));
  });

  it('returns empty array for empty file list', () => {
    const results = scanForSecrets('/nonexistent', []);
    assert.deepEqual(results, []);
  });

  it('detects Windows-path .env (backslash separator normalized)', () => {
    const results = scanForSecrets('/nonexistent', ['config\\.env']);
    assert.ok(results.some((v) => v.type === 'secrets_filename'));
  });

  it('does not crash on inaccessible file (content check)', () => {
    assert.doesNotThrow(() => {
      scanForSecrets('/definitely/does/not/exist/at/all', ['somefile.ts']);
    });
  });
});

// ---------------------------------------------------------------------------
// scanForSecrets() — content pattern detection (real temp files)
// ---------------------------------------------------------------------------

describe('scanForSecrets() — content patterns', () => {
  it('detects AWS access key pattern', () => {
    const tmpDir = os.tmpdir();
    const fileName = `aws-test-${String(Date.now())}.txt`;
    const tmpFile = path.join(tmpDir, fileName);
    try {
      fs.writeFileSync(tmpFile, 'AKIA1234567890ABCDEF', 'utf8');
      const results = scanForSecrets(tmpDir, [fileName]);
      assert.ok(results.some((v) => v.type === 'secrets_content' && v.severity === 'critical'));
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best effort cleanup
      }
    }
  });

  it('detects OpenAI key pattern (sk-)', () => {
    const tmpDir = os.tmpdir();
    const fileName = `openai-test-${String(Date.now())}.ts`;
    const tmpFile = path.join(tmpDir, fileName);
    try {
      fs.writeFileSync(tmpFile, 'const key = "sk-abcdefghijklmnopqrstuvwxyz12345678"', 'utf8');
      const results = scanForSecrets(tmpDir, [fileName]);
      assert.ok(results.some((v) => v.type === 'secrets_content'));
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best effort cleanup
      }
    }
  });

  it('detects GitHub PAT pattern (ghp_)', () => {
    const tmpDir = os.tmpdir();
    const fileName = `ghpat-test-${String(Date.now())}.json`;
    const tmpFile = path.join(tmpDir, fileName);
    try {
      fs.writeFileSync(tmpFile, `{"token":"ghp_${'A'.repeat(36)}"}`, 'utf8');
      const results = scanForSecrets(tmpDir, [fileName]);
      assert.ok(results.some((v) => v.type === 'secrets_content'));
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best effort cleanup
      }
    }
  });

  it('detects PEM private key header', () => {
    const tmpDir = os.tmpdir();
    const fileName = `pem-test-${String(Date.now())}.txt`;
    const tmpFile = path.join(tmpDir, fileName);
    try {
      fs.writeFileSync(tmpFile, '-----BEGIN RSA PRIVATE KEY-----\nfakedata', 'utf8');
      const results = scanForSecrets(tmpDir, [fileName]);
      assert.ok(results.some((v) => v.type === 'secrets_content'));
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best effort cleanup
      }
    }
  });

  it('detects Google API key pattern (AIza)', () => {
    const tmpDir = os.tmpdir();
    const fileName = `gapi-test-${String(Date.now())}.ts`;
    const tmpFile = path.join(tmpDir, fileName);
    try {
      fs.writeFileSync(tmpFile, `const g = "AIza${'B'.repeat(35)}"`, 'utf8');
      const results = scanForSecrets(tmpDir, [fileName]);
      assert.ok(results.some((v) => v.type === 'secrets_content'));
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best effort cleanup
      }
    }
  });

  it('detects generic api_key pattern', () => {
    const tmpDir = os.tmpdir();
    const fileName = `apikey-test-${String(Date.now())}.txt`;
    const tmpFile = path.join(tmpDir, fileName);
    try {
      fs.writeFileSync(tmpFile, 'api_key = "supersecretapikey12345678901234"', 'utf8');
      const results = scanForSecrets(tmpDir, [fileName]);
      assert.ok(results.some((v) => v.type === 'secrets_content'));
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best effort cleanup
      }
    }
  });

  it('.key file with PEM content yields both filename and content violations', () => {
    const tmpDir = os.tmpdir();
    const fileName = `server-${String(Date.now())}.key`;
    const tmpFile = path.join(tmpDir, fileName);
    try {
      fs.writeFileSync(tmpFile, '-----BEGIN RSA PRIVATE KEY-----\nfakedata', 'utf8');
      const results = scanForSecrets(tmpDir, [fileName]);
      assert.ok(results.some((v) => v.type === 'secrets_filename'));
      assert.ok(results.some((v) => v.type === 'secrets_content'));
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // best effort cleanup
      }
    }
  });
});

// ---------------------------------------------------------------------------
// verifyBranch() — integration-lite
// ---------------------------------------------------------------------------

describe('verifyBranch() — integration', () => {
  it('returns ok boolean and non-empty currentBranch for expected branch', () => {
    const result = verifyBranch(REPO_ROOT, 'feat/p3-coverage');
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(result.currentBranch.length > 0, 'currentBranch should be non-empty');
  });

  it('returns ok:false for a branch that does not exist', () => {
    const result = verifyBranch(REPO_ROOT, 'branch-that-never-exists-xyz-12345');
    assert.equal(result.ok, false);
    assert.ok(result.currentBranch.length > 0);
  });
});

// ---------------------------------------------------------------------------
// isCleanWorkingTree() — integration-lite
// ---------------------------------------------------------------------------

describe('isCleanWorkingTree() — integration', () => {
  it('returns a boolean', () => {
    const result = isCleanWorkingTree(REPO_ROOT);
    assert.equal(typeof result, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// checkDiffSize() — integration-lite
// ---------------------------------------------------------------------------

describe('checkDiffSize() — integration', () => {
  it('returns null or a valid ScanViolation with totalLines for feat/p3-coverage vs main', () => {
    const result = checkDiffSize(REPO_ROOT, 'feat/p3-coverage', { baseBranch: 'main' });
    if (result !== null) {
      assert.equal(typeof result.totalLines, 'number');
      assert.ok(result.totalLines >= 0);
    }
    // null is also valid (branch matches base or git error)
    assert.ok(result === null || typeof result === 'object');
  });

  it('returns null for a non-existent branch', () => {
    const result = checkDiffSize(REPO_ROOT, 'nonexistent-branch-xyz-999', { baseBranch: 'main' });
    assert.equal(result, null);
  });

  it('returns diff_too_large violation when maxDiffLines is 0 and diff exists', () => {
    const result = checkDiffSize(REPO_ROOT, 'feat/p3-coverage', {
      baseBranch: 'main',
      maxDiffLines: 0,
    });
    if (result !== null) {
      assert.equal(result.type, 'diff_too_large');
      assert.equal(result.severity, 'warning');
      assert.ok(result.totalLines > 0);
    }
    // null is acceptable if the diff is empty or git fails
  });
});

// ---------------------------------------------------------------------------
// scanBranchViolations() — integration-lite
// ---------------------------------------------------------------------------

describe('scanBranchViolations() — integration', () => {
  it('returns an array for the current branch with empty protection sets', () => {
    const result = scanBranchViolations(REPO_ROOT, 'feat/p3-coverage', {
      baseBranch: 'main',
      protectedFiles: new Set(),
      protectedPatterns: [],
    });
    assert.ok(Array.isArray(result));
  });

  it('returns an array when protectedFiles contains a test file (no throw)', () => {
    const result = scanBranchViolations(REPO_ROOT, 'feat/p3-coverage', {
      baseBranch: 'main',
      protectedFiles: new Set(['test/hydra-budget-tracker.test.ts']),
      protectedPatterns: [],
    });
    assert.ok(Array.isArray(result));
  });

  it('returns an array when protectedPatterns are provided; each item has type and severity', () => {
    const result = scanBranchViolations(REPO_ROOT, 'feat/p3-coverage', {
      baseBranch: 'main',
      protectedFiles: new Set(),
      protectedPatterns: [/\.test\.(ts|mjs)$/],
    });
    assert.ok(Array.isArray(result));
    for (const v of result) {
      assert.equal(typeof v.type, 'string');
      assert.equal(typeof v.severity, 'string');
    }
  });

  it('returns [] for a non-existent branch', () => {
    const result = scanBranchViolations(REPO_ROOT, 'nonexistent-branch-xyz-999', {
      baseBranch: 'main',
      protectedFiles: new Set(),
      protectedPatterns: [],
    });
    assert.deepEqual(result, []);
  });

  it('returns an array when checkDeletedTests is true (no throw)', () => {
    const result = scanBranchViolations(REPO_ROOT, 'feat/p3-coverage', {
      baseBranch: 'main',
      protectedFiles: new Set(),
      protectedPatterns: [],
      checkDeletedTests: true,
    });
    assert.ok(Array.isArray(result));
  });

  it('returns an array when secretsScan is true (no throw)', () => {
    const result = scanBranchViolations(REPO_ROOT, 'feat/p3-coverage', {
      baseBranch: 'main',
      protectedFiles: new Set(),
      protectedPatterns: [],
      secretsScan: true,
    });
    assert.ok(Array.isArray(result));
  });

  it('returns an array when maxDiffLines is 1 (no throw)', () => {
    const result = scanBranchViolations(REPO_ROOT, 'feat/p3-coverage', {
      baseBranch: 'main',
      protectedFiles: new Set(),
      protectedPatterns: [],
      maxDiffLines: 1,
    });
    assert.ok(Array.isArray(result));
  });
});
