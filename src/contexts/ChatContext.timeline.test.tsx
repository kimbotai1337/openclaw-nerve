import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { GatewayEvent } from '@/types';

describe('ChatContext timeline snapshot hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
});
