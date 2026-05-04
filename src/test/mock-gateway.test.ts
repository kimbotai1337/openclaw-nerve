import { describe, expect, it, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { GatewayMessage, GatewayRequest } from '@/types';
import { createMockGateway, type MockGateway } from './mock-gateway';

const openGateways: MockGateway[] = [];

async function createGateway(): Promise<MockGateway> {
  const gateway = await createMockGateway({
    sessions: [{ sessionKey: 'agent:test:main', state: 'idle' }],
  });
  openGateways.push(gateway);
  return gateway;
}

function nextJson(ws: WebSocket): Promise<GatewayMessage> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as GatewayMessage));
  });
}

async function connectClient(gateway: MockGateway): Promise<WebSocket> {
  const ws = new WebSocket(gateway.url);
  const challengePromise = nextJson(ws);
  await new Promise<void>((resolve) => ws.once('open', () => resolve()));

  const challenge = await challengePromise;
  expect(challenge).toMatchObject({
    type: 'event',
    event: 'connect.challenge',
  });

  const req: GatewayRequest = {
    type: 'req',
    id: 'connect-1',
    method: 'connect',
    params: {
      protocol: 3,
      client: { id: 'openclaw-control-ui' },
      role: 'operator',
      caps: ['tool-events'],
    },
  };
  const connectResponse = nextJson(ws);
  ws.send(JSON.stringify(req));
  await expect(connectResponse).resolves.toMatchObject({
    type: 'res',
    id: 'connect-1',
    ok: true,
  });

  return ws;
}

function sendRpc(ws: WebSocket, id: string, method: string, params: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({
    type: 'req',
    id,
    method,
    params,
  }));
}

afterEach(async () => {
  await Promise.all(openGateways.splice(0).map((gateway) => gateway.close()));
});

describe('MockGateway modern OpenClaw protocol support', () => {
  it('supports chat.send, chat.history, sessions.list, and chat.abort RPCs', async () => {
    const gateway = await createGateway();
    gateway.setHistory('agent:test:main', [
      { role: 'assistant', content: 'persisted answer', timestamp: 10 },
    ]);

    const ws = await connectClient(gateway);

    const sendResponse = nextJson(ws);
    sendRpc(ws, 'send-1', 'chat.send', {
      sessionKey: 'agent:test:main',
      message: 'hello',
      idempotencyKey: 'ik-1',
    });
    await expect(sendResponse).resolves.toMatchObject({
      type: 'res',
      id: 'send-1',
      ok: true,
      payload: {
        runId: expect.stringMatching(/^mock-run-/),
        status: 'started',
      },
    });

    const historyResponse = nextJson(ws);
    sendRpc(ws, 'history-1', 'chat.history', {
      sessionKey: 'agent:test:main',
      limit: 10,
    });
    const historyMessage = await historyResponse;
    expect(historyMessage).toMatchObject({
      type: 'res',
      id: 'history-1',
      ok: true,
    });
    expect((historyMessage.payload as { messages: unknown[] }).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'persisted answer' }),
        expect.objectContaining({ role: 'user', content: 'hello' }),
      ]),
    );

    const sessionsResponse = nextJson(ws);
    sendRpc(ws, 'sessions-1', 'sessions.list');
    await expect(sessionsResponse).resolves.toMatchObject({
      type: 'res',
      id: 'sessions-1',
      ok: true,
      payload: {
        sessions: [
          expect.objectContaining({ sessionKey: 'agent:test:main' }),
        ],
      },
    });

    const abortResponse = nextJson(ws);
    sendRpc(ws, 'abort-1', 'chat.abort', { sessionKey: 'agent:test:main' });
    await expect(abortResponse).resolves.toMatchObject({
      type: 'res',
      id: 'abort-1',
      ok: true,
    });
  });

  it('broadcasts modern chat and agent tool events', async () => {
    const gateway = await createGateway();
    const ws = await connectClient(gateway);

    const deltaEvent = nextJson(ws);
    gateway.sendChatDelta({
      sessionKey: 'agent:test:main',
      runId: 'run-1',
      seq: 1,
      text: 'Streaming',
    });
    await expect(deltaEvent).resolves.toMatchObject({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:test:main',
        runId: 'run-1',
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Streaming' }],
        },
      },
    });

    const toolEvent = nextJson(ws);
    gateway.sendAgentToolStart({
      sessionKey: 'agent:test:main',
      runId: 'run-1',
      seq: 2,
      toolCallId: 'tool-1',
      name: 'exec',
      args: { cmd: 'pwd' },
    });
    await expect(toolEvent).resolves.toMatchObject({
      type: 'event',
      event: 'agent',
      payload: {
        stream: 'tool',
        data: {
          phase: 'start',
          toolCallId: 'tool-1',
          name: 'exec',
        },
      },
    });

    const finalEvent = nextJson(ws);
    gateway.sendChatFinal({
      sessionKey: 'agent:test:main',
      runId: 'run-1',
      seq: 3,
      text: 'Done',
    });
    await expect(finalEvent).resolves.toMatchObject({
      type: 'event',
      event: 'chat',
      payload: {
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
        },
      },
    });
  });
});
