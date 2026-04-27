/** Regression test: ChatContext should not resubscribe on local state updates. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { ChatMsg, ImageAttachment } from '@/features/chat/types';

describe('ChatContext subscription stability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function setup(options?: {
    currentSession?: string;
    sessions?: Array<Record<string, unknown>>;
    rpcImpl?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    loadChatHistoryImpl?: () => Promise<ChatMsg[]>;
    realtimeState?: {
      connection: {
        status: 'connecting' | 'live' | 'degraded' | 'reconnecting' | 'offline';
        lastLiveAt: number;
        lastDisconnectReason: string | null;
        reconcileNeeded: boolean;
        reconnectAttempt: number;
      };
      sessions: Record<string, unknown>;
      runs: Record<string, unknown>;
      messages: Record<string, unknown>;
      agentPresence: Record<string, unknown>;
    };
  }) {
    const subscribeMock = vi.fn(() => () => {});
    const requestSnapshotMock = vi.fn(async () => {});
    const dispatchMock = vi.fn();
    const loadChatHistoryMock = vi.fn(options?.loadChatHistoryImpl ?? (async () => []));
    const rpcMock = vi.fn(options?.rpcImpl ?? (async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1', status: 'started' };
      return {};
    }));
    const gatewayState = {
      connectionState: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'reconnecting',
      rpc: rpcMock,
      subscribe: subscribeMock,
    };
    const sessionState = {
      currentSession: options?.currentSession ?? 'main',
      sessions: options?.sessions ?? [],
    };

    vi.doMock('@/features/chat/operations', async () => {
      const actual = await vi.importActual<typeof import('@/features/chat/operations')>('@/features/chat/operations');
      return {
        ...actual,
        loadChatHistory: loadChatHistoryMock,
      };
    });

    vi.doMock('./GatewayContext', () => ({
      useGateway: () => gatewayState,
    }));

    vi.doMock('./SessionContext', () => ({
      useSessionContext: () => sessionState,
    }));

    vi.doMock('./SettingsContext', () => ({
      useSettings: () => ({
        soundEnabled: false,
        speak: vi.fn(),
      }),
    }));

    const realtimeStateRef = {
      current: options?.realtimeState ?? {
        connection: {
          status: 'offline' as const,
          lastLiveAt: 0,
          lastDisconnectReason: null,
          reconcileNeeded: false,
          reconnectAttempt: 0,
        },
        sessions: {},
        runs: {},
        messages: {},
        agentPresence: {},
      },
    };
    const realtimeState = realtimeStateRef.current;

    vi.doMock('./RealtimeContext', () => ({
      useRealtime: () => ({
        state: realtimeStateRef.current,
        requestSnapshot: requestSnapshotMock,
        dispatch: dispatchMock,
      }),
    }));

    const mod = await import('./ChatContext');
    return {
      ...mod,
      gatewayState,
      subscribeMock,
      loadChatHistoryMock,
      requestSnapshotMock,
      dispatchMock,
      sessionState,
      realtimeState,
      realtimeStateRef,
    };
  }

  it('keeps a single subscribe registration after handleSend-triggered rerender', async () => {
    const { ChatProvider, useChat, subscribeMock } = await setup();

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(1));
    expect(send).not.toBeNull();

    await act(async () => {
      await send!('hello');
    });

    // Regression assertion: local state updates should not cause resubscription churn.
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it('reloads history after reconnect when the session was idle', async () => {
    const { ChatProvider, gatewayState, loadChatHistoryMock } = await setup();

    function Consumer() {
      return null;
    }

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(loadChatHistoryMock).not.toHaveBeenCalled());

    gatewayState.connectionState = 'reconnecting';
    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    gatewayState.connectionState = 'connected';
    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(loadChatHistoryMock).toHaveBeenCalledWith({
        rpc: expect.any(Function),
        sessionKey: 'main',
        limit: 500,
      });
    });
  });

  it('does not run the legacy full history reload during generating reconnect recovery', async () => {
    const { ChatProvider, useChat, gatewayState, loadChatHistoryMock, requestSnapshotMock } = await setup();
    gatewayState.connectionState = 'connected';

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(send).not.toBeNull());

    await act(async () => {
      await send!('hello');
    });

    loadChatHistoryMock.mockClear();
    requestSnapshotMock.mockClear();

    gatewayState.connectionState = 'reconnecting';
    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    gatewayState.connectionState = 'connected';
    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(requestSnapshotMock).toHaveBeenCalledWith('main', 'reconnect');
    });

    expect(loadChatHistoryMock).toHaveBeenCalledWith({
      rpc: expect.any(Function),
      sessionKey: 'main',
      limit: 120,
    });
    expect(loadChatHistoryMock).not.toHaveBeenCalledWith({
      rpc: expect.any(Function),
      sessionKey: 'main',
      limit: 500,
    });
  });

  it('requests a realtime snapshot when a connected session becomes active', async () => {
    const { ChatProvider, gatewayState, requestSnapshotMock } = await setup();
    gatewayState.connectionState = 'connected';

    function Consumer() {
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(requestSnapshotMock).toHaveBeenCalledWith('main', 'session-switch');
    });
  });

  it('dispatches a local realtime run event after send acknowledgement', async () => {
    const { ChatProvider, useChat, dispatchMock } = await setup();

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(send).not.toBeNull());

    await act(async () => {
      await send!('hello');
    });

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run.created',
      sessionId: 'main',
      runId: 'run-1',
      source: 'local',
    }));
  });

  it('does not blind-poll chat history for active subagent sessions', async () => {
    vi.useFakeTimers();

    try {
      const sessionKey = 'agent:main:subagent:worker-1';
      const { ChatProvider, gatewayState, loadChatHistoryMock } = await setup({
        currentSession: sessionKey,
        sessions: [{ sessionKey, state: 'running' }],
      });
      gatewayState.connectionState = 'connected';

      function Consumer() {
        return null;
      }

      render(
        <ChatProvider>
          <Consumer />
        </ChatProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadChatHistoryMock).toHaveBeenCalledWith({
        rpc: expect.any(Function),
        sessionKey,
        limit: 500,
      });

      loadChatHistoryMock.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(3_100);
        await Promise.resolve();
      });

      expect(loadChatHistoryMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['completed', 'error', 'aborted', 'cancelled'])(
    'requests a snapshot reconcile when subagent presence reaches terminal phase %s',
    async (phase) => {
      const sessionKey = 'agent:main:subagent:worker-1';
      const { ChatProvider, gatewayState, requestSnapshotMock, realtimeStateRef } = await setup({
        currentSession: sessionKey,
        sessions: [{ sessionKey, state: phase }],
        realtimeState: {
          connection: {
            status: 'live',
            lastLiveAt: 0,
            lastDisconnectReason: null,
            reconcileNeeded: false,
            reconnectAttempt: 0,
          },
          sessions: {},
          runs: {},
          messages: {},
          agentPresence: {
            [sessionKey]: {
              sessionId: sessionKey,
              agentId: 'main',
              phase: 'running',
              lastSeenAt: 1,
            },
          },
        },
      });
      gatewayState.connectionState = 'connected';

      function Consumer() {
        return null;
      }

      const view = render(
        <ChatProvider>
          <Consumer />
        </ChatProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(requestSnapshotMock).toHaveBeenCalledWith(sessionKey, 'session-switch');

      requestSnapshotMock.mockClear();
      realtimeStateRef.current = {
        ...realtimeStateRef.current,
        agentPresence: {
          ...realtimeStateRef.current.agentPresence,
          [sessionKey]: {
            sessionId: sessionKey,
            agentId: 'main',
            phase,
            lastSeenAt: 2,
          },
        },
      };

      view.rerender(
        <ChatProvider>
          <Consumer />
        </ChatProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(requestSnapshotMock).toHaveBeenCalledWith(sessionKey, 'subagent-complete');
      expect(requestSnapshotMock).toHaveBeenCalledTimes(1);

      view.rerender(
        <ChatProvider>
          <Consumer />
        </ChatProvider>,
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(requestSnapshotMock).toHaveBeenCalledTimes(1);
    },
  );

  it('dispatches the acknowledged run into the session that initiated the send', async () => {
    const deferred = Promise.withResolvers<{ runId: string; status: 'started' }>();
    const sessionKey = 'main';
    const nextSessionKey = 'agent:other:main';
    const { ChatProvider, useChat, dispatchMock, sessionState } = await setup({
      currentSession: sessionKey,
      sessions: [
        { sessionKey, state: 'running' },
        { sessionKey: nextSessionKey, state: 'idle' },
      ],
      rpcImpl: async (method: string) => {
        if (method === 'chat.send') return deferred.promise;
        return {};
      },
    });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return null;
    }

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(send).not.toBeNull());

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = send!('hello');
      await Promise.resolve();
    });

    sessionState.currentSession = nextSessionKey;
    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    deferred.resolve({ runId: 'run-1', status: 'started' });
    await act(async () => {
      await sendPromise;
    });

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run.created',
      sessionId: sessionKey,
      runId: 'run-1',
      source: 'local',
    }));
  });

  it('preserves history-derived metadata when realtime transcript messages are refreshed', async () => {
    const historyMessages: ChatMsg[] = [
      {
        msgId: 'history-assistant',
        role: 'assistant',
        html: '<p>See image</p>',
        rawText: 'See image',
        timestamp: new Date(10),
        extractedImages: [{ url: 'https://example.com/image.png', alt: 'diagram' }],
      },
      {
        msgId: 'history-system',
        role: 'user',
        html: '<p>Subagent completed</p>',
        rawText: 'Subagent completed',
        timestamp: new Date(20),
        isSystemNotification: true,
        systemLabel: 'Subagent completed: worker-1',
      },
    ];
    const realtimeState = {
      connection: {
        status: 'live' as const,
        lastLiveAt: 0,
        lastDisconnectReason: null,
        reconcileNeeded: false,
        reconnectAttempt: 0,
      },
      sessions: { main: { sessionId: 'main', status: 'idle', agentId: 'main', updatedAt: 1, sourceVersion: 'v1' } },
      runs: {},
      messages: {
        'assistant-1': {
          messageId: 'assistant-1',
          sessionId: 'main',
          runId: 'run-1',
          role: 'assistant' as const,
          contentParts: [{ type: 'text' as const, text: 'See image' }],
          status: 'committed' as const,
          revision: 1,
          createdAt: 10,
        },
        'user-1': {
          messageId: 'user-1',
          sessionId: 'main',
          runId: null,
          role: 'user' as const,
          contentParts: [{ type: 'text' as const, text: 'Subagent completed' }],
          status: 'committed' as const,
          revision: 1,
          createdAt: 20,
        },
      },
      agentPresence: {},
    };
    const { ChatProvider, useChat, gatewayState, realtimeStateRef } = await setup({
      currentSession: 'main',
      realtimeState,
      loadChatHistoryImpl: async () => historyMessages,
    });
    gatewayState.connectionState = 'connected';

    let messages: ChatMsg[] = [];

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        messages = chat.messages;
      }, [chat.messages]);
      return null;
    }

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(messages).toHaveLength(2);
      expect(messages.find((message) => message.rawText === 'See image')?.extractedImages).toEqual([
        { url: 'https://example.com/image.png', alt: 'diagram' },
      ]);
    });

    realtimeStateRef.current = {
      ...realtimeStateRef.current,
      messages: {
        ...realtimeStateRef.current.messages,
        'assistant-1': {
          ...realtimeStateRef.current.messages['assistant-1'],
          revision: 2,
        },
        'user-1': {
          ...realtimeStateRef.current.messages['user-1'],
          revision: 2,
        },
      },
    };

    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(messages).toHaveLength(2);
      expect(messages.find((message) => message.rawText === 'See image')?.extractedImages).toEqual([
        { url: 'https://example.com/image.png', alt: 'diagram' },
      ]);
      expect(messages.find((message) => message.rawText === 'Subagent completed')).toEqual(
        expect.objectContaining({
          isSystemNotification: true,
          systemLabel: 'Subagent completed: worker-1',
        }),
      );
    });
  });

  it('does not erase loaded history when realtime only has session metadata', async () => {
    const historyMessages: ChatMsg[] = [
      {
        msgId: 'history-assistant',
        role: 'assistant',
        html: '<p>Existing transcript</p>',
        rawText: 'Existing transcript',
        timestamp: new Date(10),
      },
    ];
    const { ChatProvider, useChat, gatewayState } = await setup({
      currentSession: 'main',
      realtimeState: {
        connection: {
          status: 'live',
          lastLiveAt: 0,
          lastDisconnectReason: null,
          reconcileNeeded: false,
          reconnectAttempt: 0,
        },
        sessions: { main: { sessionId: 'main', status: 'idle', agentId: 'main', updatedAt: 1, sourceVersion: 'v1' } },
        runs: {},
        messages: {},
        agentPresence: {},
      },
      loadChatHistoryImpl: async () => historyMessages,
    });
    gatewayState.connectionState = 'connected';

    let messages: ChatMsg[] = [];

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        messages = chat.messages;
      }, [chat.messages]);
      return null;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(messages).toHaveLength(1);
      expect(messages[0]?.rawText).toBe('Existing transcript');
    });
  });
});
