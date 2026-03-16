/**
 * Credential hashing utilities — node:crypto, per-credential salt,
 * constant-time comparison. (FR-002, data-model Credential entity)
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 32;
const KEY_LENGTH = 64;
const SCRYPT_COST = 16384;

export interface HashedCredential {
  hash: string;
  salt: string;
}

export async function hashSecret(secret: string): Promise<HashedCredential> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = await deriveKey(secret, salt);
  return { hash, salt };
}

export async function verifySecret(
  secret: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  const derived = await deriveKey(secret, salt);
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function deriveKey(secret: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LENGTH, { cost: SCRYPT_COST }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}
