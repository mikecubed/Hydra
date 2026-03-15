import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashSecret, verifySecret } from '../credential-utils.ts';

describe('credential-utils', () => {
  it('round-trip hash+verify succeeds', async () => {
    const { hash, salt } = await hashSecret('my-password');
    const valid = await verifySecret('my-password', hash, salt);
    assert.equal(valid, true);
  });

  it('wrong secret fails', async () => {
    const { hash, salt } = await hashSecret('my-password');
    const valid = await verifySecret('wrong-password', hash, salt);
    assert.equal(valid, false);
  });

  it('different salts produce different hashes', async () => {
    const a = await hashSecret('same-password');
    const b = await hashSecret('same-password');
    assert.notEqual(a.hash, b.hash);
    assert.notEqual(a.salt, b.salt);
  });

  it('hash and salt are hex strings', async () => {
    const { hash, salt } = await hashSecret('test');
    assert.match(hash, /^[0-9a-f]+$/);
    assert.match(salt, /^[0-9a-f]+$/);
  });
});
