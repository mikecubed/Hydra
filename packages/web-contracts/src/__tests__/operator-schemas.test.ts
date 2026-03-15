import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Operator, CredentialType } from '../operator-schemas.ts';

describe('Operator', () => {
  const valid = {
    id: 'op-1',
    displayName: 'Admin',
    createdAt: new Date().toISOString(),
  };

  it('accepts valid operator', () => {
    const result = Operator.parse(valid);
    assert.equal(result.id, 'op-1');
    assert.equal(result.isActive, true);
  });

  it('accepts explicit isActive=false', () => {
    const result = Operator.parse({ ...valid, isActive: false });
    assert.equal(result.isActive, false);
  });

  it('rejects empty id', () => {
    assert.throws(() => Operator.parse({ ...valid, id: '' }));
  });

  it('rejects empty displayName', () => {
    assert.throws(() => Operator.parse({ ...valid, displayName: '' }));
  });
});

describe('CredentialType', () => {
  it('accepts password', () => {
    assert.equal(CredentialType.parse('password'), 'password');
  });

  it('rejects unknown type', () => {
    assert.throws(() => CredentialType.parse('oauth'));
  });
});
