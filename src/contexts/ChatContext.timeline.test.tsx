import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { GatewayEvent } from '@/types';

class MockChatEventSource {
  static instances: MockChatEventSource[] = [];
  listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  closed = false;

  constructor(public url: string) {
    MockChatEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, record: unknown) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ data: JSON.stringify(record) } as MessageEvent<string>);
    }
  }

  close() {
    this.closed = true;
  }
}

describe('ChatContext timeline snapshot hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockChatEventSource.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup() {
    const subscribers: Array<(event: GatewayEvent) => void> = [];
    const subscribeMock = vi.fn((handler: (event: GatewayEvent) => void) => {
      subscribers.push(handler);
      return () => {
        const index = subscribers.indexOf(handler);
        if (index >= 0) subscribers.splice(index, 1);
      };
    });
    const rpcMock = vi.fn();

    vi.doMock('./GatewayContext', () => ({
      useGateway: () => ({
        connectionState: 'connected',
        rpc: rpcMock,
        subscribe: subscribeMock,
      }),
    }));

    vi.doMock('./SessionContext', () => ({
      useSessionContext: () => ({
        currentSession: 'agent:test:main',
        sessions: [],
      }),
    }));

    vi.doMock('./SettingsContext', () => ({
      useSettings: () => ({
        soundEnabled: false,
        speak: vi.fn(),
      }),
    }));

    const mod = await import('./ChatContext');
    return { ...mod, rpcMock, subscribeMock, subscribers };
  }

  it('hydrates persisted history plus ledgered tool bubbles after page load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      sessionKey: 'agent:test:main',
      history: {
        messages: [
          { role: 'assistant', content: 'older answer', timestamp: 1 },
        ],
      },
      events: [
        {
          cursor: 7,
          sessionKey: 'agent:test:main',
          type: 'agent',
          payload: {
            sessionKey: 'agent:test:main',
            runId: 'run-tool',
            seq: 1,
            stream: 'tool',
            data: {
              phase: 'start',
              toolCallId: 'tool-1',
              name: 'exec',
              args: { cmd: 'pwd' },
            },
          },
          ts: 10,
        },
      ],
      cursor: 7,
    }), { status: 200 })));

    const { ChatProvider, useChat } = await setup();

    function Consumer() {
      const { messages } = useChat();
      return (
        <div>
          {messages.map((message) => (
            <pre key={message.msgId || message.rawText}>{message.rawText}</pre>
          ))}
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('older answer')).toBeInTheDocument();
      expect(screen.getByText(/exec/)).toHaveTextContent('pwd');
    });
  });

  it('renders current-session live tool events as durable timeline bubbles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      sessionKey: 'agent:test:main',
      history: { messages: [] },
      events: [],
      cursor: 0,
    }), { status: 200 })));

    const { ChatProvider, useChat, subscribers } = await setup();

    function Consumer() {
      const { messages } = useChat();
      return (
        <div>
          {messages.map((message) => (
            <pre key={message.msgId || message.rawText}>{message.rawText}</pre>
          ))}
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribers).toHaveLength(1));

    act(() => {
      subscribers[0]({
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: 'agent:test:main',
          runId: 'run-tool',
          seq: 1,
          stream: 'tool',
          data: {
            phase: 'start',
            toolCallId: 'tool-1',
            name: 'exec',
            args: { cmd: 'pwd' },
          },
        },
      });
    });

    await waitFor(() => expect(screen.getByText(/exec/)).toHaveTextContent('pwd'));
  });

  it('replaces a streaming timeline assistant item with the final assistant item', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      sessionKey: 'agent:test:main',
      history: { messages: [] },
      events: [],
      cursor: 0,
    }), { status: 200 })));

    const { ChatProvider, useChat, subscribers } = await setup();

    function Consumer() {
      const { messages } = useChat();
      return (
        <div>
          {messages.map((message) => (
            <pre key={message.msgId || message.rawText}>{message.rawText}</pre>
          ))}
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(subscribers).toHaveLength(1));

    act(() => {
      subscribers[0]({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:test:main',
          runId: 'run-stream',
          seq: 1,
          state: 'delta',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
            timestamp: 1,
          },
        },
      });
    });

    await waitFor(() => expect(screen.getByText('partial')).toBeInTheDocument());

    act(() => {
      subscribers[0]({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:test:main',
          runId: 'run-stream',
          seq: 2,
          state: 'final',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'final answer' }],
            timestamp: 2,
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('final answer')).toBeInTheDocument();
      expect(screen.queryByText('partial')).toBeNull();
    });
  });

  it('sends chat messages through the server adapter so the server owns the run stream', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/chat/sessions/')) {
        return new Response(JSON.stringify({
          sessionKey: 'agent:test:main',
          history: { messages: [] },
          events: [],
          cursor: 0,
        }), { status: 200 });
      }
      if (url === '/api/chat/send') {
        return new Response(JSON.stringify({ runId: 'run-server', status: 'started' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { ChatProvider, useChat, rpcMock } = await setup();

    function Consumer() {
      const { handleSend } = useChat();
      return <button type="button" onClick={() => void handleSend('hello')}>send</button>;
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/agent%3Atest%3Amain/snapshot?cursor=0&limit=500'));

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/send', expect.objectContaining({
      method: 'POST',
    })));
    const sendCall = fetchMock.mock.calls.find(([input]) => input === '/api/chat/send');
    const sendBody = JSON.parse(String(sendCall?.[1]?.body || '{}')) as Record<string, unknown>;
    expect(sendBody).toMatchObject({
      sessionKey: 'agent:test:main',
      message: 'hello',
    });
    expect(typeof sendBody.idempotencyKey).toBe('string');
    expect(rpcMock).not.toHaveBeenCalledWith('chat.send', expect.anything());
  });

  it('keeps live operator, tool, and final assistant bubbles in timeline order before refresh', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/chat/sessions/')) {
        return new Response(JSON.stringify({
          sessionKey: 'agent:test:main',
          history: {
            messages: [
              { role: 'assistant', content: 'older answer', timestamp: 1 },
            ],
          },
          events: [],
          cursor: 0,
        }), { status: 200 });
      }
      if (url === '/api/chat/send') {
        return new Response(JSON.stringify({ runId: 'run-live', status: 'started' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { ChatProvider, useChat, subscribers } = await setup();

    function Consumer() {
      const { messages, handleSend } = useChat();
      return (
        <div>
          <button type="button" onClick={() => void handleSend('live prompt')}>send</button>
          {messages.map((message) => (
            <pre data-testid="message" data-role={message.role} key={message.msgId || message.rawText}>
              {message.rawText}
            </pre>
          ))}
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(screen.getByText('older answer')).toBeInTheDocument());
    await waitFor(() => expect(subscribers).toHaveLength(1));

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/send', expect.objectContaining({
      method: 'POST',
    })));

    const toolTimestamp = Date.now() + 1;
    act(() => {
      subscribers[0]({
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: 'agent:test:main',
          runId: 'run-live',
          seq: 1,
          ts: toolTimestamp,
          stream: 'item',
          data: {
            phase: 'start',
            kind: 'tool',
            toolCallId: 'tool-live',
            name: 'exec',
            title: 'exec pwd',
            args: { cmd: 'pwd' },
          },
        },
      });
    });

    await waitFor(() => {
      const texts = screen.getAllByTestId('message').map((node) => node.textContent?.trim());
      expect(texts).toHaveLength(3);
      expect(texts[0]).toBe('older answer');
      expect(texts[1]).toBe('live prompt');
      expect(texts[2]).toContain('exec');
      expect(texts[2]).toContain('pwd');
    });

    act(() => {
      subscribers[0]({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:test:main',
          runId: 'run-live',
          seq: 2,
          state: 'final',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'live final' }],
            timestamp: toolTimestamp + 1,
          },
        },
      });
    });

    await waitFor(() => {
      const messages = screen.getAllByTestId('message');
      const texts = messages.map((node) => node.textContent?.trim());
      expect(texts).toHaveLength(4);
      expect(texts[0]).toBe('older answer');
      expect(texts[1]).toBe('live prompt');
      expect(texts[2]).toContain('exec');
      expect(texts[3]).toBe('live final');
      expect(messages.filter((node) => node.textContent?.includes('live final'))).toHaveLength(1);
    });
  });

  it('applies server-sent ledger events after snapshot hydration', async () => {
    vi.stubGlobal('EventSource', MockChatEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      sessionKey: 'agent:test:main',
      history: { messages: [] },
      events: [],
      cursor: 7,
    }), { status: 200 })));

    const { ChatProvider, useChat } = await setup();

    function Consumer() {
      const { messages } = useChat();
      return (
        <div>
          {messages.map((message) => (
            <pre key={message.msgId || message.rawText}>{message.rawText}</pre>
          ))}
        </div>
      );
    }

    render(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(MockChatEventSource.instances).toHaveLength(1));
    expect(MockChatEventSource.instances[0].url).toBe('/api/chat/events?sessionKey=agent%3Atest%3Amain&cursor=7');

    act(() => {
      MockChatEventSource.instances[0].emit('chat.timeline', {
        cursor: 8,
        sessionKey: 'agent:test:main',
        type: 'agent',
        payload: {
          sessionKey: 'agent:test:main',
          runId: 'run-tool',
          seq: 1,
          stream: 'tool',
          data: {
            phase: 'start',
            toolCallId: 'tool-1',
            name: 'exec',
            args: { cmd: 'pwd' },
          },
        },
        ts: 10,
      });
    });

    await waitFor(() => expect(screen.getByText(/exec/)).toHaveTextContent('pwd'));
  });
});
