/** Regression tests for ChatContext realtime subscriptions. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, screen } from '@testing-library/react';
import { useEffect } from 'react';
import type { ImageAttachment } from '@/features/chat/types';
import type { GatewayEvent, Session } from '@/types';

describe('ChatContext subscription stability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(options: {
    connectionState?: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
    currentSession?: string;
    sessions?: Session[];
  } = {}) {
    const subscribedHandlers: Array<(msg: GatewayEvent) => void> = [];
    let currentSession = options.currentSession || 'main';
    let sessions = options.sessions || [];
    const setCurrentSession = (nextSession: string) => {
      currentSession = nextSession;
    };
    const setSessions = (nextSessions: Session[]) => {
      sessions = nextSessions;
    };
    const subscribeMock = vi.fn((handler: (msg: GatewayEvent) => void) => {
      subscribedHandlers.push(handler);
      return () => {};
    });
    const rpcMock = vi.fn(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1', status: 'started' };
      if (method === 'chat.history') return { messages: [] };
      return {};
    });

    vi.doMock('./GatewayContext', () => ({
      useGateway: () => ({
        connectionState: options.connectionState || 'disconnected',
        rpc: rpcMock,
        subscribe: subscribeMock,
      }),
    }));

    vi.doMock('./SessionContext', () => ({
      useSessionContext: () => ({
        currentSession,
        sessions,
      }),
    }));

    vi.doMock('./SettingsContext', () => ({
      useSettings: () => ({
        soundEnabled: false,
        speak: vi.fn(),
      }),
    }));

    const mod = await import('./ChatContext');
    return { ...mod, rpcMock, subscribeMock, subscribedHandlers, setCurrentSession, setSessions };
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

  it('subscribes to current session message broadcasts while connected and cleans up', async () => {
    const { ChatProvider, rpcMock } = await setup({ connectionState: 'connected' });

    const { unmount } = render(
      <ChatProvider>
        <div />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('sessions.messages.subscribe', { key: 'main' });
    });

    unmount();

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('sessions.messages.unsubscribe', { key: 'main' });
    });
  });

  it('hydrates active generation state from a refreshed session snapshot', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="processing-stage">{chat.processingStage || 'NONE'}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
    expect(screen.getByTestId('processing-stage').textContent).toBe('thinking');

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('chat.history', { sessionKey: 'main', limit: 120 });
    });
  });

  it('hydrates active generation state from a busy refreshed session snapshot', async () => {
    const { ChatProvider, useChat } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', status: 'busy' }],
    });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
  });

  it('does not hydrate the selected chat from child-only active run snapshots', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: false, hasActiveSubagentRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('sessions.messages.subscribe', { key: 'main' });
    });
    expect(screen.getByTestId('is-generating').textContent).toBe('false');
    expect(rpcMock).not.toHaveBeenCalledWith('chat.history', { sessionKey: 'main', limit: 120 });
  });

  it('hydrates selected chat when child activity is accompanied by own-run legacy signals', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveSubagentRun: true, busy: true }],
    });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('chat.history', { sessionKey: 'main', limit: 120 });
    });
  });

  it('hydrates selected chat when child activity is accompanied by own active status', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveSubagentRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('chat.history', { sessionKey: 'main', limit: 120 });
    });
  });

  it('does not hydrate from stale running text when explicit own run flag is inactive', async () => {
    const { ChatProvider, useChat, rpcMock } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: false, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('sessions.messages.subscribe', { key: 'main' });
    });
    expect(screen.getByTestId('is-generating').textContent).toBe('false');
    expect(rpcMock).not.toHaveBeenCalledWith('chat.history', { sessionKey: 'main', limit: 120 });
  });

  it('clears hydrated generation state from a terminal refreshed session snapshot', async () => {
    const { ChatProvider, useChat, setSessions, rpcMock } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="processing-stage">{chat.processingStage || 'NONE'}</div>
        </div>
      );
    }

    const { rerender } = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });

    setSessions([{ sessionKey: 'main', hasActiveRun: false, status: 'done' }]);
    rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('false');
    });
    expect(screen.getByTestId('processing-stage').textContent).toBe('NONE');
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('chat.history', { sessionKey: 'main', limit: 120 });
    });
  });

  it('clears hydrated generation state from explicit inactive flags with stale running status', async () => {
    const { ChatProvider, useChat, setSessions } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="processing-stage">{chat.processingStage || 'NONE'}</div>
        </div>
      );
    }

    const { rerender } = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });

    setSessions([{ sessionKey: 'main', busy: false, processing: false, status: 'running' }]);
    rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('false');
    });
    expect(screen.getByTestId('processing-stage').textContent).toBe('NONE');
  });

  it('clears hydrated generation state from a subscribed explicit inactive snapshot', async () => {
    const { ChatProvider, useChat, subscribedHandlers } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="processing-stage">{chat.processingStage || 'NONE'}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
    await waitFor(() => expect(subscribedHandlers.length).toBe(1));

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', busy: false, status: 'running' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('false');
    });
    expect(screen.getByTestId('processing-stage').textContent).toBe('NONE');
  });

  it('keeps active chat generating when child terminal state is mixed with own active status', async () => {
    const { ChatProvider, useChat, subscribedHandlers } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
    await waitFor(() => expect(subscribedHandlers.length).toBe(1));

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', status: 'running', subagentRunState: 'done' },
      });
    });

    expect(screen.getByTestId('is-generating').textContent).toBe('true');
  });

  it('hydrates phase-start snapshots even when stale inactive flags are present', async () => {
    const { ChatProvider, useChat, subscribedHandlers } = await setup({ connectionState: 'connected' });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribedHandlers.length).toBe(1));

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', phase: 'start', hasActiveRun: false, busy: false, status: 'done' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
  });

  it('hydrates a newly selected active session after resetting the previous generating session', async () => {
    const { ChatProvider, useChat, setCurrentSession, rpcMock } = await setup({
      connectionState: 'connected',
      currentSession: 'main',
      sessions: [
        { sessionKey: 'main', hasActiveRun: true, status: 'running' },
        { sessionKey: 'agent:reviewer:main', hasActiveRun: true, status: 'running' },
      ],
    });

    function Consumer() {
      const chat = useChat();
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    const { rerender } = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });

    setCurrentSession('agent:reviewer:main');
    rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
      expect(rpcMock).toHaveBeenCalledWith('chat.history', { sessionKey: 'agent:reviewer:main', limit: 120 });
    });
  });

  it('keeps live active runs generating when terminal session snapshots race before chat final', async () => {
    const { ChatProvider, useChat, subscribedHandlers } = await setup({ connectionState: 'connected' });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribedHandlers.length).toBe(1));
    await act(async () => {
      await send!('hello');
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', hasActiveRun: false, status: 'done' },
      });
    });

    expect(screen.getByTestId('is-generating').textContent).toBe('true');

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'chat',
        payload: { sessionKey: 'main', runId: 'run-1', state: 'final', message: 'done' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('false');
    });
  });

  it('clears active run state from terminal snapshots when the chat final frame is missed', async () => {
    const { ChatProvider, useChat, subscribedHandlers } = await setup({ connectionState: 'connected' });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return <div data-testid="is-generating">{String(chat.isGenerating)}</div>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribedHandlers.length).toBe(1));
    await act(async () => {
      await send!('hello');
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });

    vi.useFakeTimers();

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', hasActiveRun: false, status: 'done' },
      });
    });

    expect(screen.getByTestId('is-generating').textContent).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.getByTestId('is-generating').textContent).toBe('false');
  });

  it('keeps slow terminal recovery results valid after a missed chat final frame', async () => {
    const { ChatProvider, useChat, subscribedHandlers, rpcMock } = await setup({ connectionState: 'connected' });

    let send: ((text: string, images?: ImageAttachment[]) => Promise<void>) | null = null;

    function Consumer() {
      const chat = useChat();
      useEffect(() => {
        send = chat.handleSend;
      }, [chat]);
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="messages">{chat.messages.map((m) => m.rawText || m.html).join('\n')}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribedHandlers.length).toBe(1));
    await act(async () => {
      await send!('hello');
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });

    rpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-1', status: 'started' };
      if (method === 'chat.history') {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { messages: [{ role: 'assistant', content: 'recovered final' }] };
      }
      return {};
    });

    vi.useFakeTimers();

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', hasActiveRun: false, status: 'done' },
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.getByTestId('is-generating').textContent).toBe('false');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByTestId('messages').textContent).toContain('recovered final');
  });

  it('clears hydrated generation state from a terminal agentState refreshed session snapshot', async () => {
    const { ChatProvider, useChat, setSessions } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', agentState: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="processing-stage">{chat.processingStage || 'NONE'}</div>
        </div>
      );
    }

    const { rerender } = render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });

    setSessions([{ sessionKey: 'main', agentState: 'done' }]);
    rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('false');
    });
    expect(screen.getByTestId('processing-stage').textContent).toBe('NONE');
  });

  it('hydrates active generation state from a subscribed lifecycle event after refresh', async () => {
    const { ChatProvider, useChat, subscribedHandlers } = await setup({ connectionState: 'connected' });

    function Consumer() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="processing-stage">{chat.processingStage || 'NONE'}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribedHandlers.length).toBe(1));

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', phase: 'start' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
    expect(screen.getByTestId('processing-stage').textContent).toBe('thinking');
  });

  it('clears hydrated generation state from a subscribed terminal lifecycle event', async () => {
    const { ChatProvider, useChat, subscribedHandlers } = await setup({
      connectionState: 'connected',
      sessions: [{ sessionKey: 'main', hasActiveRun: true, status: 'running' }],
    });

    function Consumer() {
      const chat = useChat();
      return (
        <div>
          <div data-testid="is-generating">{String(chat.isGenerating)}</div>
          <div data-testid="processing-stage">{chat.processingStage || 'NONE'}</div>
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('true');
    });
    await waitFor(() => expect(subscribedHandlers.length).toBe(1));

    act(() => {
      subscribedHandlers[0]({
        type: 'event',
        event: 'sessions.changed',
        payload: { sessionKey: 'main', phase: 'end', status: 'done' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('is-generating').textContent).toBe('false');
    });
    expect(screen.getByTestId('processing-stage').textContent).toBe('NONE');
  });
});
