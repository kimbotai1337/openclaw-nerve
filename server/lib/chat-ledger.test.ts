import { describe, expect, it, vi } from 'vitest';
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
    expect(replay.fromCursor).toBe(2);
    expect(replay.hasGap).toBe(false);
    expect(replay.events.map((event) => event.type)).toEqual(['two', 'three']);
  });

  it('surfaces when a requested replay cursor predates the retained event window', () => {
    const ledger = new ChatLedger({ maxEventsPerSession: 2 });
    ledger.append('agent:test:main', 'one', {});
    ledger.append('agent:test:main', 'two', {});
    ledger.append('agent:test:main', 'three', {});

    const replay = ledger.replay('agent:test:main', 1);

    expect(replay.fromCursor).toBe(2);
    expect(replay.hasGap).toBe(true);
    expect(replay.events.map((event) => event.type)).toEqual(['two', 'three']);
  });

  it('preserves listeners on normal clear and removes them only for test cleanup', () => {
    const ledger = new ChatLedger();
    const listener = vi.fn();
    ledger.on('event', listener);

    ledger.append('agent:test:main', 'one', {});
    ledger.clear();
    ledger.append('agent:test:main', 'two', {});
    expect(listener).toHaveBeenCalledTimes(2);

    ledger.clearForTests();
    ledger.append('agent:test:main', 'three', {});
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
