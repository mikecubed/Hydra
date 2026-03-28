/**
 * useMutation hook browser specs.
 *
 * Covers:
 * - happy path: calls mutationFn, sets loading, calls onSuccess
 * - error path: catches MutationsRequestError, exposes message
 * - concurrency guard: second call while loading is a no-op
 * - reset: clears error and loading state
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import { useMutation } from '../model/use-mutation.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import type { GatewayErrorBody } from '../../../shared/gateway-errors.ts';

afterEach(() => {
  cleanup();
});

function makeError(message: string): MutationsRequestError {
  const body: GatewayErrorBody = {
    ok: false,
    code: 'DAEMON_ERROR',
    category: 'daemon',
    message,
  };
  return new MutationsRequestError(500, body);
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
});
