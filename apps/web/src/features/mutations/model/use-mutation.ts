/**
 * useMutation — generic mutation hook for config/workflow mutations (T022).
 *
 * Manages loading state and error string; calls onSuccess callback on success.
 */
import { useState, useCallback } from 'react';
import { MutationsRequestError } from '../api/mutations-client.ts';

export interface UseMutationOptions<TResponse> {
  onSuccess?: (result: TResponse) => void;
}

export interface UseMutationResult<TRequest> {
  mutate: (body: TRequest) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  reset: () => void;
}

export function useMutation<TRequest, TResponse>(
  mutationFn: (body: TRequest) => Promise<TResponse>,
  options?: UseMutationOptions<TResponse>,
): UseMutationResult<TRequest> {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (body: TRequest) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await mutationFn(body);
        options?.onSuccess?.(result);
      } catch (err: unknown) {
        if (err instanceof MutationsRequestError) {
          setError(err.gatewayError.message);
        } else {
          setError('Unexpected error');
        }
      } finally {
        setIsLoading(false);
      }
    },
    [mutationFn, options],
  );

  const reset = useCallback(() => {
    setError(null);
    setIsLoading(false);
  }, []);

  return { mutate, isLoading, error, reset };
}
