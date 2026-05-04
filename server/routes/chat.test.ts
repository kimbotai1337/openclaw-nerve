import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import chatRoutes from './chat.js';
import { chatLedger } from '../lib/chat-ledger.js';

const gatewayRpcCall = vi.hoisted(() => vi.fn());

vi.mock('../lib/gateway-rpc.js', () => ({
  gatewayRpcCall,
}));

function buildApp() {
  const app = new Hono();
  app.route('/', chatRoutes);
  return app;
}

describe('chat routes', () => {
  afterEach(() => {
    gatewayRpcCall.mockReset();
    chatLedger.clear();
  });

  it('returns a history snapshot plus replayed ledger events', async () => {
    gatewayRpcCall.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'persisted answer', timestamp: 1 }],
    });
    chatLedger.append('agent:test:main', 'tool_started', { toolCallId: 'tool-1' }, 10);

    const app = buildApp();
    const res = await app.request('/api/chat/sessions/agent%3Atest%3Amain/snapshot?cursor=0&limit=50');

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('chat.history', {
      sessionKey: 'agent:test:main',
      limit: 50,
    });
    await expect(res.json()).resolves.toMatchObject({
      sessionKey: 'agent:test:main',
      history: {
        messages: [{ role: 'assistant', content: 'persisted answer', timestamp: 1 }],
      },
      events: [
        {
          cursor: 1,
          type: 'tool_started',
          payload: { toolCallId: 'tool-1' },
        },
      ],
      cursor: 1,
    });
  });

  it('returns a bad gateway response when chat.history fails', async () => {
    gatewayRpcCall.mockRejectedValue(new Error('gateway unavailable'));

    const app = buildApp();
    const res = await app.request('/api/chat/sessions/agent%3Atest%3Amain/snapshot');

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: 'gateway unavailable',
    });
  });

  it('proxies chat.send through the server adapter', async () => {
    gatewayRpcCall.mockResolvedValue({ runId: 'run-1', status: 'started' });

    const app = buildApp();
    const res = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKey: 'agent:test:main',
        message: 'hello',
        idempotencyKey: 'ik-1',
        attachments: [{ id: 'img-1' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('chat.send', {
      sessionKey: 'agent:test:main',
      message: 'hello',
      deliver: false,
      idempotencyKey: 'ik-1',
      attachments: [{ id: 'img-1' }],
    });
    await expect(res.json()).resolves.toEqual({ runId: 'run-1', status: 'started' });
  });

  it('rejects chat.send without a session key or message', async () => {
    const app = buildApp();
    const res = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'agent:test:main', message: '' }),
    });

    expect(res.status).toBe(400);
    expect(gatewayRpcCall).not.toHaveBeenCalled();
  });

  it('proxies chat.abort through the server adapter', async () => {
    gatewayRpcCall.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.request('/api/chat/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'agent:test:main' }),
    });

    expect(res.status).toBe(200);
    expect(gatewayRpcCall).toHaveBeenCalledWith('chat.abort', {
      sessionKey: 'agent:test:main',
    });
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('refreshes snapshot state through POST /api/chat/refresh', async () => {
    gatewayRpcCall.mockResolvedValue({
      messages: [{ role: 'assistant', content: 'fresh answer', timestamp: 2 }],
    });
    chatLedger.append('agent:test:main', 'chat', { sessionKey: 'agent:test:main', state: 'final' }, 20);

    const app = buildApp();
    const res = await app.request('/api/chat/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'agent:test:main', cursor: 0, limit: 25 }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sessionKey: 'agent:test:main',
      history: {
        messages: [{ role: 'assistant', content: 'fresh answer', timestamp: 2 }],
      },
      events: [
        { cursor: 1, type: 'chat' },
      ],
      cursor: 1,
    });
  });
});
