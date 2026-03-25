import path from 'node:path';
import { fileURLToPath } from 'node:url';

import madge from 'madge';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const targetDir = path.join(repoRoot, 'lib');
const tsConfig = path.join(repoRoot, 'tsconfig.json');

try {
  const result = await madge(targetDir, {
    baseDir: repoRoot,
    fileExtensions: ['ts', 'mjs'],
    tsConfig,
  });

  const cycles: string[][] = result.circular();

  if (cycles.length === 0) {
    console.log('✅ No circular imports detected in lib/');
  } else {
    console.warn(`⚠️  Found ${cycles.length} circular import(s) in lib/:`);
    for (const cycle of cycles) {
      console.warn(`  - ${cycle.join(' → ')}`);
    }
    console.warn('\nSee docs/REFACTORING_ROADMAP.md for the remediation plan.');
    process.exitCode = 1;
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Failed to detect circular imports: ${message}`);
  process.exitCode = 1;
}
