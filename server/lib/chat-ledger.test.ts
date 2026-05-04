import { describe, expect, it } from 'vitest';
import { ChatLedger } from './chat-ledger.js';

describe('ChatLedger', () => {
  it('appends cursor-addressable events by session', () => {
    const ledger = new ChatLedger({ maxEventsPerSession: 10 });
    const first = ledger.append('agent:test:main', 'tool_started', { toolCallId: 'tool-1' }, 100);
    ledger.append('agent:other:main', 'assistant_delta', { text: 'other' }, 101);
    const second = ledger.append('agent:test:main', 'assistant_delta', { text: 'hello' }, 102);

    expect(first.cursor).toBe(1);
    expect(second.cursor).toBe(3);
    expect(ledger.replay('agent:test:main', 1).events.map((event) => event.type)).toEqual([
      'assistant_delta',
    ]);
  });

  it('bounds each session without reusing cursors', () => {
    const ledger = new ChatLedger({ maxEventsPerSession: 2 });
    ledger.append('agent:test:main', 'one', {});
    ledger.append('agent:test:main', 'two', {});
    const third = ledger.append('agent:test:main', 'three', {});

    const replay = ledger.replay('agent:test:main');
    expect(third.cursor).toBe(3);
    expect(replay.cursor).toBe(3);
    expect(replay.events.map((event) => event.type)).toEqual(['two', 'three']);
  });
});
