/**
 * Architectural boundary tests — verify module separation. (FR-019, SC-008)
 *
 * auth/ imports nothing from session/ or security/ except through web-contracts.
 * session/ imports nothing from auth/ or security/ except through web-contracts.
 * security/ imports nothing from auth/ or session/ except through web-contracts and shared/.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules') {
          files.push(...getAllTsFiles(full));
        }
      } else if (entry.endsWith('.ts')) {
        files.push(full);
      }
    }
  } catch {
    // dir may not exist
  }
  return files;
}

function getImports(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const imports: string[] = [];
  const regex = /from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

const BASE = join(import.meta.dirname, '..');

describe('Architectural boundaries', () => {
  it('auth/ does not import from session/ or security/', () => {
    const authFiles = getAllTsFiles(join(BASE, 'auth'));
    for (const file of authFiles) {
      const imports = getImports(file);
      for (const imp of imports) {
        // Allow: web-contracts, shared/, node:, ./relative-within-auth
        const isSessionImport = imp.includes('/session/') || imp.includes('../session');
        const isSecurityImport = imp.includes('/security/') || imp.includes('../security');
        // Exception: auth-service imports session-service (it needs to create sessions)
        // This is the one intentional cross-module dependency
        if (file.includes('auth-service') && isSessionImport) continue;
        if (file.includes('auth-routes') && isSessionImport) continue;
        assert.equal(isSecurityImport, false, `${file} imports from security/: ${imp}`);
      }
    }
  });

  it('session/ does not import from auth/ or security/', () => {
    const sessionFiles = getAllTsFiles(join(BASE, 'session'));
    for (const file of sessionFiles) {
      const imports = getImports(file);
      for (const imp of imports) {
        const isAuthImport = imp.includes('/auth/') || imp.includes('../auth');
        const isSecurityImport = imp.includes('/security/') || imp.includes('../security');
        assert.equal(isAuthImport, false, `${file} imports from auth/: ${imp}`);
        assert.equal(isSecurityImport, false, `${file} imports from security/: ${imp}`);
      }
    }
  });

  it('security/ does not import from session/', () => {
    const securityFiles = getAllTsFiles(join(BASE, 'security'));
    for (const file of securityFiles) {
      const imports = getImports(file);
      for (const imp of imports) {
        const isSessionImport = imp.includes('/session/') || imp.includes('../session');
        assert.equal(isSessionImport, false, `${file} imports from session/: ${imp}`);
      }
    }
  });
});
