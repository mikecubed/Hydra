/**
 * Operator store — in-memory + JSON file persistence.
 * CRUD for operators and credentials.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hashSecret } from './credential-utils.ts';

export interface StoredCredential {
  id: string;
  operatorId: string;
  type: string;
  hashedSecret: string;
  salt: string;
  createdAt: string;
  lastUsedAt: string | null;
  isRevoked: boolean;
}

export interface StoredOperator {
  id: string;
  displayName: string;
  createdAt: string;
  isActive: boolean;
  credentials: StoredCredential[];
}

export class OperatorStore {
  private readonly operators = new Map<string, StoredOperator>();
  private readonly filePath: string | null;

  constructor(filePath: string | null = null) {
    this.filePath = filePath;
  }

  async createOperator(id: string, displayName: string): Promise<StoredOperator> {
    if (this.operators.has(id)) {
      throw new Error(`Operator ${id} already exists`);
    }
    const op: StoredOperator = {
      id,
      displayName,
      createdAt: new Date().toISOString(),
      isActive: true,
      credentials: [],
    };
    this.operators.set(id, op);
    await this.persist();
    return op;
  }

  async addCredential(
    operatorId: string,
    secret: string,
    type = 'password',
  ): Promise<StoredCredential> {
    const op = this.operators.get(operatorId);
    if (!op) throw new Error(`Operator ${operatorId} not found`);

    const { hash, salt } = await hashSecret(secret);
    const cred: StoredCredential = {
      id: randomBytes(16).toString('hex'),
      operatorId,
      type,
      hashedSecret: hash,
      salt,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      isRevoked: false,
    };
    op.credentials.push(cred);
    await this.persist();
    return cred;
  }

  getOperator(id: string): StoredOperator | undefined {
    return this.operators.get(id);
  }

  getOperatorByIdentity(identity: string): StoredOperator | undefined {
    return this.operators.get(identity);
  }

  async disableOperator(id: string): Promise<void> {
    const op = this.operators.get(id);
    if (!op) throw new Error(`Operator ${id} not found`);
    op.isActive = false;
    await this.persist();
  }

  async load(): Promise<void> {
    if (this.filePath == null) return;
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const operators: StoredOperator[] = JSON.parse(data) as StoredOperator[];
      this.operators.clear();
      for (const op of operators) {
        this.operators.set(op.id, op);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private async persist(): Promise<void> {
    if (this.filePath == null) return;
    const data = JSON.stringify([...this.operators.values()], null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, data, 'utf-8');
  }
}
