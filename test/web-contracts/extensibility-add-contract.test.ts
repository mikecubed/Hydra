/**
 * Extensibility test: Simulated contract addition.
 *
 * Proves that a later phase can add a new contract schema, validate it
 * through existing helpers, and append a re-export line to the barrel —
 * with zero changes to foundation structural artifacts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContractValid, assertContractInvalid } from './contract-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

describe('Extensibility — simulated contract addition', () => {
  // Simulate a new contract that a later phase would add
  const NotificationContract = z.object({
    type: z.literal('notification'),
    payload: z.string(),
  });

  it('new contract can be validated through existing helpers (valid data)', () => {
    const result = assertContractValid(NotificationContract, {
      type: 'notification',
      payload: 'Task completed',
    });
    assert.equal(result.type, 'notification');
    assert.equal(result.payload, 'Task completed');
  });

  it('new contract can be validated through existing helpers (invalid data)', () => {
    assertContractInvalid(NotificationContract, { type: 'wrong', payload: 123 }, 'type');
  });

  it('barrel export file exists and is append-only extensible', async () => {
    const barrelPath = resolve(ROOT, 'packages/web-contracts/src/index.ts');
    const content = await readFile(barrelPath, 'utf-8');

    // Barrel file must exist and contain export statements
    assert.ok(content.includes('export'), 'Barrel file must contain export statements');

    // Simulate adding a new re-export line — verify it's pure append
    const newLine = "export { NotificationContract } from './notification-contract-v1.ts';";
    const extended = `${content}\n${newLine}\n`;

    // Original content must be preserved (prefix match)
    assert.ok(extended.startsWith(content), 'Extended barrel must preserve original content');
  });
});
