import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useChatTimeline } from './useChatTimeline';

describe('useChatTimeline', () => {
  it('hydrates history and ingests realtime events', () => {
    const { result } = renderHook(() => useChatTimeline('agent:test:main'));

    act(() => {
      result.current.hydrateHistory([
        { role: 'assistant', content: 'older answer', timestamp: 1 },
      ]);
    });

    expect(result.current.messages.map((message) => message.rawText)).toEqual(['older answer']);

    act(() => {
      result.current.ingestGatewayEvent({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: 'agent:test:main',
          runId: 'run-1',
          seq: 1,
          state: 'delta',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'streaming' }],
            timestamp: 2,
          },
        },
      });
    });

    expect(result.current.messages.map((message) => message.rawText)).toEqual([
      'older answer',
      'streaming',
    ]);
  });
});
