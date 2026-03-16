/**
 * TLS guard — startup check: non-loopback bind requires cert+key config.
 * Exports isSecure() for cookie Secure flag. (FR-024)
 */

export interface TlsConfig {
  bindAddress: string;
  certPath?: string;
  keyPath?: string;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopback(address: string): boolean {
  return LOOPBACK_ADDRESSES.has(address);
}

export function validateTlsConfig(config: TlsConfig): void {
  if (isLoopback(config.bindAddress)) return; // loopback is fine without TLS

  if (config.certPath == null || config.keyPath == null) {
    throw new Error(
      `Non-loopback bind address '${config.bindAddress}' requires TLS configuration (certPath and keyPath). ` +
        'Set bindAddress to 127.0.0.1 for loopback-only access, or provide TLS cert and key paths.',
    );
  }
}

export function isSecure(config: TlsConfig): boolean {
  return config.certPath != null && config.keyPath != null;
}

export function isLoopbackAddress(address: string): boolean {
  return isLoopback(address);
}
