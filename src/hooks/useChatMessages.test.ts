import { describe, expect, it } from 'vitest';
import type { ChatMsg } from '@/features/chat/types';
import { mergeFinalMessages, mergeRealtimeProjectedMessages } from './useChatMessages';

function createMessage(overrides: Partial<ChatMsg> & Pick<ChatMsg, 'role' | 'rawText' | 'timestamp'>): ChatMsg {
  return {
    msgId: `${overrides.role}-${overrides.rawText}`,
    role: overrides.role,
    html: overrides.rawText,
    rawText: overrides.rawText,
    timestamp: overrides.timestamp,
    ...overrides,
  };
}

describe('mergeRealtimeProjectedMessages', () => {
  it('keeps the live transcript order and appends a realtime final after tool overlays', () => {
    const existingMessages: ChatMsg[] = [
      createMessage({
        role: 'user',
        rawText: 'Older archived request',
        timestamp: new Date('2026-04-28T13:37:00.000Z'),
      }),
      createMessage({
        role: 'user',
        rawText: 'Run pwd once, then reply with exactly FINAL_BUBBLE_OK.',
        timestamp: new Date('2026-04-28T16:02:00.000Z'),
      }),
      createMessage({
        role: 'tool',
        rawText: 'exec: pwd',
        timestamp: new Date('2026-04-28T16:02:30.000Z'),
      }),
    ];
    const durableMessages: ChatMsg[] = [
      createMessage({
        role: 'assistant',
        rawText: 'FINAL_BUBBLE_OK',
        timestamp: new Date('2026-04-28T16:01:00.000Z'),
      }),
    ];

    expect(mergeRealtimeProjectedMessages(existingMessages, durableMessages).map((message) => message.rawText)).toEqual([
      'Older archived request',
      'Run pwd once, then reply with exactly FINAL_BUBBLE_OK.',
      'exec: pwd',
      'FINAL_BUBBLE_OK',
    ]);
  });

  it('replaces an existing visible bubble in place when durable realtime catches up', () => {
    const existingMessages: ChatMsg[] = [
      createMessage({
        msgId: 'assistant-existing',
        role: 'assistant',
        rawText: 'FINAL_BUBBLE_OK',
        html: '<p>stale html</p>',
        timestamp: new Date('2026-04-28T16:03:00.000Z'),
      }),
    ];
    const durableMessages: ChatMsg[] = [
      createMessage({
        msgId: 'assistant-existing',
        role: 'assistant',
        rawText: 'FINAL_BUBBLE_OK',
        html: '<p>fresh html</p>',
        timestamp: new Date('2026-04-28T16:01:00.000Z'),
      }),
    ];

    expect(mergeRealtimeProjectedMessages(existingMessages, durableMessages)).toEqual([
      expect.objectContaining({
        msgId: 'assistant-existing',
        html: '<p>fresh html</p>',
      }),
    ]);
  });

  it('replaces a projected streaming assistant prefix with the committed realtime final', () => {
    const existingMessages: ChatMsg[] = [
      createMessage({
        msgId: 'user',
        role: 'user',
        rawText: 'Run pwd once, then reply exactly NERVE_TOOL_SMOKE_OK_20260428_B.',
        timestamp: new Date('2026-04-28T15:52:34.000Z'),
      }),
      createMessage({
        msgId: 'tool',
        role: 'tool',
        rawText: 'Tool exec: pwd',
        timestamp: new Date('2026-04-28T15:52:40.000Z'),
      }),
      createMessage({
        msgId: 'run-live:assistant',
        role: 'assistant',
        rawText: 'NERVE',
        timestamp: new Date('2026-04-28T15:53:00.000Z'),
        streaming: true,
      }),
    ];
    const durableMessages: ChatMsg[] = [
      createMessage({
        msgId: 'run-live:assistant-final',
        role: 'assistant',
        rawText: 'NERVE_TOOL_SMOKE_OK_20260428_B',
        timestamp: new Date('2026-04-28T15:53:05.000Z'),
      }),
    ];

    expect(mergeRealtimeProjectedMessages(existingMessages, durableMessages).map((message) => message.rawText)).toEqual([
      'Run pwd once, then reply exactly NERVE_TOOL_SMOKE_OK_20260428_B.',
      'Tool exec: pwd',
      'NERVE_TOOL_SMOKE_OK_20260428_B',
    ]);
  });

  it('drops a stale realtime streaming prefix when the final assistant answer is already visible', () => {
    const existingMessages: ChatMsg[] = [
      createMessage({
        msgId: 'user',
        role: 'user',
        rawText: 'Run pwd once, then reply exactly NERVE_DUP_FIX_SMOKE_20260430_K.',
        timestamp: new Date('2026-04-30T14:19:00.000Z'),
      }),
      createMessage({
        msgId: 'final-answer',
        role: 'assistant',
        rawText: 'NERVE_DUP_FIX_SMOKE_20260430_K',
        timestamp: new Date('2026-04-30T14:20:00.000Z'),
      }),
    ];
    const durableMessages: ChatMsg[] = [
      createMessage({
        msgId: 'streaming-prefix',
        role: 'assistant',
        rawText: 'N',
        timestamp: new Date('2026-04-30T14:20:00.000Z'),
        streaming: true,
      }),
    ];

    expect(mergeRealtimeProjectedMessages(existingMessages, durableMessages).map((message) => message.rawText)).toEqual([
      'Run pwd once, then reply exactly NERVE_DUP_FIX_SMOKE_20260430_K.',
      'NERVE_DUP_FIX_SMOKE_20260430_K',
    ]);
  });

  it('drops a realtime streaming prefix when the committed final is in the same projection batch', () => {
    const existingMessages: ChatMsg[] = [
      createMessage({
        msgId: 'user',
        role: 'user',
        rawText: 'Run pwd once, then reply exactly NERVE_DUP_FIX_SMOKE_20260430_L.',
        timestamp: new Date('2026-04-30T14:22:00.000Z'),
      }),
    ];
    const durableMessages: ChatMsg[] = [
      createMessage({
        msgId: 'final-answer',
        role: 'assistant',
        rawText: 'NERVE_DUP_FIX_SMOKE_20260430_L',
        timestamp: new Date('2026-04-30T14:23:00.000Z'),
      }),
      createMessage({
        msgId: 'streaming-prefix',
        role: 'assistant',
        rawText: 'N',
        timestamp: new Date('2026-04-30T14:23:00.000Z'),
        streaming: true,
      }),
    ];

    expect(mergeRealtimeProjectedMessages(existingMessages, durableMessages).map((message) => message.rawText)).toEqual([
      'Run pwd once, then reply exactly NERVE_DUP_FIX_SMOKE_20260430_L.',
      'NERVE_DUP_FIX_SMOKE_20260430_L',
    ]);
  });
});

