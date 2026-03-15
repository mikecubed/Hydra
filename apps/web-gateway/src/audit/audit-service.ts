/**
 * Audit service — records security-relevant events. (FR-013)
 * Validates against AuditEventType enum; delegates to store.
 */
import { randomBytes } from 'node:crypto';
import { AuditEventType, type AuditRecord } from '@hydra/web-contracts';
import { type AuditStore } from './audit-store.ts';
import type { Clock } from '../shared/clock.ts';
import { SystemClock } from '../shared/clock.ts';

export class AuditService {
  private readonly store: AuditStore;
  private readonly clock: Clock;

  constructor(store: AuditStore, clock: Clock = new SystemClock()) {
    this.store = store;
    this.clock = clock;
  }

  async record(
    eventType: string,
    operatorId: string | null,
    sessionId: string | null,
    detail: Record<string, unknown>,
    outcome: 'success' | 'failure',
    sourceIp?: string,
  ): Promise<AuditRecord> {
    // Validate event type
    const parsed = AuditEventType.safeParse(eventType);
    if (!parsed.success) {
      throw new Error(`Invalid audit event type: ${eventType}`);
    }

    const record: AuditRecord = {
      id: randomBytes(16).toString('hex'),
      timestamp: new Date(this.clock.now()).toISOString(),
      eventType: parsed.data,
      operatorId,
      sessionId,
      outcome,
      detail,
      sourceIp,
    };

    await this.store.append(record);
    return record;
  }

  getRecords(): readonly AuditRecord[] {
    return this.store.getRecords();
  }
}
