/**
 * Audit store — append-only file log. (FR-013, FR-014)
 * Write-side only; query routes deferred to Phase 4.
 */
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditRecord } from '@hydra/web-contracts';

export class AuditStore {
  private readonly filePath: string | null;
  private records: AuditRecord[] = [];

  constructor(filePath: string | null = null) {
    this.filePath = filePath;
  }

  async append(record: AuditRecord): Promise<void> {
    this.records.push(record);

    if (this.filePath != null) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    }
  }

  getRecords(): readonly AuditRecord[] {
    return this.records;
  }

  async load(): Promise<void> {
    if (this.filePath == null) return;
    try {
      const data = await readFile(this.filePath, 'utf-8');
      this.records = data
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditRecord);
    } catch {
      this.records = [];
    }
  }
}
