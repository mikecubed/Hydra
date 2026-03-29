/**
 * AuditPanel — paginated audit table with empty state + load more (T037).
 *
 * Calls useAuditPage() on mount; renders AuditRow for each record.
 * "Load more" button disabled when !hasMore || isLoading.
 * Empty state renders "No mutations recorded yet." (US6 AC-4).
 */
import type { JSX } from 'react';
import type { MutationsClient } from '../api/mutations-client.ts';
import { useAuditPage } from '../model/use-audit-page.ts';
import { AuditRow } from './audit-row.tsx';

interface AuditPanelProps {
  readonly client: MutationsClient;
}

export function AuditPanel({ client }: AuditPanelProps): JSX.Element {
  const { records, isLoading, hasMore, loadMore, error } = useAuditPage(client);

  return (
    <section aria-label="Mutation audit log">
      {error != null && <p role="alert">{error}</p>}

      {isLoading && records.length === 0 && (
        <p aria-label="loading-indicator">Loading audit records…</p>
      )}

      {!isLoading && records.length === 0 && error == null && (
        <p aria-label="empty-state">No mutations recorded yet.</p>
      )}

      {records.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Actor</th>
              <th>Timestamp</th>
              <th>Event</th>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
              <th>Outcome</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <AuditRow key={record.id} record={record} />
            ))}
          </tbody>
        </table>
      )}

      <button
        type="button"
        onClick={loadMore}
        disabled={!hasMore || isLoading}
        aria-label="Load more audit records"
      >
        {isLoading ? 'Loading…' : 'Load more'}
      </button>
    </section>
  );
}
