import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MermaidBlock {
  filePath: string;
  code: string;
  startLine: number;
  endLine: number;
}

export interface MermaidLintIssue {
  filePath: string;
  startLine: number;
  endLine: number;
  error: string;
  diagramType?: string;
}

export interface MermaidValidationResult {
  valid: boolean;
  error?: string;
  diagramType?: string;
}

export interface MarkdownFileInput {
  filePath: string;
  markdown: string;
}

export type MermaidValidator = (diagram: string) => Promise<MermaidValidationResult>;

type MarkdownLintInput = MarkdownFileInput | string;

function isMarkdownFileInput(input: MarkdownLintInput): input is MarkdownFileInput {
  return typeof input !== 'string';
}

export function extractMermaidBlocks(markdown: string, filePath: string): MermaidBlock[] {
  const lines = markdown.split('\n');
  const blocks: MermaidBlock[] = [];
  let activeStartLine: number | null = null;
  let activeLines: string[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (activeStartLine === null && /^```mermaid(?:\s+.*)?\s*$/u.test(line)) {
      activeStartLine = lineNumber;
      activeLines = [];
      continue;
    }

    if (activeStartLine !== null && /^```\s*$/u.test(line)) {
      blocks.push({
        filePath,
        code: activeLines.join('\n'),
        startLine: activeStartLine,
        endLine: lineNumber,
      });
      activeStartLine = null;
      activeLines = [];
      continue;
    }

    if (activeStartLine !== null) {
      activeLines.push(line);
    }
  }

  return blocks;
}

export function getTrackedMarkdownFiles(rootDir: string): string[] {
  const output = execFileSync('git', ['ls-files', '*.md'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  return output
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(rootDir, entry));
}

export async function lintMarkdownFiles(
  inputs: MarkdownLintInput[],
  validateDiagram: MermaidValidator,
  rootDir = process.cwd(),
): Promise<MermaidLintIssue[]> {
  const issueGroups = await Promise.all(
    inputs.map(async (input) => {
      const filePath = isMarkdownFileInput(input) ? input.filePath : input;
      const markdown = isMarkdownFileInput(input)
        ? input.markdown
        : readFileSync(resolve(rootDir, input), 'utf8');

      const blocks = extractMermaidBlocks(markdown, filePath);
      const blockIssues = await Promise.all(
        blocks.map(async (block) => {
          const result = await validateDiagram(block.code);

          if (result.valid) {
            return null;
          }

          const issue: MermaidLintIssue = {
            filePath: block.filePath,
            startLine: block.startLine,
            endLine: block.endLine,
            error: result.error ?? 'Invalid Mermaid syntax',
          };

          if (result.diagramType !== undefined) {
            issue.diagramType = result.diagramType;
          }

          return issue;
        }),
      );

      return blockIssues.filter((issue): issue is MermaidLintIssue => issue !== null);
    }),
  );

  return issueGroups.flat();
}
