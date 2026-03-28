/**
 * useSafeConfig — fetches GET /config/safe on mount and exposes revision (T021).
 *
 * Does not auto-poll; call `refetch()` to refresh.
 * Revision is extracted from `GetSafeConfigResponse.revision` for use by mutation callers.
 */
import { useState, useEffect, useCallback, type JSX } from 'react';
import type { SafeConfigView } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';

export interface SafeConfigState {
  config: SafeConfigView | null;
  revision: string | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useSafeConfig(client: MutationsClient): SafeConfigState {
  const [config, setConfig] = useState<SafeConfigView | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(() => {
    setIsLoading(true);
    client
      .getSafeConfig()
      .then((res) => {
        setConfig(res.config);
        setRevision(res.revision);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof MutationsRequestError) {
          setError(err.gatewayError.message);
        } else {
          setError('Unexpected error loading config');
        }
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [client]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  return { config, revision, isLoading, error, refetch: fetchConfig };
}

// Suppress unused JSX import warning — react-jsx transform requires React in scope
void (undefined as unknown as typeof JSX);
