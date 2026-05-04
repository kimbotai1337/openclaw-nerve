import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@/types';
import { ChatTimelineStore } from './chatTimelineStore';

describe('ChatTimelineStore', () => {
  it('tracks inactive session events without polluting the selected session', () => {
    const store = new ChatTimelineStore();

    store.ingestGatewayEvent({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:one:main',
        runId: 'run-1',
        seq: 1,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one' }], timestamp: 1 },
      },
    } satisfies GatewayEvent);
    store.ingestGatewayEvent({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:two:main',
        runId: 'run-2',
        seq: 1,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], timestamp: 1 },
      },
    } satisfies GatewayEvent);

    expect(store.messages('agent:one:main').map((msg) => msg.rawText)).toEqual(['one']);
    expect(store.messages('agent:two:main').map((msg) => msg.rawText)).toEqual(['two']);
  });

  it('hydrates history and then reconciles final realtime frames into the same session', () => {
    const store = new ChatTimelineStore();
    store.hydrateHistory('agent:test:main', [
      { role: 'assistant', content: 'older answer', timestamp: 1 },
    ]);

    store.ingestGatewayEvent({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:test:main',
        runId: 'run-1',
        seq: 1,
        state: 'delta',
        message: { role: 'assistant', content: [{ type: 'text', text: 'streaming' }], timestamp: 2 },
      },
    });
    store.ingestGatewayEvent({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:test:main',
        runId: 'run-1',
        seq: 2,
        state: 'final',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], timestamp: 3 },
      },
    });

    expect(store.messages('agent:test:main').map((msg) => msg.rawText)).toEqual([
      'older answer',
      'final answer',
    ]);
  });

  it('persists and restores the selected session key', () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    ChatTimelineStore.persistSelectedSession('agent:test:main', adapter);
    expect(ChatTimelineStore.restoreSelectedSession(adapter)).toBe('agent:test:main');

    ChatTimelineStore.persistSelectedSession('', adapter);
    expect(ChatTimelineStore.restoreSelectedSession(adapter)).toBeNull();
  });
});
