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
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 5_000);
  try {
    const res = await fetch(`${url}/status`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

export class DaemonHeartbeat {
  private readonly sessionService: SessionService;
  private readonly store: SessionStore;
  private readonly config: DaemonHeartbeatConfig;
  private readonly checkHealth: HealthChecker;
  private timer: ReturnType<typeof setInterval> | null = null;
  private daemonHealthy: boolean | null = null;

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
    if (this.timer != null) {
      return;
    }

    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isDaemonHealthy(): boolean {
    return this.daemonHealthy === true;
  }

  async tick(): Promise<void> {
    const healthy = await this.checkHealth(this.config.daemonUrl);
    const previousHealth = this.daemonHealthy;
    this.daemonHealthy = healthy;

    if (!healthy) {
      if (previousHealth === false) {
        return;
      }

      await this.transitionAllActive('daemon-down');
      return;
    }

    if (previousHealth !== true) {
      await this.transitionAllDaemonUnreachable('daemon-up');
    }
  }

  private async transitionAllActive(_action: 'daemon-down'): Promise<void> {
    const sessions = this.getAllActiveSessions();
    const eligible = sessions.filter((s) => s.state === 'active' || s.state === 'expiring-soon');
    await Promise.all(eligible.map((s) => this.sessionService.markDaemonDown(s.id)));
  }

  private async transitionAllDaemonUnreachable(_action: 'daemon-up'): Promise<void> {
    const sessions = this.getAllActiveSessions();
    const eligible = sessions.filter((s) => s.state === 'daemon-unreachable');
    await Promise.all(
      eligible.map(async (s) => {
        try {
          await this.sessionService.validate(s.id);
          await this.sessionService.markDaemonUp(s.id);
        } catch {
          // Session expired during outage — already transitioned by validate
        }
      }),
    );
  }

  private getAllActiveSessions() {
    return this.store.listAll().filter((s) => !isTerminal(s.state));
  }
}
