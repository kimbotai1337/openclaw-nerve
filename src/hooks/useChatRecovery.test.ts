import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatRecovery } from './useChatRecovery';

describe('useChatRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requests snapshot reconcile for reconnect recovery', async () => {
    const requestSnapshot = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useChatRecovery({
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        setStream: vi.fn(),
      }),
    );

    act(() => {
      result.current.triggerRecovery('reconnect');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(requestSnapshot).toHaveBeenCalledWith('agent:main:main', 'reconnect');
  });

  it('maps unrenderable finals to a snapshot reconcile reason', async () => {
    const requestSnapshot = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useChatRecovery({
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        setStream: vi.fn(),
      }),
    );

    act(() => {
      result.current.triggerRecovery('unrenderable-final');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(requestSnapshot).toHaveBeenCalledWith('agent:main:main', 'missing-run-activity');
  });

  it('drops stale pending recovery when the generation changes first', async () => {
    const requestSnapshot = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useChatRecovery({
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        setStream: vi.fn(),
      }),
    );

    act(() => {
      result.current.triggerRecovery('chat-gap');
      result.current.incrementGeneration();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(requestSnapshot).not.toHaveBeenCalled();
  });
});
