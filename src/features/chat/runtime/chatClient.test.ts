import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchChatSnapshot, ledgerRecordToGatewayEvent } from './chatClient';

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
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await fetchChatSnapshot('agent:test:main', { cursor: 1, limit: 50 });

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/sessions/agent%3Atest%3Amain/snapshot?cursor=1&limit=50');
    expect(snapshot.cursor).toBe(3);
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
      payload: { sessionKey: 'agent:test:main', runId: 'run-1' },
    });
  });
});
