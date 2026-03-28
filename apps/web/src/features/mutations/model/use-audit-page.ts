/**
 * useAuditPage — cursor-based paginated audit hook (T035).
 *
 * Fetches first page on mount; loadMore appends subsequent pages.
 * hasMore reflects whether the previous response returned a nextCursor.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { MutationAuditRecord } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';

const PAGE_LIMIT = 20;

export interface AuditPageState {
  records: MutationAuditRecord[];
  isLoading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
}

export function useAuditPage(client: MutationsClient): AuditPageState {
  const [records, setRecords] = useState<MutationAuditRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nextCursorRef = useRef<string | null | undefined>(undefined);
  const isLoadingRef = useRef(false);

  const fetchPage = useCallback(
    (cursor?: string | null) => {
      if (isLoadingRef.current) return;
      isLoadingRef.current = true;
      setIsLoading(true);
      client
        .getAudit({ limit: PAGE_LIMIT, cursor: cursor ?? undefined })
        .then((res) => {
          setRecords((prev) => (cursor == null ? res.records : [...prev, ...res.records]));
          nextCursorRef.current = res.nextCursor;
          setHasMore(res.nextCursor != null);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof MutationsRequestError) {
            setError(err.gatewayError.message);
          } else {
            setError('Unexpected error loading audit records');
          }
        })
        .finally(() => {
          isLoadingRef.current = false;
          setIsLoading(false);
        });
    },
    [client],
  );

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (isLoading || !hasMore) return;
    fetchPage(nextCursorRef.current);
  }, [isLoading, hasMore, fetchPage]);

  return { records, isLoading, hasMore, loadMore, error };
}
