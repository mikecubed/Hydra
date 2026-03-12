import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from '@a24z/mermaid-parser';

import {
  extractMermaidBlocks,
  getTrackedMarkdownFiles,
  lintMarkdownFiles,
} from '../lib/hydra-mermaid-lint.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('hydra-mermaid-lint', () => {
  it('extracts fenced mermaid blocks with line numbers', () => {
    const markdown = [
      '# Title',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hi',
      '```',
    ].join('\n');

    const blocks = extractMermaidBlocks(markdown, 'docs/example.md');

    assert.equal(blocks.length, 2);
    assert.deepEqual(
      blocks.map((block) => block.startLine),
      [3, 8],
    );
    assert.match(blocks[0]?.code ?? '', /flowchart TD/);
    assert.match(blocks[1]?.code ?? '', /sequenceDiagram/);
  });

  it('reports invalid mermaid blocks with file and line context', async () => {
    const validator = (diagram: string) => {
      if (diagram.includes('broken node')) {
        return Promise.resolve({ valid: false, error: 'Invalid Mermaid syntax' });
      }

      return Promise.resolve({ valid: true, diagramType: 'flowchart' });
    };

    const issue = await lintMarkdownFiles(
      [
        {
          filePath: 'README.md',
          markdown: ['```mermaid', 'flowchart TD', 'broken node', '```'].join('\n'),
        },
      ],
      validator,
    );

    assert.equal(issue.length, 1);
    assert.equal(issue[0]?.filePath, 'README.md');
    assert.equal(issue[0]?.startLine, 1);
    assert.match(issue[0]?.error ?? '', /Invalid Mermaid syntax/);
  });

  it('validates tracked markdown mermaid blocks in the repository', async () => {
    const markdownFiles = getTrackedMarkdownFiles(ROOT);

    const issues = await lintMarkdownFiles(
      markdownFiles,
      async (diagram: string) => {
        const result = await parse(diagram);
        return {
          valid: result.valid,
          error: result.error,
          diagramType: result.type,
        };
      },
      ROOT,
    );

    assert.deepEqual(issues, []);
  });
});
