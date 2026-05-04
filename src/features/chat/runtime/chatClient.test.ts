import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abortChat,
  fetchChatSnapshot,
  ledgerRecordToGatewayEvent,
  refreshChatSnapshot,
  sendChat,
  subscribeChatEvents,
} from './chatClient';

describe('chatClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches encoded chat snapshots from the server adapter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionKey: 'agent:test:main',
      history: { messages: [{ role: 'assistant', content: 'hello' }] },
      events: [],
      cursor: 3,
      fromCursor: 2,
      hasGap: true,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await fetchChatSnapshot('agent:test:main', { cursor: 1, limit: 50 });

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/agent%3Atest%3Amain/snapshot?cursor=1&limit=50');
    expect(snapshot.cursor).toBe(3);
    expect(snapshot.fromCursor).toBe(2);
    expect(snapshot.hasGap).toBe(true);
    expect(snapshot.history.messages[0]).toMatchObject({ content: 'hello' });
  });

  it('converts ledger records back into gateway events', () => {
    expect(ledgerRecordToGatewayEvent({
      cursor: 7,
      sessionKey: 'agent:test:main',
      type: 'agent',
      payload: { sessionKey: 'agent:test:main', runId: 'run-1' },
      ts: 10,
    })).toEqual({
      type: 'event',
      event: 'agent',
      seq: 7,
      ts: 10,
      payload: { sessionKey: 'agent:test:main', runId: 'run-1' },
    });
  });

  it('subscribes to chat timeline server-sent events with the latest cursor', () => {
    class MockEventSource {
      static instances: MockEventSource[] = [];
      listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
      closed = false;

      constructor(public url: string) {
        MockEventSource.instances.push(this);
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

    vi.stubGlobal('EventSource', MockEventSource);
    const received: unknown[] = [];

    const unsubscribe = subscribeChatEvents('agent:test:main', 7, (record) => {
      received.push(record);
    });

    expect(MockEventSource.instances[0].url).toBe('/api/chat/events?sessionKey=agent%3Atest%3Amain&cursor=7');

    MockEventSource.instances[0].emit('chat.timeline', {
      cursor: 8,
      sessionKey: 'agent:test:main',
      type: 'chat',
      payload: { sessionKey: 'agent:test:main' },
      ts: 10,
    });

    expect(received).toEqual([
      expect.objectContaining({ cursor: 8, type: 'chat' }),
    ]);

    unsubscribe();
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it('posts chat sends through the server adapter', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      runId: 'run-1',
      status: 'started',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendChat({
      sessionKey: 'agent:test:main',
      message: 'hello',
      idempotencyKey: 'ik-1',
    })).resolves.toEqual({ runId: 'run-1', status: 'started' });

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/send', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sessionKey: 'agent:test:main',
        message: 'hello',
        idempotencyKey: 'ik-1',
      }),
    }));
  });

  it('posts abort and refresh requests through the server adapter', async () => {
    const fetchMock = vi.fn(async (input: string) => new Response(JSON.stringify(
      input.endsWith('/abort')
        ? { ok: true }
        : { sessionKey: 'agent:test:main', history: { messages: [] }, events: [], cursor: 0 },
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(abortChat('agent:test:main')).resolves.toEqual({ ok: true });
    await expect(refreshChatSnapshot('agent:test:main', { cursor: 3, limit: 10 })).resolves.toMatchObject({
      sessionKey: 'agent:test:main',
      cursor: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/abort', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/refresh', expect.objectContaining({ method: 'POST' }));
  });
});
