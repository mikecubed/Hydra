/**
 * useMutation — generic mutation hook for config/workflow mutations (T022, T013).
 *
 * Manages loading state, error detail, and category-aware rejection handling.
 * Exposes `errorCategory` and `retryAfterMs` so callers can render
 * stale-revision, rate-limit, and other category-specific recovery UX (FD-4/7/8).
 * Calls `onRejected` on failure so the caller can roll back to authoritative state.
 */
import { useState, useCallback, useRef } from 'react';
import { MutationsRequestError } from '../api/mutations-client.ts';
import type { ErrorCategory } from '../../../shared/gateway-errors.ts';

export interface UseMutationOptions<TResponse> {
  onSuccess?: (result: TResponse) => void;
  /** Called on mutation rejection — use to roll back optimistic UI to authoritative state. */
  onRejected?: () => void;
}

export interface UseMutationResult<TRequest> {
  mutate: (body: TRequest) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  /** Gateway error category when the error came from a structured gateway response. */
  errorCategory: ErrorCategory | null;
  /** Retry-after hint in ms from a rate-limit rejection, if provided by the gateway. */
  retryAfterMs: number | null;
  reset: () => void;
}

function setInflight(ref: { current: boolean }, value: boolean): void {
  ref.current = value;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  return 'Unexpected error';
}

export function useMutation<TRequest, TResponse>(
  mutationFn: (body: TRequest) => Promise<TResponse>,
  options?: UseMutationOptions<TResponse>,
): UseMutationResult<TRequest> {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCategory, setErrorCategory] = useState<ErrorCategory | null>(null);
  const [retryAfterMs, setRetryAfterMs] = useState<number | null>(null);
  const inflight = useRef(false);

  const mutate = useCallback(
    async (body: TRequest) => {
      if (inflight.current) return;
      setInflight(inflight, true);
      setIsLoading(true);
      setError(null);
      setErrorCategory(null);
      setRetryAfterMs(null);
      try {
        const result = await mutationFn(body);
        options?.onSuccess?.(result);
      } catch (err: unknown) {
        if (err instanceof MutationsRequestError) {
          setError(err.gatewayError.message);
          setErrorCategory(err.gatewayError.category);
          setRetryAfterMs(err.gatewayError.retryAfterMs ?? null);
        } else {
          setError(extractErrorMessage(err));
          setErrorCategory(null);
          setRetryAfterMs(null);
        }
        options?.onRejected?.();
      } finally {
        setInflight(inflight, false);
        setIsLoading(false);
      }
    },
    [mutationFn, options],
  );

  const reset = useCallback(() => {
    setError(null);
    setErrorCategory(null);
    setRetryAfterMs(null);
    setIsLoading(false);
  }, []);

  return { mutate, isLoading, error, errorCategory, retryAfterMs, reset };
}
