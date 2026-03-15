/**
 * Daemon heartbeat monitor — periodic health check. (FR-010, FR-015)
 * Transitions active → daemon-unreachable on failure; restores on recovery.
 */
import { type SessionService } from './session-service.ts';
import { type SessionStore } from './session-store.ts';
import { isTerminal } from './session-state-machine.ts';

export interface DaemonHeartbeatConfig {
  intervalMs: number;
  daemonUrl: string;
}

const DEFAULT_CONFIG: DaemonHeartbeatConfig = {
  intervalMs: 10_000,
  daemonUrl: 'http://127.0.0.1:4173',
};

export type HealthChecker = (url: string) => Promise<boolean>;

/** Default production health checker — pings the daemon's /status endpoint. */
export const defaultHealthChecker: HealthChecker = async (url: string): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 5_000);
    const res = await fetch(`${url}/status`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
};

export class DaemonHeartbeat {
  private readonly sessionService: SessionService;
  private readonly store: SessionStore;
  private readonly config: DaemonHeartbeatConfig;
  private readonly checkHealth: HealthChecker;
  private timer: ReturnType<typeof setInterval> | null = null;
  private daemonHealthy = true;

  constructor(
    sessionService: SessionService,
    store: SessionStore,
    checkHealth: HealthChecker,
    config: Partial<DaemonHeartbeatConfig> = {},
  ) {
    this.sessionService = sessionService;
    this.store = store;
    this.checkHealth = checkHealth;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isDaemonHealthy(): boolean {
    return this.daemonHealthy;
  }

  async tick(): Promise<void> {
    const healthy = await this.checkHealth(this.config.daemonUrl);

    if (!healthy && this.daemonHealthy) {
      // Daemon went down
      this.daemonHealthy = false;
      await this.transitionAllActive('daemon-down');
    } else if (healthy && !this.daemonHealthy) {
      // Daemon recovered
      this.daemonHealthy = true;
      await this.transitionAllDaemonUnreachable('daemon-up');
    }
  }

  private async transitionAllActive(_action: 'daemon-down'): Promise<void> {
    // We need all non-terminal sessions. Since we can't easily iterate
    // the store's internal map, we use the public API via operator lists.
    // For simplicity, iterate by getting all sessions from the store.
    // This works because DaemonHeartbeat has access to the store.
    const sessions = this.getAllActiveSessions();
    for (const s of sessions) {
      if (s.state === 'active' || s.state === 'expiring-soon') {
        await this.sessionService.markDaemonDown(s.id);
      }
    }
  }

  private async transitionAllDaemonUnreachable(_action: 'daemon-up'): Promise<void> {
    const sessions = this.getAllActiveSessions();
    for (const s of sessions) {
      if (s.state === 'daemon-unreachable') {
        // Check if expired during outage — validate will handle expiry transition
        try {
          await this.sessionService.validate(s.id);
          await this.sessionService.markDaemonUp(s.id);
        } catch {
          // Session expired during outage — already transitioned by validate
        }
      }
    }
  }

  private getAllActiveSessions() {
    // Access internal store for iteration. Store exposes listByOperator but
    // we need all sessions. We'll use a small hack via the store's sessions map.
    // @ts-expect-error — accessing internal state for system-level operation
    const map = this.store.sessions;
    return [...map.values()].filter((s) => !isTerminal(s.state));
  }
}
