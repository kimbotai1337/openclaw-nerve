import { describe, expect, it, beforeEach } from 'vitest';
import { chatLedger } from './chat-ledger.js';
import { recordOpenClawGatewayFrame } from './openclaw-chat-connection.js';

describe('recordOpenClawGatewayFrame', () => {
  beforeEach(() => {
    chatLedger.clear();
  });

  it('records OpenClaw chat and agent events by session key', () => {
    recordOpenClawGatewayFrame(JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:test:main',
        state: 'delta',
      },
    }));
    recordOpenClawGatewayFrame(JSON.stringify({
      type: 'event',
      event: 'agent',
      payload: {
        sessionKey: 'agent:test:main',
        stream: 'tool',
      },
    }));

    expect(chatLedger.replay('agent:test:main').events.map((event) => event.type)).toEqual([
      'chat',
      'agent',
    ]);
  });

  it('ignores malformed, unrelated, or sessionless frames', () => {
    recordOpenClawGatewayFrame('not-json');
    recordOpenClawGatewayFrame(JSON.stringify({ type: 'event', event: 'presence', payload: {} }));
    recordOpenClawGatewayFrame(JSON.stringify({ type: 'event', event: 'chat', payload: {} }));

    expect(chatLedger.replay('agent:test:main').events).toEqual([]);
  });
});
