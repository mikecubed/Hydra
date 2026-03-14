/**
 * hydra-cache.ts — LRU cache with TTL, content hashing, and negative cache
 *
 * Provides named-namespace caching for deterministic operations,
 * routing classification results, and failure tracking.
 *
 * Zero Hydra imports — sits at the bottom of the import tree.
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// LRU Cache with TTL
// ---------------------------------------------------------------------------

interface LRUCacheOpts {
  maxEntries?: number;
  ttlSec?: number;
}

interface CacheStats {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
}

class CacheEntry<V> {
  value: V;
  expires: number;
  hits: number;
  createdAt: number;

  constructor(value: V, ttlMs: number) {
    this.value = value;
    this.expires = Date.now() + ttlMs;
    this.hits = 0;
    this.createdAt = Date.now();
  }

  isExpired(): boolean {
    return Date.now() > this.expires;
  }
}

class LRUCache<K = string, V = unknown> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly _data = new Map<K, CacheEntry<V>>();
  private _hits = 0;
  private _misses = 0;

  constructor(opts: LRUCacheOpts = {}) {
    this.maxEntries = opts.maxEntries ?? 1000;
    this.ttlMs = (opts.ttlSec ?? 300) * 1000;
  }

  get(key: K): V | undefined {
    const entry = this._data.get(key);
    if (!entry || entry.isExpired()) {
      if (entry) this._data.delete(key);
      this._misses++;
      return undefined;
    }
    entry.hits++;
    this._hits++;
    // Move to end (most recently used)
    this._data.delete(key);
    this._data.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    // Evict oldest if at capacity
    if (this._data.size >= this.maxEntries && !this._data.has(key)) {
      const oldest = this._data.keys().next().value as K;
      this._data.delete(oldest);
    }
    this._data.set(key, new CacheEntry(value, ttlMs ?? this.ttlMs));
  }

  has(key: K): boolean {
    const entry = this._data.get(key);
    if (!entry || entry.isExpired()) {
      if (entry) this._data.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    return this._data.delete(key);
  }

  clear(): void {
    this._data.clear();
    this._hits = 0;
    this._misses = 0;
  }

  get size(): number {
    return this._data.size;
  }

  getStats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      size: this._data.size,
      maxEntries: this.maxEntries,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }

  /** Remove expired entries (housekeeping). */
  prune(): number {
    let pruned = 0;
    for (const [key, entry] of this._data) {
      if (entry.isExpired()) {
        this._data.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

export function contentHash(data: unknown): string {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ---------------------------------------------------------------------------
// Singleton namespace caches
// ---------------------------------------------------------------------------

const _caches: Partial<Record<string, LRUCache>> = {};

function _getCache(namespace: string): LRUCache {
  let cache = _caches[namespace];
  if (!cache) {
    cache = new LRUCache({ maxEntries: 1000, ttlSec: 300 });
    _caches[namespace] = cache;
  }
  return cache;
}

interface InitCachesConfig {
  enabled?: boolean;
  maxEntries?: number;
  ttlSec?: number;
  negativeCache?: { maxEntries?: number; ttlSec?: number };
}

/** Initialize caches from config. Call once at startup if custom sizes needed. */
export function initCaches(config: InitCachesConfig = {}): void {
  if (config.enabled !== true) return;
  const defaults = { maxEntries: config.maxEntries ?? 1000, ttlSec: config.ttlSec ?? 300 };
  _caches['routing'] = new LRUCache(defaults);
  _caches['agent'] = new LRUCache(defaults);
  _caches['negative'] = new LRUCache({
    maxEntries: config.negativeCache?.maxEntries ?? 200,
    ttlSec: config.negativeCache?.ttlSec ?? 180,
  });
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

export function getCached(namespace: string, key: string): unknown {
  return _getCache(namespace).get(key);
}

export function setCached(namespace: string, key: string, value: unknown, ttlMs?: number): void {
  _getCache(namespace).set(key, value, ttlMs);
}

export function invalidateCache(namespace: string, key?: string): void {
  if (key === undefined) {
    _getCache(namespace).clear();
  } else {
    _getCache(namespace).delete(key);
  }
}

// ---------------------------------------------------------------------------
// Negative cache (record failures to skip retries)
// ---------------------------------------------------------------------------

export function recordNegativeHit(namespace: string, key: string, error: unknown): void {
  const negKey = `${namespace}:${key}`;
  _getCache('negative').set(negKey, {
    error: (() => {
      if (typeof error === 'string') return error;
      if (error instanceof Error) return error.message;
      return 'unknown';
    })(),
    timestamp: Date.now(),
  });
}

export function isNegativeHit(namespace: string, key: string): boolean {
  const negKey = `${namespace}:${key}`;
  return _getCache('negative').has(negKey);
}

// ---------------------------------------------------------------------------
// Stats & maintenance
// ---------------------------------------------------------------------------

export function getCacheStats(): Record<string, CacheStats> {
  const stats: Record<string, CacheStats> = {};
  for (const [name, cache] of Object.entries(_caches)) {
    if (cache) stats[name] = cache.getStats();
  }
  return stats;
}

export function clearAllCaches(): void {
  for (const cache of Object.values(_caches)) {
    cache?.clear();
  }
}

export function pruneExpired(): number {
  let total = 0;
  for (const cache of Object.values(_caches)) {
    if (cache) total += cache.prune();
  }
  return total;
}

// For testing
export { LRUCache };
