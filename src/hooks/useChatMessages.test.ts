import { describe, expect, it } from 'vitest';
import type { ChatMsg } from '@/features/chat/types';
import { mergeRealtimeProjectedMessages } from './useChatMessages';

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
});
