/**
 * Gateway configuration schema with all thresholds. (T085)
 */

export interface GatewayConfig {
  sessionLifetimeMs: number;
  warningThresholdMs: number;
  maxExtensions: number;
  extensionDurationMs: number;
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  rateLimitThreshold: number;
  rateLimitWindowMs: number;
  lockoutDurationMs: number;
  mutatingRateLimitThreshold: number;
  mutatingRateLimitWindowMs: number;
  auditRetentionDays: number;
  heartbeatIntervalMs: number;
  clockDriftToleranceMs: number;
  bindAddress: string;
  certPath?: string;
  keyPath?: string;
  gatewayOrigin: string;
  /**
   * IP allow-list of reverse proxies whose X-Forwarded-For headers are trusted.
   * When empty (default), forwarded headers are ignored and the transport-level
   * remote address is used for rate-limit source keys.
   */
  trustedProxies: string[];
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  sessionLifetimeMs: 8 * 60 * 60 * 1000,
  warningThresholdMs: 15 * 60 * 1000,
  maxExtensions: 3,
  extensionDurationMs: 8 * 60 * 60 * 1000,
  idleTimeoutMs: 30 * 60 * 1000,
  maxConcurrentSessions: 5,
  rateLimitThreshold: 5,
  rateLimitWindowMs: 60_000,
  lockoutDurationMs: 5 * 60 * 1000,
  mutatingRateLimitThreshold: 30,
  mutatingRateLimitWindowMs: 60_000,
  auditRetentionDays: 90,
  heartbeatIntervalMs: 10_000,
  clockDriftToleranceMs: 30_000,
  bindAddress: '127.0.0.1',
  gatewayOrigin: 'http://127.0.0.1:4174',
  trustedProxies: [],
};

export function loadGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const config = { ...DEFAULT_GATEWAY_CONFIG, ...overrides };

  // Validate
  if (config.sessionLifetimeMs <= 0) throw new Error('sessionLifetimeMs must be positive');
  if (config.warningThresholdMs <= 0) throw new Error('warningThresholdMs must be positive');
  if (config.maxExtensions < 0) throw new Error('maxExtensions must be non-negative');
  if (config.idleTimeoutMs <= 0) throw new Error('idleTimeoutMs must be positive');
  if (config.maxConcurrentSessions <= 0) {
    throw new Error('maxConcurrentSessions must be positive');
  }

  return config;
}
