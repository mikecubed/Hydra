/**
 * AuditRow — renders a single MutationAuditRecord as a table row (T036).
 *
 * Displays: actor, timestamp, event-type badge (colour-coded),
 * targetField, before/after values, outcome badge, rejectionReason.
 */
import type { JSX } from 'react';
import type { MutationAuditRecord } from '@hydra/web-contracts';

interface AuditRowProps {
  readonly record: MutationAuditRecord;
}

function formatValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AuditRow({ record }: AuditRowProps): JSX.Element {
  const actor = record.operatorId ?? record.id;
  const isSuccess = record.outcome === 'success';

  return (
    <tr aria-label={`audit-record-${record.id}`}>
      <td>{actor}</td>
      <td>{formatTimestamp(record.timestamp)}</td>
      <td>
        <span
          aria-label="event-type"
          style={{ color: isSuccess ? 'green' : 'red', fontWeight: 'bold' }}
        >
          {record.eventType}
        </span>
      </td>
      <td>
        <code>{record.targetField}</code>
      </td>
      <td>{formatValue(record.beforeValue)}</td>
      <td>{formatValue(record.afterValue)}</td>
      <td>
        <span aria-label="outcome-badge" style={{ color: isSuccess ? 'green' : 'red' }}>
          {record.outcome}
        </span>
      </td>
      <td>{record.rejectionReason ?? ''}</td>
    </tr>
  );
}