describe('mergeFinalMessages', () => {
  it('replaces a projected streaming assistant prefix with the final assistant answer', () => {
    const existingMessages: ChatMsg[] = [
      createMessage({
        msgId: 'user',
        role: 'user',
        rawText: 'Run pwd once, then reply exactly NERVE_TOOL_SMOKE_OK_20260428_B.',
        timestamp: new Date('2026-04-28T15:52:34.000Z'),
      }),
      createMessage({
        msgId: 'tool',
        role: 'tool',
        rawText: 'Tool exec: pwd',
        timestamp: new Date('2026-04-28T15:52:40.000Z'),
      }),
      createMessage({
        msgId: 'run-live:assistant',
        role: 'assistant',
        rawText: 'NERVE',
        timestamp: new Date('2026-04-28T15:53:00.000Z'),
        streaming: true,
      }),
    ];
    const finalMessages: ChatMsg[] = [
      createMessage({
        msgId: 'final-assistant',
        role: 'assistant',
        rawText: 'NERVE_TOOL_SMOKE_OK_20260428_B',
        timestamp: new Date('2026-04-28T15:53:05.000Z'),
      }),
    ];

    expect(mergeFinalMessages(existingMessages, finalMessages).map((message) => message.rawText)).toEqual([
      'Run pwd once, then reply exactly NERVE_TOOL_SMOKE_OK_20260428_B.',
      'Tool exec: pwd',
      'NERVE_TOOL_SMOKE_OK_20260428_B',
    ]);
  });

  it('preserves non-streaming assistant turns that share a prefix', () => {
    const existingMessages: ChatMsg[] = [
      createMessage({
        msgId: 'assistant-short',
        role: 'assistant',
        rawText: 'Sure',
        timestamp: new Date('2026-04-28T15:53:00.000Z'),
      }),
    ];
    const finalMessages: ChatMsg[] = [
      createMessage({
        msgId: 'assistant-long',
        role: 'assistant',
        rawText: "Sure, here's the full answer.",
        timestamp: new Date('2026-04-28T15:53:05.000Z'),
      }),
    ];

    expect(mergeFinalMessages(existingMessages, finalMessages).map((message) => message.rawText)).toEqual([
      'Sure',
      "Sure, here's the full answer.",
    ]);
  });
});
