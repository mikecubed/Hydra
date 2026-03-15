/**
 * Session store — in-memory Map with cryptographically random IDs.
 * Periodic file snapshot support for persistence.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionState } from '@hydra/web-contracts';

export interface StoredSession {
  id: string;
  operatorId: string;
  state: SessionState;
  createdAt: string;
  expiresAt: string;
  lastActivityAt: string;
  extendedCount: number;
  invalidatedReason: string | null;
  createdFromIp: string;
  csrfToken: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly filePath: string | null;

  constructor(filePath: string | null = null) {
    this.filePath = filePath;
  }

  create(operatorId: string, expiresAt: string, sourceIp: string, now?: string): StoredSession {
    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const timestamp = now ?? new Date().toISOString();
    const session: StoredSession = {
      id,
      operatorId,
      state: 'active',
      createdAt: timestamp,
      expiresAt,
      lastActivityAt: timestamp,
      extendedCount: 0,
      invalidatedReason: null,
      createdFromIp: sourceIp,
      csrfToken,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  listAll(): StoredSession[] {
    return [...this.sessions.values()];
  }

  listByOperator(operatorId: string): StoredSession[] {
    return [...this.sessions.values()].filter((s) => s.operatorId === operatorId);
  }

  update(id: string, updates: Partial<StoredSession>): StoredSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    Object.assign(session, updates);
    return session;
  }

  async snapshot(): Promise<void> {
    if (this.filePath == null) return;
    const data = JSON.stringify([...this.sessions.values()], null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, data, 'utf-8');
  }

  async loadSnapshot(): Promise<void> {
    if (this.filePath == null) return;
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const sessions: StoredSession[] = JSON.parse(data) as StoredSession[];
      this.sessions.clear();
      for (const s of sessions) {
        this.sessions.set(s.id, s);
      }
    } catch {
      // No snapshot yet
    }
  }
}
