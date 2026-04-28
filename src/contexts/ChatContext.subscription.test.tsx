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

  it('retries session-switch snapshot reconcile after a transient failure on the next reconnect', async () => {
    const transientFailure = Promise.reject(new Error('transient snapshot failure'));
    transientFailure.catch(() => {});

    const { ChatProvider, gatewayState, requestSnapshotMock } = await setup();
    gatewayState.connectionState = 'connected';
    requestSnapshotMock
      .mockImplementationOnce(() => transientFailure)
      .mockResolvedValue(undefined);

    function Consumer() {
      return null;
    }

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(requestSnapshotMock).toHaveBeenCalledWith('main', 'session-switch');
    });
    expect(requestSnapshotMock).toHaveBeenCalledTimes(1);

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
      expect(requestSnapshotMock).toHaveBeenCalledTimes(2);
    });
    expect(
      requestSnapshotMock.mock.calls.filter(
        ([sessionId, reason]) => sessionId === 'main' && reason === 'session-switch',
      ),
    ).toHaveLength(2);
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

  it('does not reuse the same history msgId for repeated realtime assistant messages', async () => {
    const historyMessages: ChatMsg[] = [
      {
        msgId: 'hist-1',
        role: 'assistant',
        html: 'OK',
        rawText: 'OK',
        timestamp: new Date(1_000),
        collapsed: true,
      },
      {
        msgId: 'hist-2',
        role: 'assistant',
        html: 'OK',
        rawText: 'OK',
        timestamp: new Date(2_000),
        collapsed: false,
      },
    ];
    const { ChatProvider, useChat, gatewayState, realtimeStateRef } = await setup({
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

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(messages.map((message) => message.msgId)).toEqual(['hist-1', 'hist-2']);
    });

    realtimeStateRef.current = {
      ...realtimeStateRef.current,
      runs: {
        'run-1': {
          runId: 'run-1',
          sessionId: 'main',
          status: 'completed',
          messageIds: ['rt-1', 'rt-2'],
          lastEventAt: 3,
          finalized: true,
        },
      },
      messages: {
        'rt-1': {
          messageId: 'rt-1',
          sessionId: 'main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'OK' }],
          status: 'committed',
          revision: 1,
          createdAt: 1_000,
        },
        'rt-2': {
          messageId: 'rt-2',
          sessionId: 'main',
          runId: 'run-1',
          role: 'assistant',
          contentParts: [{ type: 'text', text: 'OK' }],
          status: 'committed',
          revision: 1,
          createdAt: 2_000,
        },
      },
    };

    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      const assistantMessages = messages.filter((message) => message.role === 'assistant');
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages.map((message) => message.msgId)).toEqual(['hist-1', 'hist-2']);
      expect(assistantMessages.map((message) => message.collapsed)).toEqual([true, false]);
      expect(new Set(assistantMessages.map((message) => message.msgId)).size).toBe(2);
    });
  });

  it('does not duplicate the final assistant message after disconnect and reconcile', async () => {
    const initialRealtimeState = {
      connection: {
        status: 'live' as const,
        lastLiveAt: 0,
        lastDisconnectReason: null,
        reconcileNeeded: false,
        reconnectAttempt: 0,
      },
      sessions: {
        main: { sessionId: 'main', status: 'running', agentId: 'main', updatedAt: 1, sourceVersion: 'v1' },
      },
      runs: {
        'run-1': {
          runId: 'run-1',
          sessionId: 'main',
          status: 'running',
          messageIds: ['run-1:assistant:stream'],
          lastEventAt: 1,
          finalized: false,
        },
      },
      messages: {
        'run-1:assistant:stream': {
          messageId: 'run-1:assistant:stream',
          sessionId: 'main',
          runId: 'run-1',
          role: 'assistant' as const,
          contentParts: [{ type: 'text' as const, text: 'hello' }],
          status: 'streaming' as const,
          revision: 1,
          createdAt: 1,
        },
      },
      agentPresence: {},
    };

    const { ChatProvider, useChat, realtimeStateRef, requestSnapshotMock } = await setup({
      currentSession: 'main',
      realtimeState: initialRealtimeState,
    });

    requestSnapshotMock.mockImplementation(async () => {
      realtimeStateRef.current = {
        ...realtimeStateRef.current,
        runs: {
          'run-1': {
            ...initialRealtimeState.runs['run-1'],
            status: 'completed',
            finalized: true,
            messageIds: ['run-1:assistant:final'],
            lastEventAt: 2,
          },
        },
        messages: {
          'run-1:assistant:final': {
            messageId: 'run-1:assistant:final',
            sessionId: 'main',
            runId: 'run-1',
            role: 'assistant',
            contentParts: [{ type: 'text', text: 'hello' }],
            status: 'committed',
            revision: 2,
            createdAt: 2,
          },
        },
      };
    });

    let assistantCount = 0;

    function Consumer() {
      const { messages } = useChat();
      useEffect(() => {
        assistantCount = messages.filter((message) => message.role === 'assistant').length;
      }, [messages]);
      return null;
    }

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(assistantCount).toBe(1);
    });

    await act(async () => {
      await requestSnapshotMock('main', 'reconnect');
    });

    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(assistantCount).toBe(1);
    });
  });

  it('keeps consumer-visible generating state true after send acknowledgement until realtime state catches up', async () => {
    const { ChatProvider, useChat } = await setup();

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;
    let visibleIsGenerating = false;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      useEffect(() => {
        visibleIsGenerating = chat.isGenerating;
      }, [chat.isGenerating]);
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

    expect(visibleIsGenerating).toBe(true);
  });

  it('does not replace loaded assistant history with partial realtime messages while reconcile is pending', async () => {
    const historyMessages: ChatMsg[] = [
      {
        msgId: 'history-user',
        role: 'user',
        html: '<p>Question</p>',
        rawText: 'Question',
        timestamp: new Date(10),
      },
      {
        msgId: 'history-assistant-1',
        role: 'assistant',
        html: '<p>Earlier answer</p>',
        rawText: 'Earlier answer',
        timestamp: new Date(20),
      },
      {
        msgId: 'history-assistant-2',
        role: 'assistant',
        html: '<p>Second answer</p>',
        rawText: 'Second answer',
        timestamp: new Date(30),
      },
    ];

    const { ChatProvider, useChat, gatewayState, realtimeStateRef } = await setup({
      currentSession: 'main',
      realtimeState: {
        connection: {
          status: 'live',
          lastLiveAt: 0,
          lastDisconnectReason: null,
          reconcileNeeded: true,
          reconnectAttempt: 0,
        },
        sessions: { main: { sessionId: 'main', status: 'running', agentId: 'main', updatedAt: 1, sourceVersion: 'v1' } },
        runs: {
          'run-live': {
            runId: 'run-live',
            sessionId: 'main',
            status: 'running',
            messageIds: ['run-live:assistant'],
            lastEventAt: 40,
            finalized: false,
          },
        },
        messages: {
          'run-live:assistant': {
            messageId: 'run-live:assistant',
            sessionId: 'main',
            runId: 'run-live',
            role: 'assistant',
            contentParts: [{ type: 'text', text: 'Fresh partial' }],
            status: 'streaming',
            revision: 1,
            createdAt: 40,
          },
        },
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

    const view = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(messages.map((message) => message.msgId)).toEqual([
        'history-user',
        'history-assistant-1',
        'history-assistant-2',
      ]);
    });

    realtimeStateRef.current = {
      ...realtimeStateRef.current,
      messages: {
        ...realtimeStateRef.current.messages,
        'run-live:assistant': {
          ...realtimeStateRef.current.messages['run-live:assistant'],
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
      expect(messages.map((message) => message.msgId)).toEqual([
        'history-user',
        'history-assistant-1',
        'history-assistant-2',
      ]);
    });
  });

  it('clears a previously projected realtime transcript when the realtime slice becomes empty', async () => {
    const { ChatProvider, useChat, gatewayState, realtimeStateRef } = await setup({
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
        runs: {
          'run-live': {
            runId: 'run-live',
            sessionId: 'main',
            status: 'completed',
            messageIds: ['run-live:assistant'],
            lastEventAt: 20,
            finalized: true,
          },
        },
        messages: {
          'run-live:assistant': {
            messageId: 'run-live:assistant',
            sessionId: 'main',
            runId: 'run-live',
            role: 'assistant',
            contentParts: [{ type: 'text', text: 'Projected answer' }],
            status: 'committed',
            revision: 1,
            createdAt: 20,
          },
        },
        agentPresence: {},
      },
      loadChatHistoryImpl: async () => [],
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
      expect(messages.map((message) => message.msgId)).toEqual(['run-live:assistant']);
    });

    realtimeStateRef.current = {
      ...realtimeStateRef.current,
      runs: {},
      messages: {},
    };

    view.rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(messages).toEqual([]);
    });
  });
});
