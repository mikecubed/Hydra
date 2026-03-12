import { fileURLToPath } from 'node:url';

import pc from 'picocolors';
import { parse } from '@a24z/mermaid-parser';

import { getTrackedMarkdownFiles, lintMarkdownFiles } from '../lib/hydra-mermaid-lint.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  const targets = rawArgs.length > 0 ? rawArgs : getTrackedMarkdownFiles(ROOT);

  const issues = await lintMarkdownFiles(
    targets,
    async (diagram) => {
      const result = await parse(diagram);
      return {
        valid: result.valid,
        error: result.error,
        diagramType: result.type,
      };
    },
    ROOT,
  );

  if (issues.length === 0) {
    console.log(
      pc.green(`✓ Mermaid diagrams validated in ${String(targets.length)} markdown files.`),
    );
    return 0;
  }

  console.error(pc.red(`✗ Mermaid validation failed in ${String(issues.length)} diagram(s):`));

  for (const issue of issues) {
    const location = `${issue.filePath}:${String(issue.startLine)}-${String(issue.endLine)}`;
    console.error(`  ${pc.red('•')} ${location}`);
    console.error(`    ${issue.error}`);
  }

  return 1;
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
