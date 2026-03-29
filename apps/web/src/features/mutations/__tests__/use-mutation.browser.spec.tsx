/**
 * useMutation hook browser specs.
 *
 * Covers:
 * - happy path: calls mutationFn, sets loading, calls onSuccess
 * - error path: catches MutationsRequestError, exposes message
 * - concurrency guard: second call while loading is a no-op
 * - reset: clears error and loading state
 * - T013: errorCategory and retryAfterMs exposed from gateway errors
 * - T013: onRejected callback invoked on mutation failure
 * - T013: preserves original error message from non-MutationsRequestError
 * - T013: stale-revision category propagated
 * - T013: rate-limit retryAfterMs propagated
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import { useMutation } from '../model/use-mutation.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import type { GatewayErrorBody } from '../../../shared/gateway-errors.ts';

afterEach(() => {
  cleanup();
});

function makeError(message: string, overrides?: Partial<GatewayErrorBody>): MutationsRequestError {
  const body: GatewayErrorBody = {
    ok: false,
    code: 'DAEMON_ERROR',
    category: 'daemon',
    message,
    ...overrides,
  };
  return new MutationsRequestError(overrides?.httpStatus ?? 500, body);
}

describe('useMutation', () => {
  it('calls mutationFn and invokes onSuccess on success', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMutation(fn, { onSuccess }));

    await act(async () => {
      await result.current.mutate({ foo: 'bar' });
    });

    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith({ foo: 'bar' });
    expect(onSuccess).toHaveBeenCalledWith({ ok: true });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets error from MutationsRequestError and clears loading', async () => {
    const fn = vi.fn().mockRejectedValue(makeError('Daemon down'));
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe('Daemon down');
  });

  it('sets generic error for unknown throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.error).toBe('network');
  });

  it('falls back to "Unexpected error" for non-Error throws', async () => {
    const fn = vi.fn().mockRejectedValue('string-throw');
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.error).toBe('Unexpected error');
  });

  it('concurrency guard: second mutate call while loading is a no-op', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((res) => {
      resolveFirst = res;
    });
    const fn = vi.fn().mockReturnValueOnce(first).mockResolvedValue(null);

    const { result } = renderHook(() => useMutation(fn));

    // Start first call — do not await
    act(() => {
      void result.current.mutate({ call: 1 });
    });

    // While first call is in-flight, fire second call
    await act(async () => {
      await result.current.mutate({ call: 2 });
    });

    // Resolve first
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });

    // fn should only have been called once — second call was blocked
    expect(fn).toHaveBeenCalledOnce();
  });

  it('same-tick concurrency: only one call enters mutationFn', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((res) => {
      resolveFirst = res;
    });
    const fn = vi.fn().mockReturnValueOnce(first).mockResolvedValue(null);

    const { result } = renderHook(() => useMutation(fn));

    // Fire two mutate calls synchronously in the same tick — before any rerender
    await act(async () => {
      void result.current.mutate({ call: 1 });
      void result.current.mutate({ call: 2 });
    });

    // Resolve the first (and only) inflight call
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });

    // The ref-based guard must block the second synchronous call
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith({ call: 1 });
  });

  it('reset clears error and loading', async () => {
    const fn = vi.fn().mockRejectedValue(makeError('err'));
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.error).toBe('err');

    act(() => {
      result.current.reset();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  // ── T013: category-aware error handling ─────────────────────────────────

  it('exposes errorCategory from MutationsRequestError', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        makeError('Stale revision', { category: 'stale-revision', code: 'STALE_REVISION' }),
      );
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.errorCategory).toBe('stale-revision');
  });

  it('exposes retryAfterMs from rate-limit rejection', async () => {
    const fn = vi.fn().mockRejectedValue(
      makeError('Too many requests', {
        category: 'rate-limit',
        code: 'RATE_LIMITED',
        retryAfterMs: 5000,
        httpStatus: 429,
      }),
    );
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.errorCategory).toBe('rate-limit');
    expect(result.current.retryAfterMs).toBe(5000);
  });

  it('calls onRejected callback on mutation failure', async () => {
    const fn = vi.fn().mockRejectedValue(makeError('rejected'));
    const onRejected = vi.fn();
    const { result } = renderHook(() => useMutation(fn, { onRejected }));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(onRejected).toHaveBeenCalledOnce();
  });

  it('does not call onRejected on success', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useMutation(fn, { onRejected }));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(onRejected).not.toHaveBeenCalled();
  });

  it('resets errorCategory and retryAfterMs on reset', async () => {
    const fn = vi.fn().mockRejectedValue(
      makeError('rate limited', {
        category: 'rate-limit',
        code: 'RATE_LIMITED',
        retryAfterMs: 3000,
        httpStatus: 429,
      }),
    );
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.errorCategory).toBe('rate-limit');
    expect(result.current.retryAfterMs).toBe(3000);

    act(() => {
      result.current.reset();
    });

    expect(result.current.errorCategory).toBeNull();
    expect(result.current.retryAfterMs).toBeNull();
  });

  it('errorCategory is null for non-MutationsRequestError throws', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('type fail'));
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });

    expect(result.current.error).toBe('type fail');
    expect(result.current.errorCategory).toBeNull();
    expect(result.current.retryAfterMs).toBeNull();
  });

  it('clears previous error state before each mutation attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        makeError('first', { category: 'stale-revision', code: 'STALE_REVISION' }),
      )
      .mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => useMutation(fn));

    await act(async () => {
      await result.current.mutate({});
    });
    expect(result.current.errorCategory).toBe('stale-revision');

    await act(async () => {
      await result.current.mutate({});
    });
    expect(result.current.error).toBeNull();
    expect(result.current.errorCategory).toBeNull();
    expect(result.current.retryAfterMs).toBeNull();
  });
});
