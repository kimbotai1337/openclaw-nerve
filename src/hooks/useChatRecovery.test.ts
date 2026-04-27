import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMsg } from '@/features/chat/types';
import type { RunState } from '@/features/chat/operations';
const { loadChatHistoryMock } = vi.hoisted(() => ({
  loadChatHistoryMock: vi.fn(),
}));
vi.mock('@/features/chat/operations', async () => {
  const actual = await vi.importActual<typeof import('@/features/chat/operations')>('@/features/chat/operations');
  return {
    ...actual,
    loadChatHistory: loadChatHistoryMock,
  };
});
import { useChatRecovery } from './useChatRecovery';

function makeMessage(overrides: Partial<ChatMsg> = {}): ChatMsg {
  return {
    msgId: overrides.msgId ?? 'msg-1',
    role: overrides.role ?? 'assistant',
    html: overrides.html ?? '',
    rawText: overrides.rawText ?? '',
    timestamp: overrides.timestamp ?? new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('useChatRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadChatHistoryMock.mockReset();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requests snapshot reconcile for reconnect recovery', async () => {
    const requestSnapshot = vi.fn(async () => {});
    const rpc = vi.fn(async () => ({}));
    const applyMessageWindow = vi.fn();
    loadChatHistoryMock.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useChatRecovery({
        rpc,
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        runsRef: { current: new Map<string, RunState>() },
        getAllMessages: () => [],
        applyMessageWindow,
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
    expect(loadChatHistoryMock).toHaveBeenCalledWith({
      rpc,
      sessionKey: 'agent:main:main',
      limit: 120,
    });
    expect(applyMessageWindow).toHaveBeenCalledWith([], false);
  });

  it('maps unrenderable finals to a snapshot reconcile reason', async () => {
    const requestSnapshot = vi.fn(async () => {});
    loadChatHistoryMock.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useChatRecovery({
        rpc: vi.fn(async () => ({})),
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        runsRef: { current: new Map<string, RunState>() },
        getAllMessages: () => [],
        applyMessageWindow: vi.fn(),
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

  it('repairs visible history even when snapshot reconcile fails', async () => {
    const requestSnapshot = vi.fn(async () => {
      throw new Error('snapshot-down');
    });
    const rpc = vi.fn(async () => ({}));
    const applyMessageWindow = vi.fn();
    loadChatHistoryMock.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useChatRecovery({
        rpc,
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        runsRef: { current: new Map<string, RunState>() },
        getAllMessages: () => [],
        applyMessageWindow,
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
    expect(loadChatHistoryMock).toHaveBeenCalledWith({
      rpc,
      sessionKey: 'agent:main:main',
      limit: 120,
    });
    expect(applyMessageWindow).toHaveBeenCalledWith([], false);
  });

  it('starts visible repair without waiting for snapshot reconcile to settle', async () => {
    const requestSnapshot = vi.fn(() => new Promise<void>(() => {}));
    const rpc = vi.fn(async () => ({}));
    const applyMessageWindow = vi.fn();
    loadChatHistoryMock.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useChatRecovery({
        rpc,
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        runsRef: { current: new Map<string, RunState>() },
        getAllMessages: () => [],
        applyMessageWindow,
        setStream: vi.fn(),
      }),
    );

    act(() => {
      result.current.triggerRecovery('reconnect');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
      await Promise.resolve();
    });

    expect(requestSnapshot).toHaveBeenCalledWith('agent:main:main', 'reconnect');
    expect(loadChatHistoryMock).toHaveBeenCalledWith({
      rpc,
      sessionKey: 'agent:main:main',
      limit: 120,
    });
    expect(applyMessageWindow).toHaveBeenCalledWith([], false);
  });

  it('drops stale pending recovery when the generation changes first', async () => {
    const requestSnapshot = vi.fn(async () => {});
    const applyMessageWindow = vi.fn();

    const { result } = renderHook(() =>
      useChatRecovery({
        rpc: vi.fn(async () => ({})),
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        runsRef: { current: new Map<string, RunState>() },
        getAllMessages: () => [],
        applyMessageWindow,
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
    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(applyMessageWindow).not.toHaveBeenCalled();
  });

  it('filters duplicate streamed assistant text when repairing visible history', async () => {
    const requestSnapshot = vi.fn(async () => {});
    const duplicateText = 'This is a long streamed assistant message that should be filtered.';
    const existing = [makeMessage({ msgId: 'user-1', role: 'user', rawText: 'hi', html: 'hi' })];
    const applyMessageWindow = vi.fn();
    const runs = new Map<string, RunState>();
    runs.set('run-1', {
      runId: 'run-1',
      sessionId: 'agent:main:main',
      status: 'started',
      startedAt: Date.now(),
      lastChatSeq: null,
      lastFrameSeq: null,
      bufferRaw: duplicateText,
      bufferText: duplicateText,
      finalized: false,
    });
    loadChatHistoryMock.mockResolvedValue([
      makeMessage({ msgId: 'assistant-1', role: 'assistant', rawText: duplicateText, html: duplicateText }),
    ]);

    const { result } = renderHook(() =>
      useChatRecovery({
        rpc: vi.fn(async () => ({})),
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        runsRef: { current: runs },
        getAllMessages: () => existing,
        applyMessageWindow,
        setStream: vi.fn(),
      }),
    );

    act(() => {
      result.current.triggerRecovery('chat-gap');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(applyMessageWindow).toHaveBeenCalledWith(existing, false);
  });

  it('does not apply recovered history after generation changes during visible repair', async () => {
    const requestSnapshot = vi.fn(async () => {});
    const applyMessageWindow = vi.fn();
    let resolveHistory: ((value: ChatMsg[]) => void) | null = null;
    loadChatHistoryMock.mockImplementation(() => new Promise((resolve) => {
      resolveHistory = resolve;
    }));

    const { result } = renderHook(() =>
      useChatRecovery({
        rpc: vi.fn(async () => ({})),
        requestSnapshot,
        currentSessionRef: { current: 'agent:main:main' },
        isGeneratingRef: { current: true },
        activeRunIdRef: { current: 'run-1' },
        runsRef: { current: new Map<string, RunState>() },
        getAllMessages: () => [],
        applyMessageWindow,
        setStream: vi.fn(),
      }),
    );

    act(() => {
      result.current.triggerRecovery('chat-gap');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });

    act(() => {
      result.current.incrementGeneration();
    });

    await act(async () => {
      resolveHistory?.([makeMessage({ msgId: 'assistant-1', rawText: 'late', html: 'late' })]);
      await Promise.resolve();
    });

    expect(applyMessageWindow).not.toHaveBeenCalled();
  });
});
