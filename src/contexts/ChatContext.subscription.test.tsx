/** Regression test: ChatContext should not resubscribe on local state updates. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { ImageAttachment } from '@/features/chat/types';

describe('ChatContext subscription stability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function setup() {
    const subscribeMock = vi.fn(() => () => {});
    const requestSnapshotMock = vi.fn(async () => {});
    const loadChatHistoryMock = vi.fn(async () => []);
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1', status: 'started' };
      return {};
    });
    const gatewayState = {
      connectionState: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'reconnecting',
      rpc: rpcMock,
      subscribe: subscribeMock,
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
      useSessionContext: () => ({
        currentSession: 'main',
        sessions: [],
      }),
    }));

    vi.doMock('./SettingsContext', () => ({
      useSettings: () => ({
        soundEnabled: false,
        speak: vi.fn(),
      }),
    }));

    vi.doMock('./RealtimeContext', () => ({
      useRealtime: () => ({
        requestSnapshot: requestSnapshotMock,
      }),
    }));

    const mod = await import('./ChatContext');
    return { ...mod, gatewayState, subscribeMock, loadChatHistoryMock, requestSnapshotMock };
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
});
