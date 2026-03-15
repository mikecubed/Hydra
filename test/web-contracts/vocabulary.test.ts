/**
 * Tests for the shared vocabulary type stubs and contract family registry.
 *
 * Verifies that the six core protocol object schemas accept valid data
 * with the correct `kind` discriminator and reject invalid data.
 * Also verifies the contract families registry structure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertContractValid, assertContractInvalid } from './contract-helpers.ts';
import {
  ConversationStub,
  TurnStub,
  StreamEventStub,
  ApprovalRequestStub,
  ArtifactStub,
  SessionSnapshotStub,
  CONTRACT_FAMILIES,
} from '../../packages/web-contracts/src/vocabulary.ts';

describe('Core protocol object stubs', () => {
  const stubs = [
    { name: 'ConversationStub', schema: ConversationStub, kind: 'conversation' },
    { name: 'TurnStub', schema: TurnStub, kind: 'turn' },
    { name: 'StreamEventStub', schema: StreamEventStub, kind: 'stream-event' },
    { name: 'ApprovalRequestStub', schema: ApprovalRequestStub, kind: 'approval-request' },
    { name: 'ArtifactStub', schema: ArtifactStub, kind: 'artifact' },
    { name: 'SessionSnapshotStub', schema: SessionSnapshotStub, kind: 'session-snapshot' },
  ] as const;

  for (const { name, schema, kind } of stubs) {
    describe(name, () => {
      it(`parses a minimal object with kind "${kind}"`, () => {
        const result = assertContractValid(schema, { kind });
        assert.equal(result.kind, kind);
      });

      it('rejects an object with a wrong kind', () => {
        assertContractInvalid(schema, { kind: 'wrong-kind' }, 'kind');
      });

      it('rejects an object with missing kind', () => {
        assertContractInvalid(schema, {}, 'kind');
      });
    });
  }
});

describe('CONTRACT_FAMILIES', () => {
  it('exports an array of five entries', () => {
    assert.equal(CONTRACT_FAMILIES.length, 5);
  });

  it('each entry has name, purpose, and status fields', () => {
    for (const family of CONTRACT_FAMILIES) {
      assert.ok(
        typeof family.name === 'string' && family.name.length > 0,
        'name must be non-empty string',
      );
      assert.ok(
        typeof family.purpose === 'string' && family.purpose.length > 0,
        'purpose must be non-empty string',
      );
      assert.ok(typeof family.status === 'string', 'status must be a string');
    }
  });

  it('all statuses are "planned"', () => {
    for (const family of CONTRACT_FAMILIES) {
      assert.equal(
        family.status,
        'planned',
        `Expected status "planned" for family "${family.name}"`,
      );
    }
  });

  it('contains the five expected contract family names', () => {
    const names = CONTRACT_FAMILIES.map((f) => f.name);
    assert.ok(names.includes('conversation-messaging'));
    assert.ok(names.includes('command-catalog-and-execution'));
    assert.ok(names.includes('council-and-multi-agent-eventing'));
    assert.ok(names.includes('task-live-output'));
    assert.ok(names.includes('config-and-controlled-mutations'));
  });
});
