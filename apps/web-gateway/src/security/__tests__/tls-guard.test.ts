import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTlsConfig, isSecure, isLoopbackAddress } from '../tls-guard.ts';

describe('TLS guard', () => {
  it('loopback bind without TLS allowed', () => {
    assert.doesNotThrow(() => {
      validateTlsConfig({ bindAddress: '127.0.0.1' });
    });
  });

  it('localhost bind without TLS allowed', () => {
    assert.doesNotThrow(() => {
      validateTlsConfig({ bindAddress: 'localhost' });
    });
  });

  it('::1 bind without TLS allowed', () => {
    assert.doesNotThrow(() => {
      validateTlsConfig({ bindAddress: '::1' });
    });
  });

  it('non-loopback bind without TLS config refuses', () => {
    assert.throws(
      () => {
        validateTlsConfig({ bindAddress: '192.168.1.100' });
      },
      { message: /requires TLS/i },
    );
  });

  it('non-loopback with TLS starts normally', () => {
    assert.doesNotThrow(() => {
      validateTlsConfig({
        bindAddress: '192.168.1.100',
        certPath: '/path/to/cert.pem',
        keyPath: '/path/to/key.pem',
      });
    });
  });

  it('isSecure returns true when certs provided', () => {
    assert.equal(
      isSecure({ bindAddress: '0.0.0.0', certPath: 'cert.pem', keyPath: 'key.pem' }),
      true,
    );
  });

  it('isSecure returns false without certs', () => {
    assert.equal(isSecure({ bindAddress: '127.0.0.1' }), false);
  });

  it('isLoopbackAddress detects loopback', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('localhost'), true);
    assert.equal(isLoopbackAddress('192.168.1.1'), false);
  });
});
